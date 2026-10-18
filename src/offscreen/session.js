// One Session per YouTube video: owns the shared PCM stores, capture ingestion, incremental
// decoding, the separation job, playback sync/takeover decisions, cache persistence and the
// status broadcast to the controller content script.
import { TrackBuffers, SAMPLE_RATE, BLOCK_SIZE, INT16_SCALE } from './buffers.js';
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
 * v5: the first release replayed the previous playlist video's stream start into the next video,
 * so a cached track may begin with another video's audio ("stale audio leaking through").
 * v6: instrumentals were saved with the ready bitmap copied after the samples, so blocks finished
 * during the copy were saved ready and empty; and a backend failing without an error had its
 * empty or recycled output stored as finished. Either plays as silence under a green bar.
 */
export const CACHE_VERSION = 'v6';
const STATE_INTERVAL_MS = 250;
const PERSIST_INTERVAL_MS = 180000; // a persist copies the whole track: for an hour of audio, well over a gigabyte
const QUALITY = {
  balanced: { overlap: 0.25, denoise: false },
  high: { overlap: 0.5, denoise: true },
};

/** Resolves with the promise's value, or undefined after `ms`; the timer never outlives the wait. */
function withTimeout(promise, ms) {
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, ms); if (timer && typeof timer.unref === 'function') timer.unref(); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const OUTPUT_STALL_MS = 1500;          // playing, holding the page audio, no report from the playback thread for this long: it is not rendering
const CLOCK_TOLERANCE_S = 1.5;         // the playback thread reads ahead of the video by its output latency, never by this much
const FAILED_MIN_AUDIBLE_BLOCKS = 22;  // about 0.5 s of exactly-zero instrumental under an audible mixture
const FAILED_MIN_BLIND_BLOCKS = 130;   // about 3 s of exactly-zero instrumental with no mixture to compare it with
const AUDIBLE_MIX_PEAK = 22;           // about -60 dBFS in the Int16 stores
const BLOB_SLICE = 1 << 20;            // samples copied at a time when a store is saved

/** A copy of a ready bitmap read with atomic loads: every block it shows ready has its samples in place. */
function snapshotBitmap(bitmap) {
  const out = new Uint8Array(bitmap.length);
  for (let i = 0; i < bitmap.length; i++) out[i] = Atomics.load(bitmap, i);
  return out;
}

/**
 * A store as a Blob, copied a slice at a time. A whole-track copy doubled the engine's memory for
 * the length of a save -- for an hour of audio, over a gigabyte -- which on a machine short of
 * memory is what gets the engine's process killed.
 */
function blobOf(view) {
  const parts = [];
  for (let o = 0; o < view.length; o += BLOB_SLICE) parts.push(new Blob([view.slice(o, Math.min(view.length, o + BLOB_SLICE))]));
  return new Blob(parts);
}

function blockPeak(L, R, blk, total) {
  const s = blk * BLOCK_SIZE, e = Math.min(total, s + BLOCK_SIZE);
  let p = 0;
  for (let x = s; x < e; x++) { const l = L[x] < 0 ? -L[x] : L[x], r = R[x] < 0 ? -R[x] : R[x]; if (l > p) p = l; if (r > p) p = r; }
  return p;
}

function blockIsZero(L, R, blk, total) {
  const s = blk * BLOCK_SIZE, e = Math.min(total, s + BLOCK_SIZE);
  for (let x = s; x < e; x++) if (L[x] !== 0 || R[x] !== 0) return false;
  return true;
}

function describeHelper(kind) {
  return kind === 'embed-nocookie' ? 'cookieless embed' : kind === 'embed-iframe' ? 'embed' : kind === 'watch-iframe' ? 'hidden watch page' : kind === 'watch-tab' ? 'background tab' : 'helper player';
}

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
    this.takeoverSince = 0; this.playingSince = 0; this.stallSeenAt = 0; this.clockMisses = 0; this.reprocessCount = 0;
    this.outputFor = null; // { modelId, quality } of the instrumental in the stores, once known
  }

  get instKey() { return `${CACHE_VERSION}|${this.videoId}|${this.settings.modelId}|${this.settings.quality}`; }
  get mixKey() { return `${CACHE_VERSION}|${this.videoId}|mix`; }
  /** The cache key of what the instrumental stores actually hold (they lag the settings during a switch). */
  get outputKey() { const o = this.outputFor || this.settings; return `${CACHE_VERSION}|${this.videoId}|${o.modelId}|${o.quality}`; }
  get complete() { return this.buffers.countReady(this.buffers.instReady) === this.buffers.numBlocks; }
  get needsProcessing() { return this.settings.enabled && !this.complete && !this.error && !this.switching; }

  send(msg) { if (this.controller) { try { this.controller.postMessage(msg); } catch (e) { /* port gone */ } } }

  forwardToCapture(msg) { for (const port of this.capturePorts.keys()) { try { port.postMessage(msg); } catch (e) { /* port gone */ } } }

  /**
   * What the worklet plays with. The gain is zero whenever this session does not hold the page's
   * audio: the page is then audible on its own, and anything we emitted on top of it (an ad
   * break, a silence hand-back, the moment the player moves to another element) was two copies
   * of the same audio a few milliseconds apart, which the ear hears as detuned.
   */
  playbackParams() {
    return { vocalLevel: this.settings.vocalLevel, semitones: this.settings.semitones, gain: this.muted || !this.takeover ? 0 : this.volume };
  }

  // ------------------------------------------------------------------ controller lifecycle
  async attachController(port, hello, playerError = null) {
    this.controller = port;
    this.lastUsed = Date.now();
    const prevSettings = this.settings;
    if (hello.settings) this.settings = { ...this.settings, ...hello.settings };
    if (hello.title) this.title = hello.title;
    this.error = null; // a fresh attach (Retry) clears an earlier processing error
    // Audio output that would not start no longer stops processing: separating needs no speakers,
    // and the output is retried while the video plays. Until then the original plays, and the
    // panel says why.
    this.outputError = playerError;
    if (!this.cacheLoaded) this.cacheLoaded = this.loadFromCache();
    // a cache that does not answer must not hold the session hostage: go ahead without it
    await withTimeout(this.cacheLoaded, 20000);
    if (this.controller !== port) return;
    // The settings the page brings are a settings change like any other. This session may have
    // lived on in the engine since its last controller (the engine keeps a few), with the transpose
    // or model changed from elsewhere meanwhile: merged silently, the worklet kept transposing by
    // the old amount while the panel said 0, and a changed model would have had the old model's
    // output saved under its name.
    this.settingsChanged(prevSettings);
    // whatever goes wrong below, the controller must hear 'plan' (it holds captured audio until it
    // does) and the status timer must run (or the panel stays on "Starting…" with no way to tell)
    try { this.engine.setActive(this); } catch (e) { console.error('[VocalRemover] could not activate the session', e); }
    const needCapture = !this.decoder.isComplete();
    this.send({ type: 'plan', needCapture });
    try {
      if (needCapture) this.decoder.pump();
      this.ensureProcessing();
    } catch (e) { console.error('[VocalRemover] could not start decoding or processing', e); }
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
    const stopped = { ...this.lastSync, mediaTime: this.currentPosition(), wall: Date.now(), playing: false };
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
    const unref = (t) => { if (t && typeof t.unref === 'function') t.unref(); return t; }; // Node (tests): never keep the process alive
    if (!this.stateTimer) this.stateTimer = unref(setInterval(() => this.broadcastState(false), STATE_INTERVAL_MS));
    if (!this.persistTimer) this.persistTimer = unref(setInterval(() => this.persist(), PERSIST_INTERVAL_MS));
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
        // a running player is not progress; captured audio is (ingestSegment reports that). An ad
        // running its course counts too, so the wait for it is not mistaken for a stall.
        if (m.event === 'progress') { this.embed.progress = m; this.send({ type: m.ad ? 'embed-progress' : 'embed-keepalive' }); }
        else if (m.event === 'ended') { this.embed.ended = true; this.decoder.finish(); this.send({ type: 'embed-ended' }); }
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
    this.settingsChanged(prev);
    this.broadcastState(true);
  }

  /** Everything that has to follow a change of this.settings from `prev`. */
  settingsChanged() {
    // Compared with what the stores hold, not with the previous settings: on a session's first
    // attach the previous settings are the engine's built-in defaults, and a page using another
    // model or quality had the instrumental it had just loaded from the cache wiped and loaded
    // again -- and anything unsaved filed under the default model's name.
    const out = this.outputFor;
    if (out && !this.switching && (out.modelId !== this.settings.modelId || out.quality !== this.settings.quality)) this.switchOutput(out);
    if (!this.settings.enabled) { this.setTakeover(false); this.stopPlayback(); this.engine.separator.cancel(this); }
    else this.ensureProcessing();
    this.pushParams();
  }

  pushParams() {
    if (this.engine.active === this) this.engine.player.setParams(this.playbackParams());
  }

  onSync(m) {
    const prev = this.lastSync;
    this.lastSync = m;
    if (m.playing && !(prev && prev.playing)) this.playingSince = Date.now();
    if (m.ad && !this.mainAd) this.store.onAdStart('main:'); // an ad began: take back what it may have appended unflagged
    this.mainAd = !!m.ad;
    if (!Number.isFinite(m.mediaTime)) return;
    if (m.playing && this.settings.enabled) {
      this.engine.setActive(this);
      // a context Chrome suspended (output device change, idle policy) comes back on resume()
      if (!this.engine.player.running) this.engine.player.ensureRunning();
    }
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
    const elapsed = (Date.now() - m.wall) / 1000; // Date.now(): see heardCtxTime in player.js
    return m.mediaTime + Math.max(0, elapsed) * (m.rate || 1);
  }

  updateTakeover() {
    const m = this.lastSync;
    let want = false;
    const now = Date.now();
    if (now < this.silenceUntil) { this.setTakeover(false); return; }
    if (this.takeover && this.outputStalled(now)) {
      this.stallSeenAt = 0;
      const dead = !this.engine.player.rendering;
      this.handBack(now, dead ? 'the audio output stopped; it is being restarted' : 'the playback thread stopped playing; it has been given the audio again', null);
      if (dead) this.engine.player.restart('the render thread stopped');
      else { this.engine.player.rebind(this); this.resync(); }
      return;
    }
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
    if (on) this.takeoverSince = Date.now();
    this.stallSeenAt = 0;
    this.send({ type: 'takeover', on });
    this.pushParams(); // the worklet is audible only while we hold the page's audio
  }

  onDeactivated() { this.setTakeover(false); }

  /** The playback thread was rebuilt or given the stores again: whatever was copied to it is gone. */
  onPlayerRestart() {
    if (this.pushedMix) this.pushedMix.fill(0);
    if (this.pushedInst) this.pushedInst.fill(0);
    this.blindReports = 0; this.clockMisses = 0;
    this.setTakeover(false);
  }

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
    this.stallSeenAt = 0;
    this.checkBufferVisibility(info);
    this.checkClock(info);
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
    if (gate.silenceCause(info) === 'after-mix') {
      this.handBack(now, `output was silenced after mixing (gain ${info.gain.toFixed(2)}, envelope ${info.envelope.toFixed(2)})`, info);
      return;
    }
    // The playback thread read silence. First: did it read where the video is? A thread reading
    // somewhere else sits in silence while the stores at the video's position look fine, which
    // was taken for a quiet instrumental and left alone.
    const pos = this.currentPosition();
    const at = Number.isFinite(info.mediaTime) ? info.mediaTime : pos;
    if (Math.abs(at - pos) > CLOCK_TOLERANCE_S) {
      this.resync();
      this.handBack(now, `the playback clock was ${Math.abs(at - pos).toFixed(1)} s off the video; it has been re-synchronised`, info);
      return;
    }
    // Then: what do the stores hold over the stretch that was silent?
    const stats = this.storeStats(at - 1.5, at + 0.2);
    const kind = gate.storeSilence(stats);
    if (kind === 'inst-quiet') { this.silentReason = null; return; } // vocals alone here: silence is the karaoke-correct output
    if (kind === 'inst-zero') {
      // an empty instrumental stored as finished (a failed inference, or a cache saved mid-write):
      // the original plays meanwhile, and every such stretch of the track is processed again
      this.repairInstrumental('the processed audio was empty', stats.blocks);
      this.handBack(now, 'the processed audio for this part was empty; it is being processed again', info);
      return;
    }
    this.handBack(now, 'the audio decoded for this part is itself silent', info);
  }

  /** The playback thread reports where it reads; persistently off the video, it is put back. */
  checkClock(info) {
    const m = this.lastSync;
    if (!m || !m.playing || m.ad || !info.playing || !Number.isFinite(info.mediaTime)) { this.clockMisses = 0; return; }
    const off = info.mediaTime - this.currentPosition();
    if (Math.abs(off) <= CLOCK_TOLERANCE_S) { this.clockMisses = 0; return; }
    if (++this.clockMisses < 2) return;
    this.clockMisses = 0;
    console.warn('[VocalRemover] the playback thread was', off.toFixed(2), 's off the video; re-synchronising');
    this.resync();
  }

  resync() {
    const m = this.lastSync;
    if (!m || this.engine.active !== this) return;
    this.engine.player.sync(this, { ...m, mediaTime: this.currentPosition(), wall: Date.now() });
  }

  handBack(now, reason, info) {
    this.silenceUntil = now + 10000;
    this.silentReason = reason;
    console.warn('[VocalRemover] handing audio back to the page:', reason, info || '');
    this.setTakeover(false);
    this.broadcastState(true);
  }

  /**
   * Holding the page's audio while the playback thread renders nothing is silence the level
   * reports cannot reveal: they come from that very thread. Confirmed by two checks half a second
   * apart, so a main thread that was merely busy (its reports then arrive late, all at once) is
   * not mistaken for it.
   */
  outputStalled(now) {
    const m = this.lastSync, p = this.engine.player;
    const quietFor = now - Math.max(this.takeoverSince || 0, this.playingSince || 0, p.lastLevelAt || 0);
    if (!m || !m.playing || m.ad || p.bound !== this || !p.running || quietFor <= OUTPUT_STALL_MS) { this.stallSeenAt = 0; return false; }
    if (!this.stallSeenAt) { this.stallSeenAt = now; return false; }
    return now - this.stallSeenAt >= 500;
  }

  /** What the stores hold over [fromSec, toSec], counted over the processed (green) blocks only. */
  storeStats(fromSec, toSec) {
    const b = this.buffers;
    const b0 = Math.max(0, Math.floor((fromSec * SAMPLE_RATE) / BLOCK_SIZE));
    const b1 = Math.max(b0, Math.min(b.numBlocks - 1, Math.floor((toSec * SAMPLE_RATE) / BLOCK_SIZE)));
    let mixPeak = 0, instPeak = 0, green = 0, zeroSuspect = 0;
    for (let blk = b0; blk <= b1; blk++) {
      if (!b.instReady[blk]) continue;
      green++;
      const mp = b.mixReady[blk] ? blockPeak(b.mixL, b.mixR, blk, b.totalSamples) : 0;
      const ip = blockPeak(b.instL, b.instR, blk, b.totalSamples);
      if (mp > mixPeak) mixPeak = mp;
      if (ip > instPeak) instPeak = ip;
      // exactly nothing where the mixture is audible, or where there is no mixture to tell
      if (ip === 0 && (!b.mixReady[blk] || mp >= AUDIBLE_MIX_PEAK)) zeroSuspect++;
    }
    return { mixPeak: mixPeak / INT16_SCALE, instPeak: instPeak / INT16_SCALE, green, zeroSuspect, blocks: [b0, b1] };
  }

  /**
   * Green blocks whose instrumental is exactly nothing where it cannot be: under an audible
   * mixture for half a second or more, or for three seconds with no mixture to compare. That is
   * what a failed inference stored as finished looks like, and a cache saved mid-write.
   */
  findFailedRuns() {
    const b = this.buffers, nb = b.numBlocks, runs = [];
    let start = -1, heard = 0;
    const close = (end) => {
      if (start >= 0 && (heard >= FAILED_MIN_AUDIBLE_BLOCKS || end - start + 1 >= FAILED_MIN_BLIND_BLOCKS)) runs.push([start, end]);
      start = -1; heard = 0;
    };
    for (let blk = 0; blk < nb; blk++) {
      let suspect = false, audible = false;
      if (b.instReady[blk] === 1 && blockIsZero(b.instL, b.instR, blk, b.totalSamples)) {
        if (!b.mixReady[blk]) suspect = true;
        else if (blockPeak(b.mixL, b.mixR, blk, b.totalSamples) >= AUDIBLE_MIX_PEAK) { suspect = true; audible = true; }
      }
      if (!suspect) { close(blk - 1); continue; }
      if (start < 0) start = blk;
      if (audible) heard++;
    }
    close(nb - 1);
    return runs;
  }

  /** Un-green these block runs: they are processed again (and fetched again where no mixture is held). */
  clearInstrumental(runs) {
    const b = this.buffers;
    let n = 0;
    for (const [b0, b1] of runs) {
      for (let blk = b0; blk <= b1; blk++) {
        if (Atomics.load(b.instReady, blk)) { Atomics.store(b.instReady, blk, 0); n++; }
        if (this.pushedInst) this.pushedInst[blk] = 0;
      }
      if (this.pushMode) this.engine.player.dropBlocks({ kind: 'inst', start: b0, count: b1 - b0 + 1 });
    }
    if (n) { this.dirtyInst = true; this.fromCache = false; }
    return n;
  }

  /**
   * Every stretch of empty instrumental in the track is processed again, not only the moment just
   * heard: a failing backend leaves whole runs of them, and redoing a second and a half at a time
   * left the rest playing silence, then the original, for minutes.
   */
  repairInstrumental(reason, window) {
    const now = Date.now();
    if (now - (this.lastReprocessAt || 0) < 5000) return 0;
    this.lastReprocessAt = now;
    let runs = this.findFailedRuns();
    if (!runs.length && window) runs = [window]; // too short to show up as a run: at least what was just heard
    const n = this.clearInstrumental(runs);
    if (!n) return 0;
    this.reprocessCount = (this.reprocessCount || 0) + 1;
    console.warn('[VocalRemover] processing', n, 'blocks again:', reason);
    // twice is a pattern: the backend is not to be trusted on this machine
    if (this.reprocessCount >= 2) this.engine.separator.suspectBackend(reason);
    this.engine.separator.reprocess(this);
    this.broadcastState(true);
    return n;
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
      if (this.pushMode) this.engine.player.dropBlocks({ kind: 'inst', start: 0, count: this.buffers.numBlocks }); // the old model's copies too
      this.dirtyInst = false; this.jobState = 'idle'; this.processedChunks = 0; this.speed = null; this.error = null;
      await this.loadInstFromCache();
    } finally { this.switching = false; }
    // the settings moved on again while this switch ran: follow them
    const out = this.outputFor;
    if (out && (out.modelId !== this.settings.modelId || out.quality !== this.settings.quality)) return this.switchOutput(out);
    this.ensureProcessing();
    this.broadcastState(true);
  }

  // ------------------------------------------------------------------ cache
  async loadFromCache() {
    const cache = this.engine.cache;
    try {
      const mix = await cache.load(this.mixKey);
      // a load that arrives late (the attach went ahead without it) must not overwrite what the
      // decoder has produced in the meantime
      if (mix && mix.totalSamples === this.totalSamples && this.decoder.decodedSamples.length === 0) {
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
    const want = { modelId: this.settings.modelId, quality: this.settings.quality };
    const key = this.instKey;
    try {
      const inst = await this.engine.cache.load(key);
      if (inst && inst.totalSamples === this.totalSamples) {
        // Merged block by block into what is not ready yet: a load that arrives late (the attach
        // went ahead without waiting for it) must not overwrite what a job has produced meanwhile.
        const b = this.buffers, L = new Int16Array(inst.instL), Rr = new Int16Array(inst.instR), ready = new Uint8Array(inst.instReady);
        for (let blk = 0; blk < b.numBlocks; blk++) {
          if (!ready[blk] || Atomics.load(b.instReady, blk)) continue;
          const s0 = blk * BLOCK_SIZE, e0 = Math.min(b.totalSamples, s0 + BLOCK_SIZE);
          b.instL.set(L.subarray(s0, e0), s0); b.instR.set(Rr.subarray(s0, e0), s0);
          Atomics.store(b.instReady, blk, 1);
        }
        // an entry saved by an earlier version (or by a backend that failed without a word) can
        // hold empty stretches marked finished: those are processed again rather than trusted
        const cleared = this.clearInstrumental(this.findFailedRuns());
        if (cleared) console.warn('[VocalRemover] the cached instrumental had', cleared, 'blocks of empty output; they are processed again');
        this.fromCache = this.complete;
        this.engine.cache.touch(this.instKey);
        if (this.engine.active === this) this.engine.player.bind(this);
      } else this.fromCache = false;
    } catch (e) { console.warn('[VocalRemover] inst cache load failed', e); }
    this.outputFor = want;
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
    const b = this.buffers;
    if (this.dirtyMix && b.countReady(b.mixReady) > 0) {
      this.dirtyMix = false;
      const mixReady = snapshotBitmap(b.mixReady); // before the samples, as in persistInst
      const mixL = blobOf(b.mixL), mixR = blobOf(b.mixR);
      const ok = await this.engine.cache.save({ key: this.mixKey, videoId: this.videoId, kind: 'mix', title: this.title, duration: this.duration, totalSamples: this.totalSamples, sampleRate: SAMPLE_RATE, mixL, mixR, mixReady: blobOf(mixReady), bytes: this.totalSamples * 4 + b.numBlocks });
      if (!ok) this.dirtyMix = true; // try again next time rather than forgetting the change
    }
    // never mid-switch (switchOutput files the old output itself), and under the key of what the
    // stores hold: saved under the new settings' key, the old model's output would pass for the new one's
    if (this.dirtyInst && !this.switching && b.countReady(b.instReady) > 0) {
      this.dirtyInst = false;
      const ok = await this.persistInst(this.outputKey);
      if (!ok) this.dirtyInst = true;
    }
  }

  async persistInst(key) {
    const b = this.buffers;
    // The ready bitmap is read before the samples. The separator writes a block's samples and only
    // then marks it ready, so every block ready in this snapshot has its samples in the copy that
    // follows. Copied the other way round, a block finished during the copy was saved as ready
    // with the samples from before it was written: a green stretch of silence the next time the
    // cache loaded, and the original the moment the engine noticed.
    const instReady = snapshotBitmap(b.instReady);
    const instL = blobOf(b.instL), instR = blobOf(b.instR);
    let ready = 0;
    for (let i = 0; i < instReady.length; i++) ready += instReady[i];
    return this.engine.cache.save({ key, videoId: this.videoId, kind: 'inst', title: this.title, duration: this.duration, totalSamples: this.totalSamples, sampleRate: SAMPLE_RATE, instL, instR, instReady: blobOf(instReady), complete: ready === b.numBlocks, bytes: this.totalSamples * 4 + b.numBlocks });
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
    if (this.error) {
      phase = 'error'; message = 'Processing failed.'; detail = this.error;
      if (/memory|allocat|\boom\b/i.test(this.error)) detail = `This device ran out of memory for the separation model (${this.error}). Close other tabs or apps, then press Retry.`;
    }
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
      else if (this.embed.active && !this.embed.progress && !this.decoder.isComplete()) detail = `Starting the background fetch (${describeHelper(this.embed.kind)})…`;
      else if (this.decoder.exhaustedFailedSeconds() > 0 && this.jobState === 'waiting') detail = `${Math.round(this.decoder.exhaustedFailedSeconds())} s could not be decoded by the browser even after retries; YouTube's own audio plays there and processing stops short of it.`;
      else if (this.decoder.failedRanges.length) detail = `${Math.round(R.total(this.decoder.failedRangesSeconds()))} s could not be decoded by the browser and stay unprocessed; they are retried a few times.`;
      else if (this.decoder.error) detail = 'Decoding hit an error and is being retried: ' + String(this.decoder.error && this.decoder.error.message || this.decoder.error);
      else if (this.jobState === 'waiting') detail = 'Waiting for more audio to be fetched…';
      else if (this.jobState === 'running' && Date.now() - this.lastJobEventAt > 20000) detail = `The separation model has not reported progress for ${Math.round((Date.now() - this.lastJobEventAt) / 1000)} s; it is restarted if this continues.`;
      else if (!active) detail = 'Another tab is using the audio engine; processing is queued.';
      else if (!this.takeover && this.lastSync && R.total(processed) > 0) detail = 'Playing the original audio until the processed part is reached.';
    }
    // Also once the whole track is done: the original playing under a green bar needs saying most of all.
    if (!this.error && this.settings.enabled && !detail) {
      const p = this.engine.player;
      if (this.lastSync && this.lastSync.playing && this.engine.active === this && !p.running) {
        const why = p.error || this.outputError || (p.ctx ? 'it is ' + p.ctx.state : 'it has not started');
        detail = `Audio output is not working (${why}); trying to restart it. The original audio plays meanwhile.`;
      } else if (this.silentReason && Date.now() < this.silenceUntil) detail = `Playing the original audio: ${this.silentReason}.`;
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
