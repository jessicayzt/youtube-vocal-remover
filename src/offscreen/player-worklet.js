// AudioWorkletProcessor that plays the shared PCM stores in sync with the YouTube video.
//  - Mixes mixture and instrumental per sample: out = mix - (1 - vocalLevel) * w * (mix - inst),
//    where w fades in/out over one block at the edges of processed regions.
//  - Follows a timeline mapping (media time <-> AudioContext time) sent by the main thread;
//    small timing jitter is ignored, larger discrepancies snap with a short crossfade.
//  - Pitch shift / speed change go through the Signalsmith Stretch WASM engine using the same
//    "constantly seeking" scheme as the library's own worklet. When no shift is needed and the
//    rate is 1 the samples are passed through untouched (bit-exact path).
import { StretchModuleFactory } from '../../vendor/signalsmith/SignalsmithStretch.mjs';

const SNAP_THRESHOLD = 0.03;   // seconds of timing error that triggers a resync
const FADE_SAMPLES = 220;      // ~5 ms envelope for start/stop
const XFADE_SAMPLES = 1024;    // bypass <-> stretch crossfade

class VrxPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffers = null;
    this.timeline = { media: 0, ctx: 0, rate: 1, playing: false };
    this.params = { vocalLevel: 0, semitones: 0, gain: 1 };
    this.gainSmooth = 1;
    this.envelope = 0;
    this.stretchMix = 0; // 0 = bypass, 1 = stretch
    this.snapFrom = null; // previous timeline for crossfade
    this.snapProgress = 0;
    this.wasm = null;
    this.wasmReady = false;
    // Peak of the audio read from the stores vs. peak of what actually leaves the node. The two
    // disagreeing is the signature of the output being silenced somewhere after the mix.
    this.srcPeak = 0; this.outPeak = 0; this.levelFrames = 0;
    this.local = null;
    this.tmpL = new Float32Array(128); this.tmpR = new Float32Array(128);
    this.tmp2L = new Float32Array(128); this.tmp2R = new Float32Array(128);
    this.port.onmessage = (e) => this.onMessage(e.data);
    StretchModuleFactory().then((wasm) => {
      this.wasm = wasm;
      wasm._main();
      wasm._presetDefault(2, sampleRate);
      this.inLat = wasm._inputLatency();
      this.outLat = wasm._outputLatency();
      this.histLen = this.inLat + this.outLat;
      const ptr = wasm._setBuffers(2, this.histLen);
      const bytes = this.histLen * 4;
      this.bufIn = [ptr, ptr + bytes];
      this.bufOut = [ptr + bytes * 2, ptr + bytes * 3];
      this.histL = new Float32Array(this.histLen); this.histR = new Float32Array(this.histLen);
      this.wasmReady = true;
      this.port.postMessage({ type: 'ready', inputLatency: this.inLat / sampleRate, outputLatency: this.outLat / sampleRate });
    }).catch((e) => this.port.postMessage({ type: 'error', message: 'stretch engine failed: ' + e }));
  }

  onMessage(m) {
    switch (m.type) {
      case 'blocks': {
        // The engine pushes PCM here when it detects that our view of the shared stores is not
        // actually shared (see the counts in the level report). Whatever arrives this way wins.
        const loc = this.ensureLocal();
        if (!loc) break;
        const at = m.start * this.buffers.blockSize;
        const L = new Int16Array(m.a), R = new Int16Array(m.b);
        if (m.kind === 'inst') { loc.instL.set(L, at); loc.instR.set(R, at); loc.instReady.fill(1, m.start, m.start + m.count); }
        else { loc.mixL.set(L, at); loc.mixR.set(R, at); loc.mixReady.fill(1, m.start, m.start + m.count); }
        break;
      }
      case 'buffers': {
        this.local = null;
        // a new track starts stopped; its own sync follows. The previous track's clock must not
        // play the new stores from wherever it happened to be.
        this.timeline.playing = false;
        if (!m.mixL) { this.buffers = null; break; }
        this.buffers = {
          total: m.totalSamples, blockSize: m.blockSize, numBlocks: Math.ceil(m.totalSamples / m.blockSize), inv: 1 / m.scale,
          mixL: new Int16Array(m.mixL), mixR: new Int16Array(m.mixR), instL: new Int16Array(m.instL), instR: new Int16Array(m.instR),
          mixReady: new Uint8Array(m.mixReady), instReady: new Uint8Array(m.instReady),
        };
        break;
      }
      case 'sync': this.applySync(m); break;
      case 'params': Object.assign(this.params, m.params); break;
      case 'clear': this.buffers = null; this.timeline.playing = false; break;
      default: break;
    }
  }

  ensureLocal() {
    if (this.local || !this.buffers) return this.local;
    const total = this.buffers.total, nb = this.buffers.numBlocks;
    this.local = {
      mixL: new Int16Array(total), mixR: new Int16Array(total),
      instL: new Int16Array(total), instR: new Int16Array(total),
      mixReady: new Uint8Array(nb), instReady: new Uint8Array(nb),
    };
    return this.local;
  }

  mediaAt(tl, ctxTime) { return tl.media + (ctxTime - tl.ctx) * tl.rate; }

  applySync(m) {
    const next = { media: m.mediaTime, ctx: m.ctxTime, rate: m.rate || 1, playing: !!m.playing };
    const cur = this.timeline;
    if (cur.playing && next.playing && Math.abs(next.rate - cur.rate) < 1e-9) {
      const predicted = this.mediaAt(cur, next.ctx);
      const diff = next.media - predicted;
      if (Math.abs(diff) < SNAP_THRESHOLD) return; // jitter: keep the current mapping
      this.snapFrom = { ...cur }; this.snapProgress = 0;
    } else if (cur.playing && !next.playing) {
      // pausing: freeze the position where the video says it is
    }
    this.timeline = next;
  }

  // Read the mixed signal for absolute sample positions [start, start+n) into outL/outR.
  // A block is audible when either store holds it: the instrumental alone is enough (that is what
  // a cached result is), the mixture alone is the untouched audio, and with both we blend them.
  readMixed(start, n, outL, outR) {
    const b = this.buffers;
    if (!b) { outL.fill(0); outR.fill(0); return; }
    const vocal = this.params.vocalLevel;
    const inv = b.inv, bs = b.blockSize, nb = b.numBlocks, total = b.total;
    const mixReady = b.mixReady, instReady = b.instReady;
    const loc = this.local;
    for (let i = 0; i < n; i++) {
      const x = start + i;
      if (x < 0 || x >= total) { outL[i] = 0; outR[i] = 0; continue; }
      const blk = (x / bs) | 0;
      const locInst = loc && loc.instReady[blk] === 1;
      const locMix = loc && loc.mixReady[blk] === 1;
      const hasInst = locInst || instReady[blk] === 1;
      const hasMix = locMix || mixReady[blk] === 1;
      if (!hasInst) {
        // nothing processed here: the untouched mixture, or nothing at all
        if (!hasMix) { outL[i] = 0; outR[i] = 0; continue; }
        outL[i] = (locMix ? loc.mixL[x] : b.mixL[x]) * inv; outR[i] = (locMix ? loc.mixR[x] : b.mixR[x]) * inv;
        continue;
      }
      const il = (locInst ? loc.instL[x] : b.instL[x]) * inv, ir = (locInst ? loc.instR[x] : b.instR[x]) * inv;
      if (!hasMix) { outL[i] = il; outR[i] = ir; continue; } // instrumental on its own
      const ml = (locMix ? loc.mixL[x] : b.mixL[x]) * inv, mr = (locMix ? loc.mixR[x] : b.mixR[x]) * inv;
      // fade the processed signal in and out across a block at the edges of a processed region
      let w = 1;
      const off = x - blk * bs;
      if (blk > 0 && !(instReady[blk - 1] === 1 || (loc && loc.instReady[blk - 1] === 1))) w = Math.min(w, (off + 1) / bs);
      if (blk + 1 < nb && !(instReady[blk + 1] === 1 || (loc && loc.instReady[blk + 1] === 1))) w = Math.min(w, (bs - off) / bs);
      const k = (1 - vocal) * w;
      outL[i] = ml - k * (ml - il);
      outR[i] = mr - k * (mr - ir);
    }
  }

  renderBypass(tl, blockStartCtx, outL, outR) {
    const start = Math.round(this.mediaAt(tl, blockStartCtx) * sampleRate);
    this.readMixed(start, outL.length, outL, outR);
  }

  renderStretch(tl, blockStartCtx, outL, outR) {
    const wasm = this.wasm;
    const outputTime = blockStartCtx + this.outLat / sampleRate;
    const inputTime = this.mediaAt(tl, outputTime) + this.inLat / sampleRate;
    const end = Math.round(inputTime * sampleRate);
    this.readMixed(end - this.histLen, this.histLen, this.histL, this.histR);
    const heap = () => (wasm.exports ? wasm.exports.memory.buffer : wasm.HEAP8.buffer);
    const mem = heap();
    new Float32Array(mem, this.bufIn[0], this.histLen).set(this.histL);
    new Float32Array(mem, this.bufIn[1], this.histLen).set(this.histR);
    wasm._setTransposeSemitones(this.params.semitones, 8000 / sampleRate);
    wasm._setFormantSemitones(0, false);
    wasm._setFormantBase(0);
    wasm._seek(this.histLen, tl.rate);
    wasm._process(0, outL.length);
    const mem2 = heap(); // re-fetch in case memory grew
    outL.set(new Float32Array(mem2, this.bufOut[0], outL.length));
    outR.set(new Float32Array(mem2, this.bufOut[1], outR.length));
  }

  /**
   * Nothing thrown here may escape: an exception out of process() makes the browser drop this
   * processor for good, which silences the extension until the whole audio graph is rebuilt.
   */
  process(inputs, outputs) {
    try {
      return this.render(outputs);
    } catch (e) {
      if (!this.reportedError) {
        this.reportedError = true;
        this.port.postMessage({ type: 'runtime-error', message: String((e && e.message) || e) });
      }
      const out = outputs[0];
      if (out) for (const ch of out) ch.fill(0);
      this.envelope = 0;
      return true; // stay alive
    }
  }

  render(outputs) {
    const out = outputs[0];
    if (!out || out.length < 1) return true;
    const L = out[0], R = out.length > 1 ? out[1] : out[0];
    const n = L.length;
    const tl = this.timeline;
    const active = !!this.buffers && tl.playing;
    // envelope for start/stop
    const envTarget = active ? 1 : 0;
    if (!active && this.envelope <= 0) { L.fill(0); R.fill(0); return true; }
    if (!this.buffers) {
      // the stores were taken away mid-fade: ride the envelope down in silence rather than
      // reading from nothing
      for (let i = 0; i < n; i++) {
        if (this.envelope > 0) { this.envelope -= 1 / FADE_SAMPLES; if (this.envelope < 0) this.envelope = 0; }
        L[i] = 0; R[i] = 0;
      }
      return true;
    }
    const blockStartCtx = currentTime;
    const wantStretch = this.wasmReady && (this.params.semitones !== 0 || Math.abs(tl.rate - 1) > 1e-6);
    const mixTarget = wantStretch ? 1 : 0;
    const needBypass = this.stretchMix < 1 || mixTarget === 0;
    const needStretch = this.wasmReady && (this.stretchMix > 0 || mixTarget === 1);
    const bL = this.tmpL, bR = this.tmpR, sL = this.tmp2L, sR = this.tmp2R;
    if (needBypass) {
      this.renderBypass(tl, blockStartCtx, bL, bR);
      if (this.snapFrom) {
        // crossfade from the previous mapping to hide a resync jump
        const oL = new Float32Array(n), oR = new Float32Array(n);
        this.renderBypass(this.snapFrom, blockStartCtx, oL, oR);
        for (let i = 0; i < n; i++) { const t = (i + 1) / n; bL[i] = oL[i] * (1 - t) + bL[i] * t; bR[i] = oR[i] * (1 - t) + bR[i] * t; }
        this.snapFrom = null;
      }
    } else this.snapFrom = null;
    if (needStretch) this.renderStretch(tl, blockStartCtx, sL, sR);
    const gainTarget = this.params.gain;
    for (let i = 0; i < n; i++) {
      // stretch/bypass crossfade
      if (this.stretchMix !== mixTarget) {
        this.stretchMix += (mixTarget ? 1 : -1) / XFADE_SAMPLES;
        if (this.stretchMix < 0) this.stretchMix = 0; else if (this.stretchMix > 1) this.stretchMix = 1;
      }
      const m = this.stretchMix;
      let l = needStretch && needBypass ? bL[i] * (1 - m) + sL[i] * m : (needStretch ? sL[i] : bL[i]);
      let r = needStretch && needBypass ? bR[i] * (1 - m) + sR[i] * m : (needStretch ? sR[i] : bR[i]);
      // envelope + volume
      if (this.envelope !== envTarget) {
        this.envelope += (envTarget ? 1 : -1) / FADE_SAMPLES;
        if (this.envelope < 0) this.envelope = 0; else if (this.envelope > 1) this.envelope = 1;
      }
      this.gainSmooth += (gainTarget - this.gainSmooth) * 0.002;
      const g = this.envelope * this.gainSmooth;
      L[i] = l * g; R[i] = r * g;
      const sa = l < 0 ? -l : l; if (sa > this.srcPeak) this.srcPeak = sa;
      const oa = L[i] < 0 ? -L[i] : L[i]; if (oa > this.outPeak) this.outPeak = oa;
    }
    this.levelFrames += n;
    if (this.levelFrames >= sampleRate * 0.25) {
      let mixSeen = 0, instSeen = 0;
      if (this.buffers) {
        const mr = this.buffers.mixReady, ir = this.buffers.instReady, loc = this.local;
        for (let k = 0; k < mr.length; k++) {
          if (mr[k] || (loc && loc.mixReady[k])) mixSeen++;
          if (ir[k] || (loc && loc.instReady[k])) instSeen++;
        }
      }
      this.port.postMessage({
        type: 'level', srcPeak: this.srcPeak, outPeak: this.outPeak,
        hasBuffers: !!this.buffers, playing: tl.playing, gain: this.params.gain,
        envelope: this.envelope, mediaTime: this.mediaAt(tl, blockStartCtx),
        // how many blocks this thread can actually see, which is how the engine detects that
        // the "shared" stores are not reaching it
        mixSeen, instSeen, pushed: !!this.local, vocalLevel: this.params.vocalLevel,
      });
      this.srcPeak = 0; this.outPeak = 0; this.levelFrames = 0;
    }
    return true;
  }
}

registerProcessor('vrx-player', VrxPlayerProcessor);
