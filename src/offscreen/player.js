// Main-thread side of the playback engine: owns the AudioContext (44.1 kHz to match the
// model/stores) and the player AudioWorkletNode, converts wall-clock sync points from the
// content script into AudioContext time, and forwards parameters.
import { SAMPLE_RATE } from './buffers.js';

export class Player {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.ready = false;
    this.readyPromise = null;
    this.bound = null; // session currently routed to the speakers
    this.error = null;
    this.latency = null;
  }

  init() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' });
      await this.ctx.audioWorklet.addModule(chrome.runtime.getURL('src/offscreen/player-worklet.js'));
      this.node = new AudioWorkletNode(this.ctx, 'vrx-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      this.node.connect(this.ctx.destination);
      const workletReady = new Promise((resolve, reject) => {
        this.node.port.onmessage = (e) => {
          const d = e.data;
          if (d.type === 'ready') { this.latency = d; resolve(); }
          else if (d.type === 'error') { this.error = d.message; reject(new Error(d.message)); }
          else if (d.type === 'level' && this.onLevel) this.onLevel(d, this.bound);
          else if (d.type === 'runtime-error') {
            this.error = d.message;
            console.error('[VocalRemover] playback thread error:', d.message);
            if (this.onRuntimeError) this.onRuntimeError(d.message, this.bound);
          }
        };
      });
      await this.ctx.resume();
      await workletReady;
      if (this.ctx.state !== 'running') throw new Error('AudioContext is ' + this.ctx.state);
      this.ready = true;
      if (this.onReady) this.onReady();
    })();
    this.readyPromise.catch((e) => { this.error = String(e && e.message || e); console.error('[VocalRemover] player init failed', e); });
    return this.readyPromise;
  }

  get running() { return this.ready && this.ctx && this.ctx.state === 'running'; }

  /** A context Chrome has suspended (device change, idle policy) only comes back on resume(). */
  ensureRunning() {
    if (!this.ready || !this.ctx || this.ctx.state === 'running' || this.ctx.state === 'closed' || this.resuming) return;
    this.resuming = true;
    this.ctx.resume().catch(() => {}).finally(() => { this.resuming = false; });
  }

  bind(session) {
    if (!this.ready) return;
    if (this.bound === session) return;
    this.bound = session;
    this.node.port.postMessage({ type: 'buffers', ...session.buffers.shareable() });
    this.setParams(session.playbackParams());
  }

  unbind(session) {
    if (session && this.bound !== session) return;
    this.bound = null;
    if (this.node) this.node.port.postMessage({ type: 'clear' });
  }

  /** wall: epoch milliseconds at which mediaTime was current in the page. */
  sync(session, { mediaTime, wall, rate, playing }) {
    if (!this.ready || this.bound !== session) return;
    const ts = this.ctx.getOutputTimestamp();
    let ctxTime;
    if (ts && Number.isFinite(ts.contextTime) && Number.isFinite(ts.performanceTime)) {
      const nowWall = performance.timeOrigin + ts.performanceTime;
      ctxTime = ts.contextTime + (wall - nowWall) / 1000;
    } else {
      ctxTime = this.ctx.currentTime + (wall - (performance.timeOrigin + performance.now())) / 1000 + (this.ctx.outputLatency || this.ctx.baseLatency || 0);
    }
    this.node.port.postMessage({ type: 'sync', mediaTime, ctxTime, rate, playing });
  }

  /** Copy PCM into the playback thread when it cannot see the shared stores. */
  pushBlocks(meta, a, b) {
    if (!this.ready || !this.node) return;
    this.node.port.postMessage({ type: 'blocks', ...meta, a, b }, [a, b]);
  }

  setParams(params) {
    if (!this.ready) return;
    this.node.port.postMessage({ type: 'params', params });
  }
}
