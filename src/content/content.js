// Isolated-world content script (all youtube.com frames).
//  - In the top-level watch page it is the controller: UI panel, seek-bar overlay, settings,
//    connection to the offscreen audio engine, playback sync, hidden helper embed, audio takeover.
//  - In our hidden helper embed (…/embed/ID#vrx-helper) it only relays captured segments to the engine.
// Depends on the classic scripts loaded before it: VRX.ranges, VRX.b64, VRX_UI.
(() => {
  const isTop = window === window.top;
  const isOurEmbed = /(^|[#&])vrx-helper(=|&|$)/.test(location.hash) || window.name === 'vrx-helper';
  if (!isTop && !isOurEmbed) return;

  const b64 = globalThis.VRX.b64;
  const R = globalThis.VRX.ranges;
  const log = (...a) => console.debug('[VocalRemover]', ...a);
  const DEFAULT_SETTINGS = { enabled: false, vocalLevel: 0, semitones: 0, modelId: 'inst_hq_5', quality: 'high' };
  const MODELS = [
    { id: 'inst_hq_5', label: 'MDX-Net Inst HQ 5 (2025, default)' },
    { id: 'inst_hq_3', label: 'MDX-Net Inst HQ 3' },
  ];

  // ---------------------------------------------------------------- hook (MAIN world) bridge
  const hookListeners = new Set();
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__vrx !== true) return;
    for (const l of hookListeners) { try { l(e.data); } catch (err) { log('hook listener error', err); } }
  });
  const cmdHook = (msg) => window.postMessage(Object.assign({ __vrxCmd: true }, msg), location.origin);

  const CONNECT_TIMEOUT_MS = 15000; // a background worker that never answers must not leave the panel on "Starting…" for good
  async function connectEngine(name) {
    const res = await Promise.race([
      chrome.runtime.sendMessage({ type: 'ensure-offscreen' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("the extension's background worker did not answer")), CONNECT_TIMEOUT_MS)),
    ]);
    if (!res || !res.ok) throw new Error((res && res.error) || 'offscreen document unavailable');
    return chrome.runtime.connect({ name });
  }

  // Timer-free task scheduling. setTimeout is throttled to once a second in a hidden tab, and to
  // once a minute after a few minutes there, which would starve the engine of audio while the
  // person listens with the tab in the background. Message events are not throttled.
  const taskChannel = new MessageChannel();
  const tasks = [];
  taskChannel.port1.onmessage = () => { const fn = tasks.shift(); if (fn) fn(); };
  const queueTask = (fn) => { tasks.push(fn); taskChannel.port2.postMessage(0); };

  /**
   * Captured segments are base64'd to cross the extension message boundary, which is real work
   * on the page's main thread. Doing it inline made the player stall (YouTube then offers its
   * "Experiencing interruptions?" toast), so segments are drained in short slices instead.
   */
  function makeSegmentQueue(send) {
    const queue = [];
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      const deadline = performance.now() + 4; // keep every task well under a frame
      while (queue.length) {
        send(queue.shift());
        if (performance.now() >= deadline) break;
      }
      if (queue.length) { scheduled = true; queueTask(flush); }
    };
    const push = (item) => {
      queue.push(item);
      if (!scheduled) { scheduled = true; queueTask(flush); }
    };
    return {
      segment(m) {
        const bytes = new Uint8Array(m.buf);
        if (bytes.length <= SEG_CHUNK_BYTES) { push({ m, bytes }); return; }
        for (let o = 0; o < bytes.length; o += SEG_CHUNK_BYTES) push({ m, bytes: bytes.subarray(o, Math.min(bytes.length, o + SEG_CHUNK_BYTES)) });
      },
      // goes through the same queue: a reset that overtook the segments queued before it would
      // throw away the parser state those segments still need
      control(msg) { push({ ctrl: msg }); },
      // a session that ends leaves nothing behind for the next one
      clear() { queue.length = 0; },
    };
  }

  // One captured segment can be hundreds of kilobytes; base64 plus the extension IPC copy of a
  // message that size is a single unsplittable chunk of main-thread work. The byte-stream parser
  // on the other side accepts any chunking, so large segments go over in bounded pieces.
  const SEG_CHUNK_BYTES = 192 * 1024;

  function segmentMessage(m, bytes) {
    return {
      type: 'seg', key: m.key, mime: m.mime, tsOffset: m.tsOffset || 0,
      msDuration: Number.isFinite(m.msDuration) ? m.msDuration : null, ad: !!m.ad, retained: !!m.retained,
      b64: b64.encode(bytes),
    };
  }

  // ================================================================ helper embed role
  if (isOurEmbed) {
    const videoId = location.pathname.startsWith('/embed/') ? location.pathname.slice('/embed/'.length).split(/[/?#]/)[0] : new URLSearchParams(location.search).get('v');
    // Nothing captured is sent until the engine confirms it has a session for this video: the
    // first messages carry the stream's codec headers, and anything sent into the void before the
    // session exists would leave the whole helper stream undecodable.
    const HELD_MAX = 500;
    let port = null, attached = false, everAttached = false, closed = false, reconnects = 0, failures = 0, helloRetries = 0;
    const held = [];
    const heldDropped = new Set(); // stream keys whose segments no longer fit while holding
    const send = (msg) => {
      if (port && attached) { try { port.postMessage(msg); return; } catch (e) { port = null; attached = false; } }
      if (held.length < HELD_MAX || msg.type !== 'seg') held.push(msg);
      else heldDropped.add(msg.key);
    };
    const flushHeld = () => {
      const items = held.splice(0);
      for (const key of heldDropped) items.push({ type: 'discontinuity', key });
      heldDropped.clear();
      for (let i = 0; i < items.length; i++) {
        try { port.postMessage(items[i]); } catch (e) { port = null; attached = false; held.unshift(...items.slice(i)); return; }
      }
    };
    const relayQueue = makeSegmentQueue((item) => send(item.ctrl || segmentMessage(item.m, item.bytes)));
    hookListeners.add((m) => {
      if (m.t === 'seg') relayQueue.segment(m);
      else if (m.t === 'sb-reset' || m.t === 'sb-new' || m.t === 'discontinuity') relayQueue.control({ type: m.t, key: m.key, mime: m.mime });
      else if (m.t === 'embed') { const { t, buf, ...rest } = m; send({ type: 'embed', ...rest }); }
    });
    send({ type: 'embed', event: 'alive', href: location.href, top: window === window.top, stage: 'content-script' });
    const hello = () => { if (port) { try { port.postMessage({ type: 'hello', role: 'capture', source: 'embed', videoId, href: location.href }); } catch (e) { /* reconnect handles it */ } } };
    // A helper that has lost its engine for good must not sit there fetching until the person
    // notices a stray tab. Only a top-level tab can close itself; a frame is removed by its parent.
    const closeSelf = () => { closed = true; if (isTop) { try { window.close(); } catch (e) { /* ignore */ } } };
    const connect = () => {
      if (closed) return;
      connectEngine('vrx-capture').then((p) => {
        port = p; failures = 0;
        p.onMessage.addListener((msg) => {
          if (!msg) return;
          if (msg.type === 'throttle') cmdHook({ t: 'throttle', on: !!msg.on });
          else if (msg.type === 'attached') {
            attached = true; reconnects = 0; helloRetries = 0;
            // a session reached again after losing the engine has a fresh store: it needs the
            // stream's headers again before anything else
            if (everAttached) cmdHook({ t: 'heads' });
            everAttached = true;
            flushHeld();
          }
          else if (msg.type === 'no-session') { attached = false; if (helloRetries++ < 15) setTimeout(hello, 2000); else closeSelf(); }
          else if (msg.type === 'done') closeSelf();
        });
        p.onDisconnect.addListener(() => {
          if (port !== p) return;
          port = null; attached = false;
          if (!closed) setTimeout(connect, Math.min(10000, 1000 * Math.pow(2, reconnects++)));
        });
        hello();
      }).catch((e) => {
        log('embed relay could not connect', e);
        if (++failures < 6) setTimeout(connect, 2000 * failures); else closeSelf();
      });
    };
    connect();
    return;
  }

  // ================================================================ controller role (watch page)
  const S = {
    settings: { ...DEFAULT_SETTINGS },
    videoId: null, video: null, duration: null,
    port: null, sessionActive: false, sessionToken: 0, engineReady: false, reconnectAttempts: 0,
    panel: null, overlay: null, overlayBar: null, mounting: null,
    helper: null, helperWatchdog: null, helperFailures: [], helperRetryAt: 0, captureNeeded: false,
    helperWanted: false, helperGateSince: null, helperThrottled: false, helperThrottledAt: 0, lastStallAt: 0,
    adShowing: false, adObserver: null,
    engineState: null, takeover: false, heartbeat: null, videoListeners: [], preflight: null,
    pending: [], pendingBytes: 0, pendingDropped: new Set(),
    lastPlayhead: 0, durationMismatchTicks: 0, durationRestarts: 0,
    lastPong: null, pendingVideo: null, pendingVideoTicks: 0,
    qualityPrefBefore: undefined,
  };

  const wall = () => performance.timeOrigin + performance.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, timeoutMs = 15000, interval = 250) {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) return null;
      await sleep(interval);
    }
  }
  const currentVideoId = () => (location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null);
  // The element YouTube is playing in. It marks it html5-main-video; a page can hold a second,
  // preloading element, and a selector list returns whichever comes first in the document.
  const mainVideo = () => document.querySelector('#movie_player video.html5-main-video') || document.querySelector('#movie_player video');

  // ---------------------------------------------------------------- the person's quality preference
  // YouTube keeps the last quality a player was set to in localStorage and applies it to the next
  // video from the same origin. A helper on www.youtube.com asked for the lowest quality and that
  // became the preference of the page being watched. Two defences: the helper restores the value
  // itself (hook.js), and this page watches the key while a helper is alive and puts its own value
  // back if it turns into 144p. Storage events fire here for every same-origin document's writes.
  const QUALITY_KEY = 'yt-player-quality';
  const readQualityPref = () => { try { return localStorage.getItem(QUALITY_KEY); } catch (e) { return null; } };
  const prefIsLowest = (v) => typeof v === 'string' && /quality\\?":\s*\\?"?144\b/.test(v);
  const writeQualityPref = (v) => { try { if (v === null) localStorage.removeItem(QUALITY_KEY); else localStorage.setItem(QUALITY_KEY, v); } catch (e) { /* ignore */ } };
  window.addEventListener('storage', (e) => {
    if (e.key !== QUALITY_KEY || !S.helper || S.qualityPrefBefore === undefined) return;
    if (prefIsLowest(e.newValue) && !prefIsLowest(S.qualityPrefBefore)) {
      log("restoring the quality preference the helper's player changed");
      writeQualityPref(S.qualityPrefBefore);
    }
  });
  /** One-time: an earlier version's helper left 144p behind as the preference; back to automatic. */
  async function repairQualityPreference() {
    try {
      const { qualityRepaired } = await chrome.storage.local.get('qualityRepaired');
      if (qualityRepaired) return;
      if (prefIsLowest(readQualityPref())) { writeQualityPref(null); log("cleared the 144p quality preference left by an earlier version's helper"); }
      await chrome.storage.local.set({ qualityRepaired: true });
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- settings
  async function loadSettings() {
    try {
      const { settings } = await chrome.storage.local.get('settings');
      S.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    } catch (e) { log('settings load failed', e); }
  }
  function saveSettings(patch) {
    S.settings = { ...S.settings, ...patch };
    if (S.panel) S.panel.setSettings(S.settings);
    // The engine hears first, synchronously: switching the feature off tears the port down right
    // after this call, and a session that never heard "disabled" kept separating the whole video
    // in the background (and kept playing) long after the switch was off.
    sendToEngine({ type: 'settings', settings: S.settings });
    try { chrome.storage.local.set({ settings: S.settings }).catch((e) => log('settings save failed', e)); } catch (e) { log('settings save failed', e); }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const next = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    const wasEnabled = S.settings.enabled;
    S.settings = next;
    if (S.panel) S.panel.setSettings(next);
    sendToEngine({ type: 'settings', settings: next });
    if (next.enabled !== wasEnabled) {
      const on = next.enabled && !!currentVideoId();
      cmdHook({ t: 'arm', on: on });
      cmdHook({ t: 'capture', on: on });
      if (next.enabled) startSession(); else stopSession();
    }
  });

  // ---------------------------------------------------------------- UI
  const uiCallbacks = {
    toggle: (enabled) => { cmdHook({ t: 'arm', on: enabled }); cmdHook({ t: 'capture', on: enabled }); if (!enabled) pendingClear(); saveSettings({ enabled }); if (enabled) startSession(); else stopSession(); },
    vocalLevel: (level) => saveSettings({ vocalLevel: Math.min(1, Math.max(0, level)) }),
    transpose: (n) => saveSettings({ semitones: Math.max(-7, Math.min(7, Math.round(n))) }),
    model: (modelId) => saveSettings({ modelId }),
    quality: (quality) => saveSettings({ quality }),
    retry: () => { stopSession(); startSession(); },
    clearCache: () => sendToEngine({ type: 'clear-cache' }),
  };

  function mountUI() {
    if (S.mounting) return S.mounting;
    S.mounting = (async () => {
      const mount = await waitFor(() => document.querySelector('#below'), 20000);
      if (!mount || !globalThis.VRX_UI) return;
      if (!S.panel) {
        S.panel = globalThis.VRX_UI.createPanel({ mount, models: MODELS, settings: S.settings, on: uiCallbacks });
      } else S.panel.ensureMounted(mount);
      refreshOverlayTarget();
      pushUIState();
    })().finally(() => { S.mounting = null; });
    return S.mounting;
  }
  function refreshOverlayTarget() {
    const bar = document.querySelector('#movie_player .ytp-progress-bar');
    if (!bar || !globalThis.VRX_UI) return;
    if (S.overlay && S.overlayBar === bar && bar.isConnected) return;
    if (S.overlay) { try { S.overlay.destroy(); } catch (e) { /* ignore */ } }
    S.overlay = globalThis.VRX_UI.createSeekbarOverlay(bar);
    S.overlayBar = bar;
  }
  function pushUIState() {
    if (!S.panel) return;
    const es = S.engineState;
    const playhead = S.video ? S.video.currentTime : null;
    let state;
    if (!S.settings.enabled) {
      state = { phase: 'off', message: 'Turn on to remove vocals from this video. Processing happens on this device.', detail: null, backend: null, speed: null, duration: S.duration, captured: [], decoded: [], processed: [], playhead, fromCache: false };
    } else if (!es) {
      state = { phase: 'starting', message: S.preflight || 'Starting the audio engine…', detail: null, backend: null, speed: null, duration: S.duration, captured: [], decoded: [], processed: [], playhead, fromCache: false };
    } else {
      state = { ...es, playhead, duration: es.duration || S.duration };
    }
    S.panel.setState(state);
    if (S.overlay) S.overlay.update({ duration: state.duration, processed: state.processed || [], decoded: state.decoded || [] });
  }
  function setPreflight(message) {
    if (S.preflight === message) return;
    S.preflight = message;
    pushUIState();
  }

  // ---------------------------------------------------------------- engine connection
  function sendToEngine(msg) {
    if (!S.port) return false;
    try { S.port.postMessage(msg); return true; } catch (e) { log('port send failed', e); return false; }
  }

  function handleEngineMessage(m) {
    switch (m.type) {
      case 'plan':
        // the engine has a session for this video: from here on captured audio goes straight through
        S.engineReady = true;
        S.reconnectAttempts = 0;
        pendingDrain(); // everything captured while the engine was starting
        S.captureNeeded = !!m.needCapture;
        if (m.needCapture) wantHelper(); else { S.helperWanted = false; removeHelper(); }
        break;
      case 'need-embed': wantHelper(); break;
      case 'capture-complete': S.captureNeeded = false; S.helperWanted = false; removeHelper(); break;
      case 'embed-alive': if (S.helper) { S.helper.alive = true; log('helper', S.helper.kind, 'alive:', m.info || ''); } break;
      case 'embed-keepalive': if (S.helper) S.helper.alive = true; break; // the helper's player is running; only data counts as progress
      case 'embed-dom': if (S.helper) { S.helper.dom = m.info; S.helper.lastProgress = Date.now(); log('helper', S.helper.kind, 'page state:', m.info); } break;
      case 'embed-progress': if (S.helper) { S.helper.progress = true; S.helper.lastProgress = Date.now(); } break;
      case 'embed-ended': if (S.helper) { S.helper.progress = true; S.helper.ended = true; S.helper.lastProgress = Date.now(); } break; // all fetched; the engine finishes decoding, then removes it
      case 'embed-error': failHelper('helper player error: ' + (m.message || 'unknown')); break;
      case 'embed-failed': removeHelper(); break;
      case 'state':
        S.engineState = m.state;
        pushUIState();
        break;
      case 'takeover':
        setTakeover(!!m.on);
        break;
      case 'error':
        S.engineState = { ...(S.engineState || {}), phase: 'error', message: m.message || 'Engine error', detail: m.detail || null };
        pushUIState();
        break;
      default: break;
    }
  }

  const PLAYER_SWITCH_WAIT_MS = 10000; // for the player to report the video the page navigated to
  const DURATION_WAIT_MS = 30000;     // for the content's duration, counted while no ad is playing
  const AD_WAIT_MAX_MS = 5 * 60 * 1000; // an ad state that never clears is not worth waiting out
  const MAX_DURATION_RESTARTS = 3;      // per video; more means the length keeps changing (a live stream)
  const MSE_WORKER_MESSAGE = 'YouTube is playing this video from a worker thread on this page, where the extension cannot capture the audio. Reloading the page may give you the normal player.';

  // Chrome lets a page run Media Source Extensions inside a worker. The page-world hook only sees
  // the main thread's MediaSource, so on such a page there is nothing to capture, and the panel
  // must say so instead of fetching 0% forever.
  function mseInWorker(v) {
    try { return !!v.srcObject && typeof MediaSourceHandle === 'function' && v.srcObject instanceof MediaSourceHandle; } catch (e) { return false; }
  }
  function isLive(video) {
    if (video.duration === Infinity) return true;
    const player = document.getElementById('movie_player');
    return !!(player && player.querySelector('.ytp-time-display.ytp-live'));
  }
  /**
   * After a navigation the page's <video> keeps the previous video, and its duration, until the
   * player has switched. The player itself knows which video it is on; wait until it says ours.
   */
  async function waitForPlayerOn(videoId, alive) {
    const t0 = Date.now();
    for (;;) {
      if (!alive()) return false;
      cmdHook({ t: 'ping' });
      await sleep(250);
      const p = S.lastPong;
      if (p && (p.videoId === videoId || p.videoId == null)) return true; // ours, or a player that does not say
      if (Date.now() - t0 > PLAYER_SWITCH_WAIT_MS) return true;
      setPreflight('Waiting for the player to switch to this video…');
    }
  }
  /**
   * The content's duration, once no ad is playing. A pre-roll runs in the same <video> element, so
   * while it plays the element reports the ad's length; a session opened with that length rejects
   * every segment of the actual video as foreign media and never gets past 0%. The element's
   * duration has to agree with the player's own, or the element still holds the previous video.
   * Returns 'live' for a live stream, null when the duration never became known.
   */
  async function waitForDuration(video, alive) {
    const t0 = Date.now();
    let since = t0;
    for (;;) {
      if (!alive()) return null;
      if (isLive(video)) return 'live';
      if (Date.now() - t0 > AD_WAIT_MAX_MS) return null;
      cmdHook({ t: 'ping' });
      if (S.adShowing) { setPreflight('Waiting for the ad to finish…'); since = Date.now(); }
      else {
        const d = video.duration;
        const p = S.lastPong;
        const pd = p && p.videoId === S.videoId && Number.isFinite(p.duration) && p.duration > 0 ? p.duration : NaN;
        if (Number.isFinite(d) && d > 0 && (!Number.isFinite(pd) || Math.abs(d - pd) <= 2)) return d;
        if (Date.now() - since > DURATION_WAIT_MS) return Number.isFinite(pd) ? pd : (Number.isFinite(d) && d > 0 ? d : null);
      }
      await sleep(200);
    }
  }

  async function startSession() {
    if (!S.settings.enabled || S.sessionActive) return;
    const videoId = currentVideoId();
    if (!videoId) return;
    // a token, not just the flag: a stop followed by a start for the same video (Retry, a duration
    // change) must not leave an earlier startSession() still running alongside the new one
    const token = ++S.sessionToken;
    const alive = () => S.sessionActive && S.sessionToken === token && S.videoId === videoId;
    S.sessionActive = true;
    S.videoId = videoId;
    S.engineState = null; S.engineReady = false;
    S.helperFailures = []; S.helperRetryAt = 0; S.captureNeeded = false;
    S.helperGateSince = null; S.helperThrottled = false; S.lastStallAt = 0; S.preflight = null; S.durationMismatchTicks = 0;
    pushUIState();
    const video = await waitFor(mainVideo, 20000);
    if (!alive()) return;
    if (!video) { failSession('Could not find the video player on this page.'); return; }
    S.video = video;
    // ads are tracked from the very start: the duration below and the engine gate both depend on it
    attachAdObserver();
    await waitForPlayerOn(videoId, alive);
    if (!alive()) return;
    const duration = await waitForDuration(video, alive);
    if (!alive()) return;
    if (duration === 'live') { failSession('Live streams are not supported.'); return; }
    if (!duration) { failSession('The video duration is not available.'); return; }
    if (duration > 60 * 60) { failSession('Videos longer than 60 minutes are not supported (memory).'); return; }
    if (mseInWorker(video)) { failSession(MSE_WORKER_MESSAGE); return; }
    S.duration = duration;
    S.preflight = null;
    // wait for the player to stop struggling before we compete with it for CPU, GPU and bandwidth
    if (!playerSettled(video, ENGINE_MIN_BUFFER_SECONDS)) {
      setPreflight('Waiting for the video to finish buffering…');
      const t0 = Date.now();
      await waitFor(() => (playerSettled(video, ENGINE_MIN_BUFFER_SECONDS) || !alive() ? true : null), ENGINE_MAX_WAIT_MS, 250);
      if (!alive()) return;
      S.preflight = null;
      log('engine start gate waited', Date.now() - t0, 'ms');
    }
    try {
      const port = await connectEngine('vrx-controller');
      if (!alive()) { port.disconnect(); return; }
      S.port = port;
      port.onMessage.addListener(handleEngineMessage);
      port.onDisconnect.addListener(() => {
        if (S.port !== port) return;
        S.port = null; S.engineReady = false;
        setTakeover(false);
        if (S.sessionActive) {
          // engine went away (extension reload, offscreen closed): try to reconnect a few times.
          // The helper's port died with it, so the helper restarts with the session. Capture is
          // switched off meanwhile: switching it back on replays the stream's headers ahead of
          // what was appended in between, which the engine's fresh store needs.
          cmdHook({ t: 'capture', on: false });
          removeHelper();
          if (S.reconnectAttempts++ < 3) { S.sessionActive = false; setTimeout(startSession, 1500); }
          else failSession('Lost the connection to the audio engine. Reload the page to retry.');
        }
      });
      const title = (document.title || '').replace(/ - YouTube$/, '');
      port.postMessage({ type: 'hello', role: 'controller', videoId, duration, title, settings: S.settings, wall: wall() });
      // captured audio held so far goes over once the engine confirms the session (its 'plan')
    } catch (e) {
      failSession('Could not start the audio engine: ' + (e && e.message ? e.message : e));
      return;
    }
    attachVideo(video);
    cmdHook({ t: 'shadow' });
    cmdHook({ t: 'arm', on: true });
    cmdHook({ t: 'capture', on: true });
    log('capture enabled');
    sendSync('start');
  }

  /** Releases everything a session holds: the engine port, the helper, the page hook, listeners. */
  function teardownSession() {
    S.sessionActive = false;
    S.helperGateSince = null;
    S.preflight = null;
    pendingClear();
    queueMainSegment.clear();
    setTakeover(false);
    cmdHook({ t: 'capture', on: false });
    cmdHook({ t: 'unshadow' });
    if (S.port) { try { S.port.postMessage({ type: 'bye' }); S.port.disconnect(); } catch (e) { /* ignore */ } }
    S.port = null; S.engineReady = false;
    S.helperWanted = false;
    // stay armed while the feature is on (the next video's session follows); once it is off the
    // idle budget is enough to keep the start of the stream for a later switch-on
    cmdHook({ t: 'arm', on: !!S.settings.enabled });
    removeHelper();
    detachVideo();
    detachAdObserver();
  }

  function failSession(message) {
    teardownSession();
    S.engineState = { phase: 'error', message, detail: null, backend: null, speed: null, duration: S.duration, captured: [], decoded: [], processed: [], fromCache: false };
    pushUIState();
  }

  function stopSession() {
    teardownSession();
    S.engineState = null;
    pushUIState();
  }

  // ---------------------------------------------------------------- main capture + sync
  // Capturing starts as soon as the feature is on, but the engine deliberately does not (see the
  // gate below). Holding the captured bytes here costs nothing -- encoding and shipping them is
  // the expensive part -- whereas dropping them loses the stream's headers, and without those
  // nothing that follows can ever be decoded.
  const PENDING_MAX_BYTES = 64 * 1024 * 1024;
  function pendingPush(m) {
    const size = m.buf ? m.buf.byteLength : 0;
    if (size && S.pendingBytes + size > PENDING_MAX_BYTES) { S.pendingDropped.add(m.key); return; } // keep the earliest: the headers are there
    S.pending.push(m);
    S.pendingBytes += size;
  }
  function pendingDrain() {
    if (!S.pending.length && !S.pendingDropped.size) return;
    const items = S.pending, dropped = S.pendingDropped;
    S.pending = []; S.pendingBytes = 0; S.pendingDropped = new Set();
    log('handing over', items.length, 'captured messages held while the engine started');
    for (const item of items) dispatchCapture(item);
    // what did not fit is gone: the parser must not glue what follows onto the last kept append
    for (const key of dropped) dispatchCapture({ t: 'discontinuity', key });
  }
  function pendingClear() { S.pending = []; S.pendingBytes = 0; S.pendingDropped = new Set(); }
  function dispatchCapture(m) {
    if (m.t === 'seg') queueMainSegment.segment(m);
    else queueMainSegment.control({ type: m.t, key: m.key, mime: m.mime, source: 'main' });
  }

  hookListeners.add((m) => {
    if (m.t === 'pong') { S.lastPong = m; return; }
    if (m.t === 'vol') { if (S.port) sendToEngine({ type: 'vol', volume: m.volume, muted: m.muted }); return; }
    if (m.t === 'hook-error') { log('hook error', m.message); return; }
    if (m.t !== 'seg' && m.t !== 'sb-reset' && m.t !== 'sb-new' && m.t !== 'discontinuity') return;
    if (!S.settings.enabled) return;
    // held until the engine has confirmed the session: a port that is still connecting, or one
    // that was refused, would swallow the stream's headers
    if (!S.port || !S.engineReady) { pendingPush(m); return; }
    dispatchCapture(m);
  });

  const queueMainSegment = makeSegmentQueue((item) => sendToEngine(item.ctrl || Object.assign(segmentMessage(item.m, item.bytes), { source: 'main' })));

  function isPlaying(v) {
    return !v.paused && !v.ended && !v.seeking && v.readyState >= 3;
  }
  function sendSync(reason) {
    const v = S.video;
    if (!v || !S.port) return;
    sendToEngine({
      type: 'sync', reason, mediaTime: v.currentTime, wall: wall(), rate: v.playbackRate || 1,
      playing: isPlaying(v) && !S.adShowing, ad: S.adShowing,
    });
    S.lastPlayhead = v.currentTime;
  }
  function attachVideo(video) {
    detachVideo();
    const on = (ev, fn) => { video.addEventListener(ev, fn); S.videoListeners.push([video, ev, fn]); };
    for (const ev of ['play', 'playing', 'pause', 'seeking', 'seeked', 'ratechange', 'waiting', 'stalled', 'ended', 'emptied', 'loadedmetadata']) on(ev, () => sendSync(ev));
    on('timeupdate', () => { sendSync('timeupdate'); });
    // deliberately no volumechange listener here: in this world the element's volume is the raw
    // value, which is 0 whenever we have taken the audio over. The page-world hook reports the
    // user's real volume instead (see hook.js).
    for (const ev of ['waiting', 'stalled']) on(ev, onMainStall);
    S.heartbeat = setInterval(heartbeat, 500);
  }
  function heartbeat() {
    if (S.video && isPlaying(S.video)) sendSync('tick');
    // every kind of helper failed a while ago: try the whole ladder once more
    if (!S.helperWanted && S.captureNeeded && S.helperRetryAt && Date.now() >= S.helperRetryAt && !S.helper) { S.helperRetryAt = 0; S.helperFailures = []; log('helper: retrying after the earlier failures'); wantHelper(); }
    maybeStartHelper();
    updateHelperThrottle();
    watchVideoElement();
    watchVideoSource();
    pushUIState(); refreshOverlayTarget();
    if (S.panel) { const mount = document.querySelector('#below'); if (mount) S.panel.ensureMounted(mount); }
  }
  function detachVideo() {
    for (const [el, ev, fn] of S.videoListeners) el.removeEventListener(ev, fn);
    S.videoListeners = [];
    if (S.heartbeat) { clearInterval(S.heartbeat); S.heartbeat = null; }
  }
  /**
   * YouTube can move playback to another <video> element (it keeps a second one for the next
   * video of a playlist). Sync, listeners and the volume shadow have to follow it, or the engine
   * keeps taking its clock from an element that has gone idle.
   */
  function watchVideoElement() {
    const v = mainVideo();
    if (!v || v === S.video) { S.pendingVideo = null; return; }
    // two heartbeats of stability: a page mid re-render must not flap the takeover back and forth
    if (v !== S.pendingVideo) { S.pendingVideo = v; S.pendingVideoTicks = 0; return; }
    if (++S.pendingVideoTicks < 2) return;
    S.pendingVideo = null;
    log('the player moved to another <video> element; following it');
    setTakeover(false);
    S.video = v;
    attachVideo(v);
    cmdHook({ t: 'shadow' });
    sendSync('element');
  }
  /**
   * The <video> is shared with ads, so its duration changes while one plays and comes back after.
   * A different duration that persists outside an ad means the session was opened against the
   * wrong length (a pre-roll that was running when it started): start over with the real one.
   * The same check catches a page switching its player to a worker-side MediaSource.
   */
  function watchVideoSource() {
    const v = S.video;
    if (!v || !S.port || S.adShowing) { S.durationMismatchTicks = 0; return; }
    if (mseInWorker(v)) { failSession(MSE_WORKER_MESSAGE); return; }
    const d = v.duration;
    if (!S.duration || !Number.isFinite(d) || d <= 0 || Math.abs(d - S.duration) <= 0.5) { S.durationMismatchTicks = 0; return; }
    if (++S.durationMismatchTicks < 3) return; // 1.5 s of disagreement, not a transient
    if (++S.durationRestarts > MAX_DURATION_RESTARTS) { failSession('The video length keeps changing (live streams are not supported).'); return; }
    log('video duration changed', S.duration, '->', d, 'outside an ad; restarting the session');
    stopSession();
    startSession();
  }
  function attachAdObserver() {
    detachAdObserver();
    const player = document.getElementById('movie_player');
    if (!player) return;
    const update = () => {
      // only a linear ad replaces the content's audio; overlay ads also set `ad-showing`
      const ad = player.classList.contains('ad-interrupting');
      if (ad !== S.adShowing) { S.adShowing = ad; sendSync('ad'); if (ad) setTakeover(false); }
    };
    update();
    S.adObserver = new MutationObserver(update);
    S.adObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
  }
  function detachAdObserver() {
    if (S.adObserver) { S.adObserver.disconnect(); S.adObserver = null; }
    S.adShowing = false;
  }
  function setTakeover(on) {
    if (on && (S.adShowing || !S.sessionActive)) on = false;
    if (S.takeover === on) return;
    S.takeover = on;
    cmdHook({ t: 'takeover', on });
  }

  // ---------------------------------------------------------------- hidden helper player
  // Stage 1: a hidden iframe embed inside this page. Stage 2 (if the iframe cannot play): a
  // temporary background tab with the same embed page, opened and closed by the service worker.
  // Starting the engine means creating the offscreen document, loading the separation model and
  // compiling its GPU pipelines, and allocating the track buffers -- all in the GPU and renderer
  // processes the player is using to start up. Doing that during the player's first seconds of
  // buffering is what makes YouTube offer its "Experiencing interruptions?" prompt, so we wait
  // for the player to settle first. Nothing is lost: the page-world hook retains the audio
  // appended meanwhile and flushes it the moment capture is switched on.
  const ENGINE_MIN_BUFFER_SECONDS = 8;
  const ENGINE_MAX_WAIT_MS = 25000;

  function playerSettled(v, minBuffer) {
    return globalThis.VRX.gate.playerSettled({
      readyState: v ? v.readyState : 0,
      paused: v ? v.paused : true,
      hasPlayed: !!v && (v.currentTime > 0 || (!!v.played && v.played.length > 0)),
      bufferedAhead: v ? bufferedAhead(v) : 0,
      adShowing: S.adShowing,
    }, minBuffer);
  }

  // The helper is a second copy of the same video downloading as fast as the connection allows.
  // Started while the real player is still filling its buffer, it competes for bandwidth and
  // YouTube puts up its "Experiencing interruptions?" toast. So it waits for a healthy buffer,
  // and steps aside whenever the real player stalls or its buffer runs low.
  const HELPER_MIN_BUFFER_SECONDS = 12;    // buffer the player must have before the helper starts
  const HELPER_LOW_BUFFER_SECONDS = 5;     // below this while playing, the helper stands aside before a stall happens
  const HELPER_RESUME_BUFFER_SECONDS = 8;  // and comes back once the player has this much again
  const HELPER_THROTTLE_MAX_MS = 30000;    // or after this long anyway, if the player is at least playing
  const HELPER_MAX_WAIT_MS = 45000;
  const HELPER_RESUME_AFTER_MS = 6000;
  const HELPER_RETRY_MS = 5 * 60 * 1000;   // after every kind of helper has failed, before the ladder is tried again

  function bufferedAhead(v) {
    try {
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= v.currentTime && v.buffered.end(i) > v.currentTime) return v.buffered.end(i) - v.currentTime;
      }
    } catch (e) { /* ignore */ }
    return 0;
  }
  function wantHelper() { S.helperWanted = true; if (S.helperGateSince == null) S.helperGateSince = Date.now(); maybeStartHelper(); }
  function helperGateOpen() {
    if (!S.video) return false;
    if (S.helperGateSince != null && Date.now() - S.helperGateSince > HELPER_MAX_WAIT_MS && !S.adShowing) return true;
    return playerSettled(S.video, HELPER_MIN_BUFFER_SECONDS);
  }
  function maybeStartHelper() {
    if (!S.helperWanted || S.helper || !S.sessionActive || !S.videoId) return;
    if (!helperGateOpen()) return;
    startHelper(0);
  }
  function throttleHelper(on, reason) {
    if (S.helperThrottled === on) return;
    S.helperThrottled = on;
    if (on) S.helperThrottledAt = Date.now();
    sendToEngine({ type: 'throttle', on });
    log('helper', on ? 'paused: ' + reason : 'resumed');
  }
  function onMainStall() {
    S.lastStallAt = Date.now();
    if (S.helper) throttleHelper(true, 'the video is rebuffering');
    else if (S.helperWanted) S.helperGateSince = Date.now(); // hold the gate shut a while longer
  }
  function updateHelperThrottle() {
    const v = S.video;
    if (!v) return;
    if (!S.helperThrottled) {
      // a shrinking buffer is the stall before it happens
      const nearEnd = Number.isFinite(v.duration) && v.duration - v.currentTime <= HELPER_LOW_BUFFER_SECONDS * 2;
      if (S.helper && isPlaying(v) && !nearEnd && bufferedAhead(v) < HELPER_LOW_BUFFER_SECONDS) { S.lastStallAt = Date.now(); throttleHelper(true, 'the video buffer is running low'); }
      return;
    }
    // Resume below the start threshold, and after a while regardless: a player that keeps only a
    // small buffer would otherwise leave the helper paused for good, and the fetch stuck with it.
    const settled = Date.now() - S.lastStallAt > HELPER_RESUME_AFTER_MS;
    const longEnough = Date.now() - S.helperThrottledAt > HELPER_THROTTLE_MAX_MS && v.readyState >= 3 && !v.seeking;
    if ((settled && (v.paused || (v.readyState >= 3 && bufferedAhead(v) >= HELPER_RESUME_BUFFER_SECONDS))) || longEnough) throttleHelper(false);
  }

  // Stage 1 is YouTube's privacy-enhanced embed domain: it carries none of the account's cookies,
  // so whatever its hidden player does -- the ads it is served, muted and unseen -- is not written
  // up against the account. The stages that follow use the account and only run when it cannot play.
  const HELPER_STAGES = ['embed-nocookie', 'embed-iframe', 'watch-iframe', 'watch-tab'];
  function helperUrl(kind) {
    if (kind === 'embed-nocookie' || kind === 'embed-iframe') {
      const host = kind === 'embed-nocookie' ? 'www.youtube-nocookie.com' : 'www.youtube.com';
      const url = new URL(`https://${host}/embed/${encodeURIComponent(S.videoId)}`);
      url.search = new URLSearchParams({ autoplay: '1', mute: '1', controls: '0', origin: location.origin }).toString();
      url.hash = 'vrx-helper';
      return url.toString();
    }
    const url = new URL('https://www.youtube.com/watch');
    url.search = new URLSearchParams({ v: S.videoId }).toString();
    url.hash = 'vrx-helper';
    return url.toString();
  }
  function startHelper(stage = 0) {
    if (S.helper || !S.sessionActive || !S.videoId) return;
    const kind = HELPER_STAGES[stage];
    if (!kind) return;
    if (kind === 'watch-tab') { startHelperTab(stage); return; }
    S.qualityPrefBefore = readQualityPref(); // what to put back if the helper's player changes it
    const iframe = document.createElement('iframe');
    iframe.className = 'vrx-helper-embed';
    iframe.name = 'vrx-helper';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    iframe.allow = 'autoplay';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    // same-origin so it plays with your cookies, but no top-navigation: a frame-busting page cannot hijack this tab
    iframe.sandbox = 'allow-scripts allow-same-origin';
    iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:640px;height:360px;opacity:0.01;pointer-events:none;border:0;';
    iframe.src = helperUrl(kind);
    iframe.addEventListener('load', () => log('helper', kind, 'iframe load event'));
    (document.body || document.documentElement).appendChild(iframe);
    S.helper = { kind, stage, el: iframe, tabId: null, started: Date.now(), alive: false, progress: false, lastProgress: Date.now(), dom: null };
    S.helperWatchdog = setInterval(checkHelper, 2000);
    sendToEngine({ type: 'embed-started', kind });
    log('helper', kind, 'started');
  }
  async function startHelperTab(stage) {
    if (!S.sessionActive || !S.videoId || S.helper) return;
    const kind = 'watch-tab';
    S.qualityPrefBefore = readQualityPref();
    S.helper = { kind, stage, el: null, tabId: null, started: Date.now(), alive: false, progress: false, lastProgress: Date.now(), dom: null, opening: true };
    let res = null;
    try { res = await chrome.runtime.sendMessage({ type: 'open-helper', url: helperUrl(kind) }); } catch (e) { res = { ok: false, error: String(e) }; }
    if (!S.helper || S.helper.kind !== kind) { if (res && res.ok) chrome.runtime.sendMessage({ type: 'close-helper', tabId: res.tabId }).catch(() => {}); return; }
    if (!res || !res.ok) { S.helper = null; sendToEngine({ type: 'embed-failed', reason: 'background tab could not be opened' }); return; }
    S.helper.tabId = res.tabId; S.helper.opening = false; S.helper.started = Date.now();
    S.helperWatchdog = setInterval(checkHelper, 2000);
    sendToEngine({ type: 'embed-started', kind });
    log('helper background tab started', res.tabId);
  }
  // Progress here means captured audio reaching the engine (or an ad running its course), never
  // a mere sign of life: a helper whose player is alive but fetching nothing is stuck and is
  // replaced like any other.
  function checkHelper() {
    const h = S.helper;
    if (!h) return;
    const now = Date.now();
    if (h.opening) { if (now - h.started > 15000) failHelper('the background tab did not open'); return; }
    if (S.helperThrottled) { h.started = now; h.lastProgress = now; return; } // idle by our own request
    if (h.ended) return; // nothing more to deliver; capture-complete removes it once decoding is done
    if (!h.alive && now - h.started > 15000) return failHelper('the helper player page never loaded');
    if (h.alive && !h.progress && now - h.started > 30000) return failHelper('the helper player did not start' + (h.dom ? ' (' + describeDom(h.dom) + ')' : ''));
    if (h.progress && now - h.lastProgress > 45000) return failHelper('the helper player stopped delivering audio');
  }
  function describeDom(d) {
    if (!d) return '';
    if (d.error) return d.error;
    return `player ${d.hasPlayer ? 'present' : 'missing'}, page "${(d.title || '').slice(0, 40)}", text "${(d.text || '').slice(0, 60)}"`;
  }
  function failHelper(reason) {
    const h = S.helper;
    if (!h) return;
    log('helper', h.kind, 'failed:', reason);
    removeHelper();
    S.helperFailures = (S.helperFailures || []).concat(`${h.kind}: ${reason}`);
    if (h.stage + 1 < HELPER_STAGES.length) { startHelper(h.stage + 1); return; }
    // Every kind of helper failed. Wanting one still would restart the ladder on the next heartbeat,
    // opening and closing a background tab every couple of minutes; wait a good while instead.
    S.helperWanted = false; S.helperRetryAt = Date.now() + HELPER_RETRY_MS;
    sendToEngine({ type: 'embed-failed', reason: S.helperFailures.join(' · ') });
  }
  function removeHelper() {
    if (S.helperWatchdog) { clearInterval(S.helperWatchdog); S.helperWatchdog = null; }
    if (S.helperThrottled) { S.helperThrottled = false; sendToEngine({ type: 'throttle', on: false }); }
    const h = S.helper;
    S.helper = null;
    if (!h) return;
    if (h.el) h.el.remove();
    if (h.tabId != null) chrome.runtime.sendMessage({ type: 'close-helper', tabId: h.tabId }).catch(() => {});
  }
  document.addEventListener('securitypolicyviolation', (e) => {
    if (S.helper && S.helper.el && /youtube(-nocookie)?\.com/.test(e.blockedURI || '')) failHelper('the page blocked the helper iframe (' + e.violatedDirective + ')');
  });
  window.addEventListener('pagehide', () => { removeHelper(); });

  // ---------------------------------------------------------------- navigation
  let lastHref = null;
  async function onLocationMaybeChanged() {
    if (location.href === lastHref) {
      // the panel's mount point can appear well after navigation on a slow load
      if (currentVideoId() && !S.panel) mountUI();
      return;
    }
    lastHref = location.href;
    const videoId = currentVideoId();
    if (!videoId) { if (S.sessionActive) stopSession(); if (S.panel) { S.panel.destroy(); S.panel = null; } if (S.overlay) { S.overlay.destroy(); S.overlay = null; S.overlayBar = null; } S.videoId = null; return; }
    if (videoId !== S.videoId) {
      if (S.sessionActive) stopSession();
      pendingClear();
      S.videoId = videoId; S.duration = null; S.engineState = null; S.durationRestarts = 0;
    }
    // arm the page-world hook as early as possible: it then keeps the start of the audio while
    // the engine waits for the player to settle
    cmdHook({ t: 'arm', on: !!S.settings.enabled });
    cmdHook({ t: 'capture', on: !!S.settings.enabled });
    await mountUI();
    if (S.settings.enabled && !S.sessionActive) startSession();
  }

  async function init() {
    await loadSettings();
    repairQualityPreference();
    // Arm the page-world hook before waiting for anything else. YouTube can append the stream's
    // first segments -- the ones carrying the codec headers -- before DOMContentLoaded, and a
    // stream captured without them can never be decoded, which showed up as a permanent 0%.
    cmdHook({ t: 'arm', on: !!S.settings.enabled && !!currentVideoId() });
    cmdHook({ t: 'capture', on: !!S.settings.enabled && !!currentVideoId() });
    // The moment a navigation begins, the session for the video being left ends: YouTube may
    // start the next video in the same element within the same second, and a session still
    // attached would take its clock from the new video and play the old one's audio over it.
    document.addEventListener('yt-navigate-start', () => { if (S.sessionActive) { log('navigation started; ending the session'); stopSession(); } }, true);
    document.addEventListener('yt-navigate-finish', () => { onLocationMaybeChanged(); }, true);
    document.addEventListener('yt-page-data-updated', () => { onLocationMaybeChanged(); }, true);
    setInterval(onLocationMaybeChanged, 1000);
    if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
    onLocationMaybeChanged();
  }

  init().catch((e) => log('init failed', e));
})();
