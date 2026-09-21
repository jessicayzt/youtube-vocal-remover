// Offscreen document entry: routes port connections from YouTube tabs to Sessions, owns the
// single Player (speakers), the separation worker client and the IndexedDB cache.
import { Session, CACHE_VERSION } from './session.js';
import { Player } from './player.js';
import { TrackCache } from './cache.js';

const MAX_SESSIONS_IN_MEMORY = 3;
// An AudioContext that is merely slow to start must not hold a session's messages hostage: after
// this long the session goes ahead without playback and binds the player once it is ready.
const PLAYER_START_TIMEOUT_MS = 15000;
// A separation job that reports nothing for this long is wedged (a hung GPU submission, a
// crashed worker whose error never surfaced): the worker is replaced and the job restarted.
// The first chunk of a job also compiles the model's GPU pipelines, which can take minutes on a
// slow machine, so a job that has not produced a chunk yet is given much longer.
const JOB_STALL_MS = { loading: 180000, firstChunk: 300000, running: 120000 };

class SeparatorClient {
  constructor(engine) {
    this.engine = engine;
    this.current = null; this.queue = []; this.counter = 0; this.starting = false;
    this.lastEventAt = 0;
    this.waiters = new Map(); // session -> resolvers waiting for its running job to end
    this.spawn();
    setInterval(() => this.watchdog(), 5000);
  }

  spawn() {
    const worker = new Worker(chrome.runtime.getURL('src/offscreen/separator-worker.js'), { type: 'module' });
    worker.onmessage = (e) => { if (this.worker === worker) this.onMessage(e.data); };
    worker.onerror = (e) => { if (this.worker === worker) this.restartWorker('worker error: ' + (e && e.message || e)); };
    worker.postMessage({ type: 'init', registry: this.engine.registry });
    this.worker = worker;
  }

  /** Replace the worker and put the interrupted job back at the front of the queue. */
  restartWorker(reason) {
    console.warn('[VocalRemover] restarting the separation worker:', reason);
    try { this.worker.terminate(); } catch (e) { /* ignore */ }
    const interrupted = this.current;
    this.current = null;
    this.spawn();
    if (interrupted) {
      interrupted.onWorkerEvent({ type: 'cancelled', jobId: interrupted.jobId });
      this._settle(interrupted);
      if (interrupted.needsProcessing && !this.queue.includes(interrupted)) this.queue.unshift(interrupted);
    }
    this.schedule();
  }

  watchdog() {
    const s = this.current;
    if (!s) return;
    let limit;
    if (s.jobState === 'loading') limit = JOB_STALL_MS.loading;
    else if (s.jobState === 'running') limit = this.advanced ? JOB_STALL_MS.running : JOB_STALL_MS.firstChunk;
    else return; // waiting for audio, or between states
    const idle = Date.now() - this.lastEventAt;
    if (idle > limit) this.restartWorker(`no progress for ${Math.round(idle / 1000)} s while ${s.jobState}`);
  }

  request(session) {
    if (this.current === session || this.queue.includes(session)) return;
    if (this.engine.active === session) {
      // what is playing goes first, even if another video's job is under way (its 'cancelled' re-queues it)
      this.queue.unshift(session);
      if (this.current) { this.worker.postMessage({ type: 'cancel', jobId: this.current.jobId }); return; }
    } else this.queue.push(session);
    this.schedule();
  }

  setActive(session) {
    if (!session || !session.needsProcessing) { this.schedule(); return; }
    if (this.current === session) return;
    const i = this.queue.indexOf(session);
    if (i >= 0) this.queue.splice(i, 1);
    this.queue.unshift(session);
    if (this.current) this.worker.postMessage({ type: 'cancel', jobId: this.current.jobId }); // its 'cancelled' event re-queues it
    else this.schedule();
  }

  cancel(session) {
    const i = this.queue.indexOf(session);
    if (i >= 0) this.queue.splice(i, 1);
    if (this.current === session) this.worker.postMessage({ type: 'cancel', jobId: session.jobId });
  }

  /** Like cancel(), resolving once the session's job has actually ended, its chunk in flight included. */
  cancelAndWait(session) {
    this.cancel(session);
    if (this.current !== session) return Promise.resolve();
    return new Promise((resolve) => {
      if (!this.waiters.has(session)) this.waiters.set(session, []);
      this.waiters.get(session).push(resolve);
    });
  }

  _settle(session) {
    const w = this.waiters.get(session);
    if (!w) return;
    this.waiters.delete(session);
    for (const resolve of w) resolve();
  }

  priority(session, block, playing) { if (this.current === session) this.worker.postMessage({ type: 'priority', jobId: session.jobId, block, playing: !!playing }); }
  mixProgress(session) { if (this.current === session) this.worker.postMessage({ type: 'mix-progress', jobId: session.jobId }); }

  schedule() {
    if (this.current) return;
    let next = null;
    while (this.queue.length && !next) { const s = this.queue.shift(); if (s.needsProcessing) next = s; }
    if (!next) return;
    this.current = next;
    next.jobId = ++this.counter;
    next.jobState = 'loading';
    this.lastEventAt = Date.now();
    this.startChunks = null; this.advanced = false;
    this.worker.postMessage({ type: 'start', jobId: next.jobId, ...next.jobParams() });
  }

  onMessage(m) {
    if (m.type === 'log') { console.info('[VocalRemover worker]', m.message); return; }
    const session = this.current && this.current.jobId === m.jobId ? this.current : null;
    if (!session) return;
    this.lastEventAt = Date.now();
    if (m.type === 'progress') {
      if (this.startChunks == null) this.startChunks = m.processedChunks;
      else if (m.processedChunks > this.startChunks) this.advanced = true;
    }
    session.onWorkerEvent(m);
    if (m.type === 'done' || m.type === 'cancelled' || m.type === 'error') {
      this.current = null;
      this._settle(session);
      if (m.type === 'cancelled' && session.needsProcessing && !this.queue.includes(session)) this.queue.push(session);
      this.schedule();
    }
  }
}

class Engine {
  constructor(registry) {
    this.registry = registry;
    this.sessions = new Map(); // videoId -> Session
    this.player = new Player();
    this.cache = new TrackCache();
    this.separator = new SeparatorClient(this);
    this.active = null;
    this.player.onReady = () => { if (this.active) this.player.bind(this.active); };
    this.player.onLevel = (info, session) => { if (session && session.onLevel) session.onLevel(info); };
  }

  session(videoId, hello) {
    let s = this.sessions.get(videoId);
    if (s && hello && Math.abs(s.duration - hello.duration) > 0.5) { this.dropSession(s); s = null; }
    if (!s && hello) {
      s = new Session(this, { videoId, duration: hello.duration, title: hello.title });
      this.sessions.set(videoId, s);
      this.evictSessions();
    }
    return s || null;
  }

  dropSession(s) {
    if (this.active === s) { this.player.unbind(s); this.active = null; }
    this.separator.cancel(s);
    this.sessions.delete(s.videoId);
  }

  evictSessions() {
    while (this.sessions.size > MAX_SESSIONS_IN_MEMORY) {
      let victim = null;
      for (const s of this.sessions.values()) {
        if (s === this.active || s.controller) continue;
        if (!victim || s.lastUsed < victim.lastUsed) victim = s;
      }
      if (!victim) break;
      victim.persist().finally(() => {});
      this.dropSession(victim);
    }
  }

  setActive(session) {
    if (this.active === session) return;
    const prev = this.active;
    this.active = session;
    if (prev) prev.onDeactivated();
    if (this.player.ready) this.player.bind(session);
    this.separator.setActive(session);
  }

  onSessionIdle(session) {
    if (this.active === session) {
      // keep playback engine bound (cheap); another tab's sync will take over when it plays
    }
  }

  /** Resolves with an error message when audio output failed for good, null otherwise. */
  async startPlayer() {
    const outcome = await Promise.race([
      this.player.init().then(() => 'ok', () => 'failed'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), PLAYER_START_TIMEOUT_MS)),
    ]);
    if (outcome === 'failed') return 'Audio output could not be started: ' + (this.player.error || 'unknown error');
    if (outcome === 'timeout') console.warn('[VocalRemover] audio output is slow to start; the session goes ahead without it for now');
    return null;
  }

  /**
   * The feature's on/off switch is global. A session whose controller has already gone (the tab
   * that switched it off tears its port down at once) would otherwise keep separating -- and
   * keep playing -- in the background with the switch off.
   */
  applyGlobalSettings(settings) {
    if (!settings || typeof settings !== 'object' || settings.enabled !== false) return;
    for (const s of this.sessions.values()) if (s.settings.enabled) s.applySettings({ enabled: false });
  }
}

async function main() {
  const registry = await (await fetch(chrome.runtime.getURL('models/models.json'))).json();
  const engine = new Engine(registry);
  engine.player.init().catch(() => {});
  engine.cache.purgeOtherVersions(CACHE_VERSION + '|').catch(() => {});
  return engine;
}

// The controller connects the moment the service worker reports this document as created, which
// can be before main() has finished. The listeners therefore go up synchronously, and every
// message waits for the engine; a shared promise keeps the order of messages intact.
const enginePromise = main();
enginePromise.catch((e) => console.error('[VocalRemover] offscreen init failed', e));

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'vrx-controller' && port.name !== 'vrx-capture') return;
  let session = null;
  let attaching = null;      // promise while the hello handshake is in flight
  const pending = [];        // messages that arrived during the handshake
  const reply = (msg) => { try { port.postMessage(msg); } catch (e) { /* port gone */ } };
  const dispatch = (m) => {
    if (!session) return;
    if (port.name === 'vrx-controller') session.onControllerMessage(m);
    else session.onCaptureMessage(port, m);
  };
  const handle = (engine, m) => {
    if (m.type === 'hello') {
      if (port.name === 'vrx-controller') {
        if (!Number.isFinite(m.duration) || m.duration <= 0) { reply({ type: 'error', message: 'Unknown video duration.' }); return; }
        session = engine.session(m.videoId, m);
        attaching = (async () => {
          const playerError = await engine.startPlayer();
          await session.attachController(port, m, playerError);
        })().catch((e) => console.error('[VocalRemover] attach failed', e)).finally(() => {
          attaching = null;
          for (const queued of pending.splice(0)) dispatch(queued);
        });
      } else {
        // The helper's session is created by the controller's hello. Until it exists the helper
        // holds what it captured and asks again, so the stream's headers are not sent into the void.
        session = engine.session(m.videoId, null);
        if (!session) { console.warn('[VocalRemover] capture for unknown session', m.videoId); reply({ type: 'no-session' }); return; }
        session.attachCapture(port, m);
        reply({ type: 'attached' });
      }
      return;
    }
    if (attaching) { pending.push(m); return; }
    dispatch(m);
  };
  port.onMessage.addListener((m) => {
    if (!m || typeof m !== 'object') return;
    enginePromise.then((engine) => handle(engine, m)).catch((e) => console.error('[VocalRemover] message failed', e));
  });
  port.onDisconnect.addListener(() => {
    enginePromise.then(() => {
      if (!session) return;
      if (port.name === 'vrx-controller') session.detachController(port);
      else session.detachCapture(port);
    }).catch(() => {});
  });
});

// Settings changes reach this document through the service worker (see background.js).
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'global-settings') return;
  enginePromise.then((engine) => engine.applyGlobalSettings(msg.settings)).catch(() => {});
});
