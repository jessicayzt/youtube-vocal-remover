// Main-thread side of the playback engine: owns the AudioContext (44.1 kHz to match the
// model/stores) and the player AudioWorkletNode, converts wall-clock sync points from the
// content script into AudioContext time, and forwards parameters.
import { SAMPLE_RATE } from './buffers.js';

const RESTART_MIN_INTERVAL_MS = 10000;

/**
 * The AudioContext time (on the clock of what is heard) at which the media position the page
 * captured `ageMs` milliseconds ago was heard.
 *
 * Times cross from the page to this document as Date.now(). performance.timeOrigin +
 * performance.now() is a per-document monotonic clock that stops while the computer sleeps, so
 * this long-lived document and a page loaded after a sleep disagreed by the length of the sleep,
 * and the playback thread read the track that far from where the video was: silence under a
 * green bar.
 *
 * getOutputTimestamp() reports zeros until the output has produced a timestamp, and can lag; a
 * stamp that is missing, or that disagrees with the render clock by a second or more, is not used.
 *   ts          ctx.getOutputTimestamp() or null
 *   perfNow     performance.now() in this document
 *   currentTime ctx.currentTime: the render clock, ahead of what is heard by `latency`
 *   latency     baseLatency + outputLatency, in seconds
 */
export function heardCtxTime({ ts, perfNow, currentTime, latency, ageMs }) {
  const age = Math.max(0, ageMs || 0) / 1000;
  const fallback = currentTime - (latency || 0) - age;
  if (ts && ts.contextTime > 0 && ts.performanceTime > 0 && Number.isFinite(ts.contextTime) && Number.isFinite(ts.performanceTime)) {
    const viaStamp = ts.contextTime + (perfNow - ts.performanceTime) / 1000 - age;
    if (Math.abs(viaStamp - fallback) < 1) return viaStamp;
  }
  return fallback;
}

export class Player {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.ready = false;
    this.readyPromise = null;
    this.bound = null; // session currently routed to the speakers
    this.error = null;
    this.latency = null;
    this.lastLevelAt = 0;     // Date.now() of the playback thread's last level report
    this.levelCtxTime = 0;    // ctx.currentTime at that report: tells a dead render thread from a quiet one
    this.lastRestartAt = 0; this.restarts = 0; this.restarting = null;
    this.generation = 0; this.initStartedAt = 0;
  }

  init() {
    if (this.readyPromise) return this.readyPromise;
    // a start-up abandoned by restart() must not finish later and take over from its replacement
    const gen = ++this.generation;
    const current = () => gen === this.generation;
    this.initStartedAt = Date.now();
    this.readyPromise = (async () => {
      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' });
      if (!current()) { ctx.close().catch(() => {}); return; }
      this.ctx = ctx; this.lastLevelAt = 0; this.levelCtxTime = 0;
      // closed behind our back (the audio service went away, a device was lost): build a new one
      ctx.onstatechange = () => { if (this.ctx === ctx && ctx.state === 'closed') this.restart('the audio output was closed'); };
      await ctx.audioWorklet.addModule(chrome.runtime.getURL('src/offscreen/player-worklet.js'));
      if (!current()) return;
      this.node = new AudioWorkletNode(ctx, 'vrx-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      this.node.connect(ctx.destination);
      const workletReady = new Promise((resolve, reject) => {
        this.node.port.onmessage = (e) => {
          const d = e.data;
          if (d.type === 'ready') { this.latency = d; resolve(); }
          else if (d.type === 'error') { this.error = d.message; reject(new Error(d.message)); }
          else if (d.type === 'level') {
            this.lastLevelAt = Date.now(); this.levelCtxTime = ctx.currentTime;
            if (this.onLevel) this.onLevel(d, this.bound);
          } else if (d.type === 'runtime-error') {
            this.error = d.message;
            console.error('[VocalRemover] playback thread error:', d.message);
            if (this.onRuntimeError) this.onRuntimeError(d.message, this.bound);
          }
        };
      });
      await ctx.resume();
      await workletReady;
      if (!current()) return;
      if (ctx.state !== 'running') throw new Error('AudioContext is ' + ctx.state);
      this.ready = true;
      this.error = null;
      if (this.onReady) this.onReady();
    })();
    this.readyPromise.catch((e) => { if (!current()) return; this.error = String(e && e.message || e); console.error('[VocalRemover] player init failed', e); });
    return this.readyPromise;
  }

  get running() { return this.ready && this.ctx && this.ctx.state === 'running'; }

  /** Is the render thread still producing frames? Its clock stops when it is not. */
  get rendering() { return !!this.ctx && this.ctx.currentTime - this.levelCtxTime > 0.5; }

  /**
   * A context Chrome has suspended (device change, idle policy) only comes back on resume();
   * one that never started, or was lost, is built again.
   */
  ensureRunning() {
    if (!this.ready) {
      // failed, or still starting after 20 s (a resume() or module load that never settles)
      const hung = !this.error && this.readyPromise && Date.now() - this.initStartedAt > 20000;
      if ((this.error || hung) && !this.restarting) this.restart(hung ? 'audio output did not start' : 'audio output failed to start: ' + this.error);
      return;
    }
    if (!this.ctx || this.ctx.state === 'running' || this.ctx.state === 'closed' || this.resuming) return;
    this.resuming = true;
    this.ctx.resume().catch(() => {}).finally(() => { this.resuming = false; });
  }

  /** Tear the audio output down and build it again; the active session is bound again once it is ready. */
  restart(reason) {
    const now = Date.now();
    if (this.restarting) return this.restarting;
    if (now - this.lastRestartAt < RESTART_MIN_INTERVAL_MS) return Promise.resolve();
    this.lastRestartAt = now; this.restarts++;
    console.warn('[VocalRemover] rebuilding the audio output:', reason);
    const old = this.ctx;
    this.ready = false; this.readyPromise = null; this.node = null; this.bound = null; this.ctx = null;
    try { if (old && old.state !== 'closed') old.close().catch(() => {}); } catch (e) { /* ignore */ }
    if (this.onReset) this.onReset();
    this.restarting = this.init().catch(() => {}).finally(() => { this.restarting = null; });
    // a start-up that hangs again must not leave restart() refusing to try once more
    const t = setTimeout(() => { if (this.restarting && !this.ready) this.restarting = null; }, 25000);
    if (t && typeof t.unref === 'function') t.unref(); // Node (tests): never keep the process alive
    return this.restarting;
  }

  /** Send the session's stores and parameters again: the playback thread may have lost them. */
  rebind(session) {
    if (!this.ready) return;
    this.bound = null;
    if (this.onReset) this.onReset();
    this.bind(session);
  }

  bind(session) {
    if (!this.ready) return;
    if (this.bound !== session) {
      this.bound = session;
      this.node.port.postMessage({ type: 'buffers', ...session.buffers.shareable() });
    }
    // always: a session re-activated with settings changed meanwhile must not keep playing with the old ones
    this.setParams(session.playbackParams());
  }

  unbind(session) {
    if (session && this.bound !== session) return;
    this.bound = null;
    if (this.node) this.node.port.postMessage({ type: 'clear' });
  }

  /** wall: Date.now() at which mediaTime was current in the page. */
  sync(session, { mediaTime, wall, rate, playing }) {
    if (!this.ready || this.bound !== session) return;
    const ctxTime = heardCtxTime({
      ts: typeof this.ctx.getOutputTimestamp === 'function' ? this.ctx.getOutputTimestamp() : null,
      perfNow: performance.now(), currentTime: this.ctx.currentTime,
      latency: (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0), ageMs: Date.now() - wall,
    });
    this.node.port.postMessage({ type: 'sync', mediaTime, ctxTime, rate, playing });
  }

  /** Copy PCM into the playback thread when it cannot see the shared stores. */
  pushBlocks(meta, a, b) {
    if (!this.ready || !this.node) return;
    this.node.port.postMessage({ type: 'blocks', ...meta, a, b }, [a, b]);
  }

  /** Copies pushed earlier for these blocks must stop playing (see pushBlocks). */
  dropBlocks(meta) {
    if (!this.ready || !this.node) return;
    this.node.port.postMessage({ type: 'drop', ...meta });
  }

  setParams(params) {
    if (!this.ready) return;
    this.node.port.postMessage({ type: 'params', params });
  }
}
