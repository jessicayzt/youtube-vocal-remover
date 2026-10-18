// Offscreen document entry: routes port connections from YouTube tabs to Sessions, owns the
// single Player (speakers), the separation worker client and the IndexedDB cache.
import { Session, CACHE_VERSION } from './session.js';
import { Player } from './player.js';
import { TrackCache } from './cache.js';
import { SeparatorClient } from './separator-client.js';

const MAX_SESSIONS_IN_MEMORY = 3;
// An AudioContext that is merely slow to start must not hold a session's messages hostage: after
// this long the session goes ahead without playback and binds the player once it is ready.
const PLAYER_START_TIMEOUT_MS = 15000;
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
    this.player.onReset = () => { for (const s of this.sessions.values()) s.onPlayerRestart(); };
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
        try { session = engine.session(m.videoId, m); } catch (e) {
          // the track's stores did not fit in memory: say so, rather than leave the page starting for good
          const mb = Math.round((Math.round(m.duration * 44100) * 8) / 1e6);
          reply({ type: 'error', message: `Not enough memory to hold this video's audio (about ${mb} MB).`, detail: 'Close other tabs or apps, or try a shorter video. (' + String(e && e.message || e) + ')' });
          return;
        }
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
    enginePromise.then(
      (engine) => { try { handle(engine, m); } catch (e) { console.error('[VocalRemover] message failed', e); } },
      // an engine that never came up would otherwise swallow every message and leave the page on
      // "Starting the audio engine…" for good
      (e) => { if (m.type === 'hello') reply({ type: 'error', message: 'The audio engine could not start: ' + String(e && e.message || e), detail: 'Reload the extension (chrome://extensions) and the page to try again.' }); },
    );
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
