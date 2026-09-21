// One Session per YouTube video: owns the shared PCM stores, capture ingestion, incremental
// decoding, the separation job, playback sync/takeover decisions, cache persistence and the
// status broadcast to the controller content script.
import { TrackBuffers, SAMPLE_RATE, BLOCK_SIZE } from './buffers.js';
import { SegmentStore, IncrementalDecoder } from './decoder.js';

const R = globalThis.VRX.ranges;
const b64 = globalThis.VRX.b64;
/**
 * Bumped whenever the decode or separation pipeline changes in a way that makes older cached
 * audio untrustworthy; entries from other versions are ignored and evicted on startup.
 *
 * v3: earlier versions filled regions the browser could not decode with silence and then stored
 * that as if it were decoded audio. A cached mixture like that is restored and trusted, so it is
 * never re-fetched, and the separation of silence is silence -- whole tracks came back mute.
 * v4: ad audio reached the mixture (a flagged append was let through when its MediaSource reported
 * the video's own length) and was cached as if it were the video's own.
 */
export const CACHE_VERSION = 'v4';
const STATE_INTERVAL_MS = 250;
const PERSIST_INTERVAL_MS = 180000; // a persist copies the whole track: for an hour of audio, well over a gigabyte
const QUALITY = {
  balanced: { overlap: 0.25, denoise: false },
  high: { overlap: 0.5, denoise: true },
};

export class Session {
  constructor(engine, { videoId, duration, title }) {
    this.engine = engine;
    this.videoId = videoId;
    this.duration = duration;
    this.title = title || '';
    this.totalSamples = Math.round(duration * SAMPLE_RATE);
    this.buffers = new TrackBuffers(this.totalSamples);
    this.store = new SegmentStore();
    this.decoder = new IncrementalDecoder(this.store, this.buffers, (p) => this.onDecodeProgress(p));
    this.settings = { enabled: true, vocalLevel: 0, semitones: 0, modelId: engine.registry.default, quality: 'high' };
    this.controller = null;
    this.capturePorts = new Map(); // port -> { id }
    this.embed = { active: false, failed: false, ended: false, reason: null };
    this.jobId = null; this.jobState = 'idle'; this.backend = null; this.speed = null; this.processedChunks = 0; this.numChunks = 0;
    this.error = null; this.fromCache = false;
    this.lastSync = null; this.takeover = false; this.volume = 1; this.muted = false;
    this.lastUsed = Date.now();
    this.dirtyMix = false; this.dirtyInst = false;
    this.stateTimer = null; this.persistTimer = null;
    this.lastPriorityBlock = null; this.lastPriorityAt = 0;
    this.output = null; this.silentSince = 0; this.silenceUntil = 0; this.silentReason = null;
    this.pushMode = false; this.blindReports = 0; this.pushedMix = null; this.pushedInst = null;
    this.cacheLoaded = null;
    this.lastJobEventAt = 0; this.lastPacePlaying = null;
    this.mainAd = false; this.switching = false;
  }

  get instKey() { return `${CACHE_VERSION}|${this.videoId}|${this.settings.modelId}|${this.settings.quality}`; }
  get mixKey() { return `${CACHE_VERSION}|${this.videoId}|mix`; }
  get complete() { return this.buffers.countReady(this.buffers.instReady) === this.buffers.numBlocks; }
  get needsProcessing() { return this.settings.enabled && !this.complete && !this.error && !this.switching; }

  send(msg) { if (this.controller) { try { this.controller.postMessage(msg); } catch (e) { /* port gone */ } } }

  forwardToCapture(msg) { for (const port of this.capturePorts.keys()) { try { port.postMessage(msg); } catch (e) { /* port gone */ } } }

  playbackParams() {
    return { vocalLevel: this.settings.vocalLevel, semitones: this.settings.semitones, gain: this.muted ? 0 : this.volume };
  }

  // ------------------------------------------------------------------ controller lifecycle
  async attachController(port, hello, playerError = null) {
    this.controller = port;
    this.lastUsed = Date.now();
    if (hello.settings) this.settings = { ...this.settings, ...hello.settings };
    if (hello.title) this.title = hello.title;
    // a fresh attach (Retry) clears an earlier processing error; a dead audio output does not go away
    this.error = playerError;
    if (!this.cacheLoaded) this.cacheLoaded = this.loadFromCache();
    await this.cacheLoaded;
    if (this.controller !== port) return;
    this.engine.setActive(this);
    const needCapture = !this.decoder.isComplete();
    this.send({ type: 'plan', needCapture });
    if (needCapture) this.decoder.pump();
    this.ensureProcessing();
    this.startTimers();
    this.broadcastState(true);
  }

  detachController(port) {
    if (port && this.controller !== port) return;
    this.controller = null;
    this.setTakeover(false);
    this.stopPlayback();
    this.stopTimers();
    this.sendPriority(false); // nobody is listening: no need to go easy on the GPU
    this.persist();
    this.engine.onSessionIdle(this);
  }

  /**
   * Freeze the playback clock. Without this the worklet keeps following the last sync it was
   * given -- playing on after the switch was turned off or the tab moved to another page, on top
   * of the page's own audio that the controller has just handed back.
   */
  stopPlayback() {
    if (!this.lastSync || !this.lastSync.playing) return;
    const stopped = { ...this.lastSync, mediaTime: this.currentPosition(), wall: performance.timeOrigin + performance.now(), playing: false };
    this.lastSync = stopped;
    if (this.engine.active === this) this.engine.player.sync(this, stopped);
  }

  attachCapture(port, hello) {
    this.capturePorts.set(port, { id: hello.source + ':' + (this.capturePorts.size + 1) + ':' + Math.random().toString(36).slice(2, 7) });
    this.embed.active = true;
    this.embed.lastProgress = Date.now();
  }

  detachCapture(port) {
    this.capturePorts.delete(port);
    if (this.capturePorts.size === 0) this.embed.active = false;
  }

  startTimers() {
    if (!this.stateTimer) this.stateTimer = setInterval(() => this.broadcastState(false), STATE_INTERVAL_MS);
    if (!this.persistTimer) this.persistTimer = setInterval(() => this.persist(), PERSIST_INTERVAL_MS);
  }
  stopTimers() {
    if (this.stateTimer) { clearInterval(this.stateTimer); this.stateTimer = null; }
    if (this.persistTimer) { clearInterval(this.persistTimer); this.persistTimer = null; }
  }

  // ------------------------------------------------------------------ messages
  onControllerMessage(m) {
    this.lastUsed = Date.now();
    switch (m.type) {
      case 'settings': this.applySettings(m.settings); break;
      case 'sync': this.onSync(m); break;
      case 'vol': this.volume = Number.isFinite(m.volume) ? m.volume : 1; this.muted = !!m.muted; this.pushParams(); break;
      case 'seg': this.ingestSegment('main:' + m.key, 'main', m); break;
      case 'sb-reset': case 'discontinuity': this.store.reset('main:' + m.key); break;
      case 'embed-started': this.embed.active = true; this.embed.failed = false; this.embed.kind = m.kind || 'iframe'; this.embed.lastProgress = Date.now(); this.broadcastState(true); break;
      case 'embed-failed': this.embed.active = false; this.embed.failed = true; this.embed.reason = m.reason || null; console.debug('[VocalRemover] background fetch unavailable:', this.embed.reason); this.broadcastState(true); break;
      case 'throttle': this.forwardToCapture({ type: 'throttle', on: !!m.on }); break;
      case 'clear-cache': this.engine.cache.clear(); break;
      case 'bye': this.detachController(this.controller); break;
      default: break;
    }
  }

  onCaptureMessage(port, m) {
    const info = this.capturePorts.get(port);
    const prefix = info ? info.id : 'embed';
    switch (m.type) {
      case 'seg': this.ingestSegment(prefix + ':' + m.key, 'embed', m); break;
      case 'sb-reset': case 'discontinuity': this.store.reset(prefix + ':' + m.key); break;
      case 'embed':
        this.embed.lastProgress = Date.now();
        if (info && (m.event === 'progress' || m.event === 'ended')) {
          if (m.ad && !info.ad) this.store.onAdStart(prefix + ':'); // the helper's own ad began
          info.ad = !!m.ad;
        }
        if (m.event === 'progress') { this.embed.progress = m; this.send({ type: 'embed-progress' }); }
        else if (m.event === 'ended') { this.embed.ended = true; this.decoder.finish(); this.send({ type: 'embed-progress' }); }
        else if (m.event === 'alive') { this.send({ type: 'embed-alive', info: (m.stage || 'page') + ' ' + (m.top ? '(top-level tab)' : '(iframe)') }); }
        else if (m.event === 'dom') { this.embed.dom = m; this.send({ type: 'embed-dom', info: { hasPlayer: m.hasPlayer, hasVideo: m.hasVideo, title: m.title, error: m.error, text: m.text, readyState: m.readyState, size: m.size } }); }
        else if (m.event === 'error') { this.send({ type: 'embed-error', message: m.message || 'helper player error' }); }
        break;
      default: break;
    }
  }

  ingestSegment(key, source, m) {
    if (this.decoder.isComplete()) return;
    let bytes;
    try { bytes = b64.decode(m.b64); } catch (e) { return; }
    const accepted = this.store.ingest({ key, source, mime: m.mime, bytes, tsOffset: m.tsOffset || 0, ad: !!m.ad, expectedDuration: this.duration, msDuration: m.msDuration });
    if (accepted) {
      this.dirtyMix = true;
      this.decoder.pump();
      if (source === 'embed' && Date.now() - (this.lastEmbedSegmentPing || 0) > 1000) { this.lastEmbedSegmentPing = Date.now(); this.send({ type: 'embed-progress' }); }
    }
  }

  onDecodeProgress(p) {
    this.dirtyMix = true;
    this.engine.separator.mixProgress(this);
    if (p.complete) {
      this.send({ type: 'capture-complete' });
      this.forwardToCapture({ type: 'done' });
      this.embed.active = false;
    }
    if (this.lastSync) this.updateTakeover();
    this.ensureProcessing();
  }

  applySettings(next) {
    const prev = this.settings;
    this.settings = { ...prev, ...next };
    if (prev.modelId !== this.settings.modelId || prev.quality !== this.settings.quality) this.switchOutput(prev);
    if (!this.settings.enabled) { this.setTakeover(false); this.stopPlayback(); this.engine.separator.cancel(this); }
    else this.ensureProcessing();
    this.pushParams();
    this.broadcastState(true);
  }

  pushParams() {
    if (this.engine.active === this) this.engine.player.setParams(this.playbackParams());
  }

  onSync(m) {
    this.lastSync = m;
    if (m.ad && !this.mainAd) this.store.onAdStart('main:'); // an ad began: take back what it may have appended unflagged
    this.mainAd = !!m.ad;
    if (!Number.isFinite(m.mediaTime)) return;
    if (m.playing && this.settings.enabled) this.engine.setActive(this);
    if (this.engine.active === this) this.engine.player.sync(this, m);
    const block = Math.floor((m.mediaTime * SAMPLE_RATE) / BLOCK_SIZE);
    const now = Date.now();
    const playing = !!m.playing && !m.ad;
    if (this.lastPriorityBlock === null || Math.abs(block - this.lastPriorityBlock) > 200 || now - this.lastPriorityAt > 2000 || playing !== this.lastPacePlaying) {
      this.lastPriorityBlock = block; this.lastPriorityAt = now;
      this.sendPriority(playing);
    }
    this.updateTakeover();
  }

  /** Where the listener is, and whether the video is playing (then the separator paces itself once it is well ahead). */
  sendPriority(playing) {
    this.lastPacePlaying = playing;
    this.engine.separator.priority(this, this.lastPriorityBlock, playing);
  }

  currentPosition() {
    const m = this.lastSync;
    if (!m) return 0;
    if (!m.playing) return m.mediaTime;
    const elapsed = (performance.timeOrigin + performance.now() - m.wall) / 1000;
    return m.mediaTime + Math.max(0, elapsed) * (m.rate || 1);
  }

  updateTakeover() {
    const m = this.lastSync;
    let want = false;
    if (Date.now() < this.silenceUntil) { this.setTakeover(false); return; }
    if (m && this.settings.enabled && !m.ad && this.engine.active === this && this.engine.player.running) {
      const s = Math.round(this.currentPosition() * SAMPLE_RATE);
      if (this.takeover) want = s >= this.totalSamples || this.buffers.isPlayable(Math.max(0, s), Math.max(0, s) + 1);
      else want = this.buffers.isPlayable(Math.max(0, s - SAMPLE_RATE * 0.2), Math.min(this.totalSamples, s + SAMPLE_RATE * 1.5));
    }
    this.setTakeover(want);
  }

  setTakeover(on) {
    if (this.takeover === on) return;
    this.takeover = on;
    this.send({ type: 'takeover', on });
  }

  onDeactivated() { this.setTakeover(false); }

  /**
   * The playback worklet reports the peak it read from the stores and the peak it actually
   * emitted, four times a second. If we have taken the page's audio over and are emitting
   * nothing, the listener is sitting in silence, which is always worse than the original: hand
   * the audio back and say which side went quiet. We retry a little later rather than giving up.
   */
  /**
   * The stores are SharedArrayBuffers, so the playback thread is supposed to see the separator's
   * writes as they happen. The level report says how many blocks that thread can actually see;
   * if it sees none of what we have, the sharing is not reaching it and the audio has to be
   * copied over instead. Costs memory, so it only ever turns on when the counts disagree.
   */
  checkBufferVisibility(info) {
    if (!info.hasBuffers) return;
    const mine = { mix: this.buffers.countReady(this.buffers.mixReady), inst: this.buffers.countReady(this.buffers.instReady) };
    if (!this.pushMode) {
      const blind = (mine.mix > 0 && info.mixSeen === 0) || (mine.inst > 0 && info.instSeen === 0);
      this.blindReports = blind ? this.blindReports + 1 : 0;
      if (this.blindReports < 4) return; // a full second of disagreement before believing it
      this.pushMode = true;
      this.pushedMix = new Uint8Array(this.buffers.numBlocks);
      this.pushedInst = new Uint8Array(this.buffers.numBlocks);
      console.warn('[VocalRemover] the playback thread cannot see the shared audio stores (it sees',
        info.mixSeen, 'mixture and', info.instSeen, 'processed blocks of', mine.mix, '/', mine.inst, '); copying to it instead');
    }
    this.pushBlocks('mix');
    this.pushBlocks('inst');
  }

  /** Send one contiguous run of ready-but-unsent blocks, nearest the listener first. */
  pushBlocks(kind) {
    const b = this.buffers, nb = b.numBlocks;
    const ready = kind === 'inst' ? b.instReady : b.mixReady;
    const pushed = kind === 'inst' ? this.pushedInst : this.pushedMix;
    const srcL = kind === 'inst' ? b.instL : b.mixL;
    const srcR = kind === 'inst' ? b.instR : b.mixR;
    const here = Math.max(0, Math.min(nb - 1, Math.floor((this.currentPosition() * SAMPLE_RATE) / BLOCK_SIZE)));
    let start = -1;
    for (let i = here; i < nb && start < 0; i++) if (ready[i] && !pushed[i]) start = i;
    for (let i = 0; i < here && start < 0; i++) if (ready[i] && !pushed[i]) start = i;
    if (start < 0) return;
    let count = 0;
    while (count < 256 && start + count < nb && ready[start + count] && !pushed[start + count]) count++;
    const at = start * BLOCK_SIZE;
    const len = Math.min(count * BLOCK_SIZE, b.totalSamples - at);
    if (len <= 0) return;
    const L = new Int16Array(len), R = new Int16Array(len);
    L.set(srcL.subarray(at, at + len)); R.set(srcR.subarray(at, at + len));
    for (let i = 0; i < count; i++) pushed[start + i] = 1;
    this.engine.player.pushBlocks({ kind, start, count }, L.buffer, R.buffer);
  }

  onLevel(info) {
    this.output = info;
    this.checkBufferVisibility(info);
    const gate = globalThis.VRX.gate;
    if (!gate.outputIsSilent(info, this.takeover)) {
      if (info.outPeak >= gate.SILENT_PEAK) this.silentReason = null;
      this.silentSince = 0;
      return;
    }
    const now = Date.now();
    if (!this.silentSince) { this.silentSince = now; return; }
    if (now - this.silentSince < 1500) return; // a real quiet passage is allowed
    this.silentSince = 0;
    this.silenceUntil = now + 10000;
    this.silentReason = gate.silenceCause(info) === 'after-mix'
      ? `output was silenced after mixing (gain ${info.gain.toFixed(2)}, envelope ${info.envelope.toFixed(2)})`
      : 'the audio decoded for this part is itself silent';
    console.warn('[VocalRemover] handing audio back to the page:', this.silentReason, info);
    this.setTakeover(false);
    this.broadcastState(true);
  }

  // ------------------------------------------------------------------ processing
  ensureProcessing() {
    if (!this.needsProcessing) { if (this.complete && this.jobState !== 'done') { this.jobState = 'done'; } return; }
    this.engine.separator.request(this);
  }

  jobParams() {
    const q = QUALITY[this.settings.quality] || QUALITY.high;
    return { modelId: this.settings.modelId, overlap: q.overlap, denoise: q.denoise, totalSamples: this.totalSamples, blockSize: BLOCK_SIZE, priorityBlock: this.lastPriorityBlock, playing: !!this.lastPacePlaying, ...this.buffers.shareable() };
  }

  onWorkerEvent(m) {
    this.lastJobEventAt = Date.now();
    switch (m.type) {
      case 'loading': this.jobState = 'loading'; break;
      case 'backend': this.backend = m.backend === 'webgpu' ? 'WebGPU' : `WebAssembly · ${m.threads} thread${m.threads === 1 ? '' : 's'}`; this.jobState = 'running'; break;
      case 'progress': this.processedChunks = m.processedChunks; this.numChunks = m.numChunks; if (m.speed) this.speed = m.speed; this.dirtyInst = true; if (this.lastSync) this.updateTakeover(); break;
      case 'waiting': this.jobState = 'waiting'; break;
      case 'done': this.jobState = 'done'; this.dirtyInst = true; this.persist(); break;
      case 'cancelled': this.jobState = 'idle'; break;
      case 'error': this.jobState = 'error'; this.error = m.message; break;
      case 'log': console.info('[VocalRemover worker]', m.message); break;
      default: break;
    }
    this.broadcastState(true);
  }

  /** Model or quality changed: park the current instrumental in the cache and start over. */
  async switchOutput(prevSettings) {
    // Keeps the scheduler off this session until the stores are consistent again: a new job that
    // started before the clear below took the old model's blocks for done, and the old job's chunk
    // still in flight landed in the cleared store as if it were the new model's.
    this.switching = true;
    try {
      await this.engine.separator.cancelAndWait(this);
      if (this.dirtyInst) await this.persistInst(`${CACHE_VERSION}|${this.videoId}|${prevSettings.modelId}|${prevSettings.quality}`);
      this.buffers.instReady.fill(0);
      this.buffers.instL.fill(0); this.buffers.instR.fill(0);
      if (this.pushedInst) this.pushedInst.fill(0);
      this.dirtyInst = false; this.jobState = 'idle'; this.processedChunks = 0; this.speed = null; this.error = null;
      await this.loadInstFromCache();
    } finally { this.switching = false; }
    this.ensureProcessing();
    this.broadcastState(true);
  }

  // ------------------------------------------------------------------ cache
  async loadFromCache() {
    const cache = this.engine.cache;
    try {
      const mix = await cache.load(this.mixKey);
      if (mix && mix.totalSamples === this.totalSamples) {
        this.buffers.mixL.set(new Int16Array(mix.mixL)); this.buffers.mixR.set(new Int16Array(mix.mixR));
        this.buffers.mixReady.set(new Uint8Array(mix.mixReady));
        const ranges = R.fromBitmap(this.buffers.mixReady, BLOCK_SIZE, 1, this.totalSamples).map(([a, b]) => [Math.round(a), Math.round(b)]);
        this.decoder.decodedSamples = R.normalize(ranges);
        if (this.decoder.isComplete()) this.decoder.captureComplete = true;
        cache.touch(this.mixKey);
      }
    } catch (e) { console.warn('[VocalRemover] mix cache load failed', e); }
    await this.loadInstFromCache();
  }

  async loadInstFromCache() {
    try {
      const inst = await this.engine.cache.load(this.instKey);
      if (inst && inst.totalSamples === this.totalSamples) {
        this.buffers.instL.set(new Int16Array(inst.instL)); this.buffers.instR.set(new Int16Array(inst.instR));
        this.buffers.instReady.set(new Uint8Array(inst.instReady));
        this.fromCache = this.complete;
        this.engine.cache.touch(this.instKey);
        if (this.engine.active === this) this.engine.player.bind(this);
      } else this.fromCache = false;
    } catch (e) { console.warn('[VocalRemover] inst cache load failed', e); }
  }

  /** One persist at a time; a request made meanwhile runs once the current one is done. */
  persist() {
    if (this.persisting) { this.persistAgain = true; return this.persisting; }
    this.persisting = this._persistNow().catch((e) => console.warn('[VocalRemover] persist failed', e)).finally(() => {
      this.persisting = null;
      if (this.persistAgain) { this.persistAgain = false; this.persist(); }
    });
    return this.persisting;
  }

  async _persistNow() {
    if (this.dirtyMix && this.buffers.countReady(this.buffers.mixReady) > 0) {
      this.dirtyMix = false;
      const snap = { mixL: this.buffers.mixL, mixR: this.buffers.mixR, mixReady: this.buffers.mixReady };
      const copy = (a) => { const o = new a.constructor(a.length); o.set(a); return o.buffer; };
      const ok = await this.engine.cache.save({ key: this.mixKey, videoId: this.videoId, kind: 'mix', title: this.title, duration: this.duration, totalSamples: this.totalSamples, sampleRate: SAMPLE_RATE, mixL: copy(snap.mixL), mixR: copy(snap.mixR), mixReady: copy(snap.mixReady), bytes: this.totalSamples * 4 + this.buffers.numBlocks });
      if (!ok) this.dirtyMix = true; // try again next time rather than forgetting the change
    }
    if (this.dirtyInst && this.buffers.countReady(this.buffers.instReady) > 0) {
      this.dirtyInst = false;
      const ok = await this.persistInst(this.instKey);
      if (!ok) this.dirtyInst = true;
    }
  }

  async persistInst(key) {
    const copy = (a) => { const o = new a.constructor(a.length); o.set(a); return o.buffer; };
    return this.engine.cache.save({ key, videoId: this.videoId, kind: 'inst', title: this.title, duration: this.duration, totalSamples: this.totalSamples, sampleRate: SAMPLE_RATE, instL: copy(this.buffers.instL), instR: copy(this.buffers.instR), instReady: copy(this.buffers.instReady), complete: this.complete, bytes: this.totalSamples * 4 + this.buffers.numBlocks });
  }

  // ------------------------------------------------------------------ status
  snapshot() {
    const captured = this.store.coverage();
    const decoded = this.decoder.decodedRanges();
    const processed = R.fromBitmap(this.buffers.instReady, BLOCK_SIZE, SAMPLE_RATE, this.totalSamples);
    const pct = (ranges) => Math.max(0, Math.min(100, Math.round((100 * R.total(ranges)) / this.duration)));
    const capturedPct = Math.max(pct(captured), pct(decoded));
    const processedPct = pct(processed);
    const active = this.engine.active === this;
    let phase, message, detail = null;
    if (this.error) { phase = 'error'; message = 'Processing failed.'; detail = this.error; }
    else if (!this.settings.enabled) { phase = 'off'; message = 'Off'; }
    else if (this.complete) {
      phase = 'ready';
      message = this.fromCache ? 'Vocals removed (restored from cache).' : 'Vocals removed for the whole video.';
    } else if (this.jobState === 'loading') { phase = 'processing'; message = 'Loading the separation model…'; }
    else if (processedPct > 0 || this.jobState === 'running') {
      phase = 'processing';
      message = `Removing vocals… ${processedPct}%` + (capturedPct < 100 ? ` · audio fetched ${capturedPct}%` : '');
    } else if (capturedPct > 0 || this.embed.active) {
      phase = capturedPct > 0 && R.total(decoded) > 0 ? 'decoding' : 'capturing';
      message = `Fetching audio… ${capturedPct}%`;
    } else { phase = 'starting'; message = 'Waiting for audio…'; }
    if (!this.error && !this.complete && this.settings.enabled) {
      if (this.silentReason) detail = `Playing the original audio: ${this.silentReason}.`;
      const streams = [...this.store.streams.values()];
      if (this.silentReason) { /* already explained above */ }
      else if (capturedPct === 0 && streams.length > 0 && !streams.some((s) => s.initBytes)) {
        detail = 'Waiting for the start of the audio stream; skip back to the beginning if this does not clear.';
      } else if (capturedPct === 0 && this.store.droppedForeign > 0) {
        detail = 'The audio arriving so far belongs to a different item (an ad, or a video of another length); waiting for this video\'s own audio.';
      } else if (this.embed.failed && !this.decoder.isComplete()) detail = 'Background fetch unavailable' + (this.embed.reason ? ' (' + this.embed.reason + ')' : '') + '; processing follows playback instead.';
      else if (this.embed.active && this.embed.kind === 'watch-tab' && !this.decoder.isComplete()) detail = 'Fetching the audio in a temporary background tab (it closes by itself).';
      else if (this.decoder.error) detail = 'Decoding hit an error and is being retried: ' + String(this.decoder.error && this.decoder.error.message || this.decoder.error);
      else if (this.jobState === 'waiting') detail = 'Waiting for more audio to be fetched…';
      else if (this.jobState === 'running' && Date.now() - this.lastJobEventAt > 20000) detail = `The separation model has not reported progress for ${Math.round((Date.now() - this.lastJobEventAt) / 1000)} s; it is restarted if this continues.`;
      else if (!active) detail = 'Another tab is using the audio engine; processing is queued.';
      else if (!this.takeover && this.lastSync && R.total(processed) > 0) detail = 'Playing the original audio until the processed part is reached.';
    }
    return { phase, message, detail, backend: this.backend, speed: this.speed, duration: this.duration, captured, decoded, processed, fromCache: this.fromCache, capturedPct, processedPct };
  }

  broadcastState(force) {
    if (!this.controller) return;
    const now = Date.now();
    if (!force && now - (this.lastStateSent || 0) < STATE_INTERVAL_MS - 20) return;
    this.lastStateSent = now;
    this.send({ type: 'state', state: this.snapshot() });
  }
}
