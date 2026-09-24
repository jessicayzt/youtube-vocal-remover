// MAIN-world content script (runs in the page's JavaScript world, all youtube.com frames).
// Responsibilities that need page-world access:
//  1. Capture the encoded audio segments YouTube's player appends to its MediaSource
//     (SourceBuffer.appendBuffer). This works for both classic and SABR streaming because
//     the player always feeds MSE. Bytes are copied and handed to the isolated-world
//     content script via window.postMessage.
//  2. "Take over" the main video's audio without confusing YouTube's own volume UI:
//     the element's volume/muted properties are shadowed so the player keeps seeing (and
//     controlling) its own values while the real output is silenced.
//  3. In our hidden helper embed (…/embed/ID#vrx-helper) drive the player: muted, lowest
//     quality, seeking ahead whenever its buffer is full, so the whole audio track gets fetched
//     quickly without the player ever running dry.
(() => {
  if (window.__vrxHookInstalled) return;
  window.__vrxHookInstalled = true;

  // Our helper players (hidden iframe or background tab, /embed/ or /watch page) are marked with #vrx-helper
  // in the URL fragment (never sent to YouTube) or a window name, so YouTube sees an ordinary URL.
  const isOurEmbed = /(^|[#&])vrx-helper(=|&|$)/.test(location.hash) || window.name === 'vrx-helper';
  // The first appends on a stream carry the codec headers; without them nothing that follows can
  // be decoded. YouTube can append them before the extension's other scripts have even run, so
  // the hook always keeps a little from the start of every audio stream, and keeps much more
  // once the controller arms it (the controller delays capture until the player has settled).
  const RETAIN_IDLE_BYTES = 2 * 1024 * 1024;
  const RETAIN_IDLE_APPENDS = 16;
  const RETAIN_ARMED_BYTES = 12 * 1024 * 1024;
  const RETAIN_ARMED_APPENDS = 120;
  // The stream's first appends (where the headers are) are also kept for the life of the page, so
  // an engine that starts a fresh store for a stream that has long been playing -- after a restart
  // of the engine, or of the session -- still gets what it needs to decode the rest.
  const HEAD_MAX_BYTES = 1024 * 1024;
  const HEAD_MAX_APPENDS = 4;

  let captureEnabled = isOurEmbed;
  let armed = isOurEmbed; // the feature is on for this video, so keep much more of the stream
  const post = (msg, transfer) => {
    try { window.postMessage(Object.assign({ __vrx: true }, msg), location.origin, transfer || []); } catch (e) { /* ignore */ }
  };
  // `ad-showing` is also set for overlay and banner ads, which sit on top of the content while
  // the content itself keeps playing. Only `ad-interrupting` means the audio right now belongs
  // to an ad rather than to the video.
  const adPlaying = () => {
    const p = document.getElementById('movie_player');
    return !!(p && p.classList.contains('ad-interrupting'));
  };

  // ------------------------------------------------------------------ MSE capture
  let msCounter = 0;
  const msInfo = new WeakMap();   // MediaSource -> { id, sbCount }
  const sbInfo = new WeakMap();   // SourceBuffer -> info
  const liveBuffers = [];         // WeakRef<SourceBuffer>[] so retained data can be flushed on enable

  function toBytes(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    return null;
  }

  // Per audio SourceBuffer (info):
  //   appends   running count; every kept append remembers its index i
  //   head      { i, bytes, ad, msDuration } of the first appends of the *current media* in this
  //             buffer: that is where the codec headers are, and an engine that starts a fresh
  //             store for a stream that has long been playing (the engine or the session
  //             restarted) needs them again
  //   retained  { i, bytes, ad, msDuration } appended while capture is off, in order, with null
  //             marking an abort()/changeType() between them (the player's parser was reset there,
  //             so ours must be too; the headers stay valid across it and are kept)
  //   dropped   appends were lost to the budget after what is retained
  //   sent      something of the current media has been sent already
  //
  // "Current media": YouTube reuses a MediaSource and its SourceBuffers for the next video of a
  // playlist (the one it preloaded). The new video begins with a new initialization segment; from
  // that append on, everything kept before it belongs to the previous video and is let go. Keeping
  // it put the previous video's first seconds at the start of the next one.

  // Does this append begin an initialization segment? WebM: the EBML header. MP4: an ftyp or moov
  // box. Media segments begin with a Cluster (WebM) or moof/styp/sidx (MP4).
  function startsWithInit(bytes) {
    if (bytes.length < 8) return false;
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true;
    const t = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    return t === 'ftyp' || t === 'moov';
  }

  // The head's own init (its first entry, when that append began with one) against a new one: the
  // first bytes carry the container's duration and track identity, so a different media differs early.
  function sameInit(info, view) {
    const prev = info.head.length && startsWithInit(info.head[0].bytes) ? info.head[0].bytes : null;
    if (!prev) return false;
    const n = Math.min(256, prev.length, view.length);
    if (n < 8) return false;
    for (let k = 0; k < n; k++) if (prev[k] !== view[k]) return false;
    return true;
  }

  function msDurationNow(info) {
    try { return info.ms.duration; } catch (e) { return NaN; }
  }

  // `ad` and `msDuration` are the player's state when the bytes were appended, not when they are
  // sent: kept data flushed during an ad is not ad audio, and a head that belonged to another
  // media must carry that media's length, so the engine can tell it apart.
  function sendSegment(info, entry, retained) {
    const bytes = entry.bytes;
    let tsOffset = 0;
    try { tsOffset = info.sb.timestampOffset || 0; } catch (e) { /* removed buffers throw */ }
    // the head keeps its copy for the life of the page: hand over a duplicate of anything it holds
    const buf = info.head.some((h) => h.bytes === bytes) ? bytes.slice().buffer : bytes.buffer;
    post({ t: 'seg', key: info.key, mime: info.mime, tsOffset, msDuration: entry.msDuration, ad: !!entry.ad, retained: !!retained, buf }, [buf]);
    info.sent = true;
  }

  function retainBudget() { return armed ? [RETAIN_ARMED_APPENDS, RETAIN_ARMED_BYTES] : [RETAIN_IDLE_APPENDS, RETAIN_IDLE_BYTES]; }

  function retainReset(info) {
    if (info.retained.length ? info.retained[info.retained.length - 1] === null : !info.sent) return; // already marked, or nothing before it
    if (info.retained.length >= retainBudget()[0]) { info.dropped = true; return; }
    info.retained.push(null);
  }

  // Drops the newest retained data first: the start of the stream is what must be kept, because
  // that is where the codec headers are.
  function trimRetained(info) {
    const [maxAppends, maxBytes] = retainBudget();
    while (info.retained.length > maxAppends || info.retainedBytes > maxBytes) {
      const dropped = info.retained.pop();
      if (dropped === undefined) break;
      if (dropped) info.retainedBytes -= dropped.bytes.byteLength;
      info.dropped = true;
    }
  }

  /**
   * Re-sends the stream's start ahead of whatever follows it (the retained appends, or the live
   * ones). Skipped while nothing of the stream has been sent yet, unless forced: what is retained
   * or about to go live then begins at the start anyway. Only the head appends that the retained
   * data does not already carry go out, and the parser is told about the hole between the head and
   * what follows only when there is one.
   */
  function sendHead(info, force) {
    if (!info.head.length || (!force && !info.sent)) return;
    const firstRetained = info.retained.find((r) => r !== null);
    const nextIndex = firstRetained ? firstRetained.i : info.appends;
    let last = -1;
    for (const h of info.head) { if (h.i >= nextIndex) break; sendSegment(info, h, true); last = h.i; }
    if (last >= 0 && last + 1 !== nextIndex) post({ t: 'discontinuity', key: info.key });
  }

  // A MediaSource YouTube has detached from the element (the previous video's, or an ad's) is
  // dead: nothing of it may be sent, least of all its headers. Replaying the previous video's
  // stream start into the next video's session put the previous video's audio at its beginning.
  function msOpen(info) {
    try { return info.ms.readyState !== 'closed'; } catch (e) { return false; }
  }

  function flushRetained(info) {
    const items = info.retained, dropped = info.dropped;
    info.retained = []; info.retainedBytes = 0; info.dropped = false;
    if (!msOpen(info)) return;
    for (const item of items) {
      if (item === null) post({ t: 'sb-reset', key: info.key, mime: info.mime });
      else sendSegment(info, item, true);
    }
    // Only a real hole needs the parser told. Kept appends that run straight into the live ones
    // are one contiguous byte stream, and a reset there would throw away a unit split across it.
    if (dropped) post({ t: 'discontinuity', key: info.key });
  }

  const origAddSB = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = origAddSB.call(this, mime);
    try {
      let mi = msInfo.get(this);
      if (!mi) { mi = { id: ++msCounter, sbCount: 0 }; msInfo.set(this, mi); }
      const info = {
        key: `${mi.id}:${mi.sbCount++}`, mime: String(mime), ms: this, sb, isAudio: /audio/i.test(String(mime)),
        appends: 0, head: [], headBytes: 0, retained: [], retainedBytes: 0, dropped: false, sent: false,
      };
      sbInfo.set(sb, info);
      liveBuffers.push(new WeakRef(sb));
      if (liveBuffers.length > 64) liveBuffers.splice(0, liveBuffers.length - 64);
      if (info.isAudio && captureEnabled) post({ t: 'sb-new', key: info.key, mime: info.mime });
    } catch (e) { /* never break the player */ }
    return sb;
  };

  const origAppend = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    const result = origAppend.call(this, data);
    try {
      const info = sbInfo.get(this);
      if (info && info.isAudio) {
        const i = info.appends++;
        // A new initialization segment starts a new media in this buffer (the next video of a
        // playlist, or a format change): what was kept for the previous one is dropped, unsent, so
        // its audio cannot reach the new video's session. The engine is told the stream restarted.
        // The same init sent again (a format re-announced after a seek) is the same media.
        const view = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
        if (view && startsWithInit(view) && (info.head.length || info.retained.length || info.sent) && !sameInit(info, view)) {
          info.head = []; info.headBytes = 0;
          info.retained = []; info.retainedBytes = 0; info.dropped = false;
          info.sent = false;
          if (captureEnabled) post({ t: 'sb-reset', key: info.key, mime: info.mime });
        }
        const [maxAppends, maxBytes] = retainBudget();
        const wantHead = info.head.length < HEAD_MAX_APPENDS && info.headBytes < HEAD_MAX_BYTES;
        const canRetain = !captureEnabled && info.retained.length < maxAppends && info.retainedBytes < maxBytes;
        if (!captureEnabled && !canRetain) info.dropped = true;
        // Once nothing wants the bytes we stop copying entirely rather than copy and discard, so
        // an append costs the player nothing.
        const bytes = captureEnabled || canRetain || wantHead ? toBytes(data) : null;
        if (bytes) {
          const entry = { i, bytes, ad: adPlaying(), msDuration: msDurationNow(info) };
          if (wantHead) { info.head.push(entry); info.headBytes += bytes.byteLength; }
          if (captureEnabled) {
            if (info.retained.length || info.dropped) flushRetained(info); // a buffer setCapture() did not reach
            sendSegment(info, entry, false);
          } else if (canRetain) { info.retained.push(entry); info.retainedBytes += bytes.byteLength; }
        }
      }
    } catch (e) { /* never break the player */ }
    return result;
  };

  const resetHook = (name) => {
    const orig = SourceBuffer.prototype[name];
    if (typeof orig !== 'function') return;
    SourceBuffer.prototype[name] = function (...args) {
      const result = orig.apply(this, args);
      try {
        const info = sbInfo.get(this);
        if (info) {
          if (name === 'changeType') { info.mime = String(args[0]); info.isAudio = /audio/i.test(info.mime); info.head = []; info.headBytes = 0; } // a new codec: new headers follow
          if (!info.isAudio) { info.retained = []; info.retainedBytes = 0; info.dropped = false; }
          else if (captureEnabled) {
            if (info.retained.length || info.dropped) flushRetained(info);
            post({ t: 'sb-reset', key: info.key, mime: info.mime });
          } else retainReset(info); // kept data stays: the headers at the stream's start are still valid
        }
      } catch (e) { /* ignore */ }
      return result;
    };
  };
  resetHook('abort');
  resetHook('changeType');

  function setCapture(on) {
    if (on === captureEnabled) return;
    captureEnabled = on;
    if (!on) return;
    for (const ref of liveBuffers) {
      const sb = ref.deref();
      const info = sb && sbInfo.get(sb);
      if (!info || !info.isAudio || !msOpen(info)) continue;
      post({ t: 'sb-new', key: info.key, mime: info.mime });
      sendHead(info, false);
      flushRetained(info);
    }
  }

  /** The engine has a fresh store for this page's streams: every stream starts over from its headers. */
  function resendHeads() {
    for (const ref of liveBuffers) {
      const sb = ref.deref();
      const info = sb && sbInfo.get(sb);
      if (!info || !info.isAudio || !msOpen(info)) continue;
      post({ t: 'sb-new', key: info.key, mime: info.mime });
      sendHead(info, true);
    }
  }

  // ------------------------------------------------------------------ audio takeover (main video)
  const volDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  const mutedDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
  let takeover = false;
  let helperThrottled = false; // set by the controller while the real player is rebuffering
  let applyingVolume = false; // guards the volumechange our own writes trigger
  let shadowed = null; // { video, volume, muted }

  function reportVolume() {
    if (shadowed) post({ t: 'vol', volume: shadowed.volume, muted: shadowed.muted });
  }
  // The element YouTube is playing in. It marks it html5-main-video; a page can hold a second,
  // preloading element, and a selector list would return whichever comes first in the document.
  function mainVideo() {
    return document.querySelector('#movie_player video.html5-main-video') || document.querySelector('#movie_player video') || document.querySelector('video.html5-main-video') || document.querySelector('video');
  }
  function installShadow(video) {
    if (!video || (shadowed && shadowed.video === video)) return;
    if (shadowed) removeShadow();
    shadowed = { video, volume: volDesc.get.call(video), muted: mutedDesc.get.call(video) };
    Object.defineProperty(video, 'volume', {
      configurable: true,
      get() { return shadowed && shadowed.video === video ? shadowed.volume : volDesc.get.call(video); },
      set(v) {
        if (shadowed && shadowed.video === video) {
          shadowed.volume = Math.min(1, Math.max(0, Number(v)));
          if (!takeover) { try { applyingVolume = true; volDesc.set.call(video, shadowed.volume); } finally { applyingVolume = false; } }
          reportVolume();
        } else volDesc.set.call(video, v);
      },
    });
    Object.defineProperty(video, 'muted', {
      configurable: true,
      get() { return shadowed && shadowed.video === video ? shadowed.muted : mutedDesc.get.call(video); },
      set(v) {
        if (shadowed && shadowed.video === video) {
          shadowed.muted = !!v;
          if (!takeover) { try { applyingVolume = true; mutedDesc.set.call(video, shadowed.muted); } finally { applyingVolume = false; } }
          reportVolume();
        } else mutedDesc.set.call(video, v);
      },
    });
    reportVolume();
  }
  function removeShadow() {
    if (!shadowed) return;
    const { video, volume, muted } = shadowed;
    try { delete video.volume; delete video.muted; } catch (e) { /* ignore */ }
    try { volDesc.set.call(video, volume); mutedDesc.set.call(video, muted); } catch (e) { /* ignore */ }
    shadowed = null;
  }
  function setTakeover(on) {
    takeover = !!on;
    if (!shadowed) return;
    const { video, volume, muted } = shadowed;
    try {
      applyingVolume = true;
      if (takeover) volDesc.set.call(video, 0);
      else { volDesc.set.call(video, volume); mutedDesc.set.call(video, muted); }
    } catch (e) { /* ignore */ } finally { applyingVolume = false; }
    // the engine's output gain follows the user's volume, so re-state it whenever we take over
    reportVolume();
  }

  // Only this world can tell the user's volume from the zero we impose while we play instead of
  // the page: the shadow above is invisible to the extension's isolated world, which would read
  // the muted element and report silence. So volume reporting lives here and nowhere else.
  document.addEventListener('volumechange', (e) => {
    if (!shadowed || e.target !== shadowed.video || applyingVolume) return;
    if (takeover) {
      // something (the page, another extension) changed the element while we own the audio
      const real = volDesc.get.call(shadowed.video);
      if (real !== 0) { try { applyingVolume = true; volDesc.set.call(shadowed.video, 0); } catch (err) { /* ignore */ } finally { applyingVolume = false; } }
    } else {
      shadowed.volume = volDesc.get.call(shadowed.video);
      shadowed.muted = mutedDesc.get.call(shadowed.video);
    }
    reportVolume();
  }, true);

  // ------------------------------------------------------------------ commands from the isolated world
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__vrxCmd !== true) return;
    const m = e.data;
    try {
      if (m.t === 'capture') setCapture(!!m.on);
      else if (m.t === 'heads') resendHeads();
      else if (m.t === 'arm') {
        armed = !!m.on;
        // shrinking back to the idle budget keeps the stream's start, which is the valuable part
        if (!armed) for (const ref of liveBuffers) { const sb = ref.deref(); const info = sb && sbInfo.get(sb); if (info) trimRetained(info); }
      }
      else if (m.t === 'throttle') helperThrottled = !!m.on;
      else if (m.t === 'shadow') installShadow(mainVideo());
      else if (m.t === 'unshadow') { setTakeover(false); removeShadow(); }
      else if (m.t === 'takeover') { if (m.on && !shadowed) installShadow(mainVideo()); setTakeover(!!m.on); }
      else if (m.t === 'ping') {
        // which video the player itself is on, and how long it says it is: after a navigation the
        // element still holds the previous video for a while, and its duration with it
        const player = document.getElementById('movie_player');
        let videoId = null, duration = NaN;
        try { const d = player && typeof player.getVideoData === 'function' ? player.getVideoData() : null; videoId = d && d.video_id ? String(d.video_id) : null; } catch (err) { /* ignore */ }
        try { duration = player && typeof player.getDuration === 'function' ? Number(player.getDuration()) : NaN; } catch (err) { /* ignore */ }
        post({ t: 'pong', capture: captureEnabled, takeover, shadowed: !!shadowed, videoId, duration });
      }
    } catch (err) { post({ t: 'hook-error', message: String(err) }); }
  });

  // ------------------------------------------------------------------ hidden helper embed driver
  if (isOurEmbed) {
    let qualitySet = false, lastErrorText = '', started = Date.now(), lastDom = 0, kicks = 0;
    const errorText = () => {
      // only visible error panels count (the templates keep hidden containers around)
      for (const el of document.querySelectorAll('.ytp-error, #player-unavailable, .player-unavailable, .ytp-embed-error')) {
        if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
        const text = (el.textContent || '').replace(/\s+/g, ' ').replace(/Tap to unmute/gi, '').trim();
        if (!text) continue;
        return text.slice(0, 200);
      }
      return '';
    };
    // The helper fetches the track by *seeking*, not by playing fast. Playing at 16x drained the
    // player's buffer far faster than YouTube's server-paced delivery refilled it, so the helper
    // rebuffered over and over -- real "interruptions", logged against the account, which is what
    // YouTube's "Experiencing interruptions?" prompt reports, even later with the feature off.
    // At normal speed the player fills its buffer target and stops; the moment it stops growing,
    // the playhead is moved up to within SEEK_KEEP_SECONDS of the buffered end, and the player
    // fetches the next stretch. Its buffer health never looks poor and it never stalls.
    // The runway kept after a seek is small on purpose: YouTube's player may hold as little as
    // twenty seconds ahead of the playhead, and a helper that waited for more than that never
    // seeked at all, fetching the whole video at playback speed instead.
    const SEEK_KEEP_SECONDS = 3;      // runway kept ahead of the playhead after a seek
    const SEEK_MIN_GAIN_SECONDS = 2;  // a seek that would gain less than this is not worth it
    const BUFFER_STILL_MS = 800;      // the buffered end has not moved for this long: the player is done fetching
    let finished = false, fetchedTo = 0, lastEnd = -1, endStillSince = 0, lastSeekAt = 0, lastSkipAt = 0;
    // YouTube keeps the quality a player was set to in the origin's localStorage (yt-player-quality)
    // and applies it to the next video loaded from that origin. On www.youtube.com this helper
    // shares that storage with the page the person is watching, so asking for the lowest video
    // quality here made every later video of theirs start at 144p. Whatever the preference was
    // before the request is put back the moment it changes.
    const QUALITY_KEYS = ['yt-player-quality'];
    let qualityBefore = null; // key -> value (null when absent), taken before the player was touched
    const readQuality = () => { const m = new Map(); for (const k of QUALITY_KEYS) { try { m.set(k, localStorage.getItem(k)); } catch (e) { m.set(k, null); } } return m; };
    const restoreQuality = () => {
      if (!qualityBefore) return;
      for (const [k, v] of qualityBefore) {
        try { if (localStorage.getItem(k) !== v) { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } } catch (e) { /* storage unavailable */ }
      }
    };
    const bufferedEndAt = (video, t) => {
      try {
        for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= t + 0.5 && video.buffered.end(i) >= t) return video.buffered.end(i);
      } catch (e) { /* ignore */ }
      return null;
    };
    const drive = () => {
      const player = document.getElementById('movie_player');
      const video = (player && player.querySelector('video')) || document.querySelector('video');
      const inAd = adPlaying();
      if (inAd && Date.now() - lastSkipAt > 1000) {
        // skip the ad as soon as the player allows, as a viewer would; an ad left half-played is an
        // interrupted ad in YouTube's books
        lastSkipAt = Date.now();
        for (const btn of document.querySelectorAll('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern')) {
          if (btn.offsetWidth > 0 && btn.offsetHeight > 0) { try { btn.click(); } catch (e) { /* ignore */ } break; }
        }
      }
      if (finished || (helperThrottled && !inAd)) {
        // finished: the track is captured, stop YouTube autoplaying the next video.
        // throttled: the real player is struggling, so stop competing with it for bandwidth
        // (an ad, small and short, is left to finish).
        if (video && !video.paused) { try { video.pause(); } catch (e) { /* ignore */ } }
        return;
      }
      if (player) {
        // the helper only exists to pull the audio track down, so ask for the cheapest video:
        // it is the video streams that would otherwise compete with the real player for bandwidth
        try {
          if (!qualitySet && typeof player.setPlaybackQualityRange === 'function') {
            qualityBefore = readQuality();
            player.setPlaybackQualityRange('tiny', 'tiny');
            qualitySet = true;
          }
        } catch (e) { /* ignore */ }
        restoreQuality();
        try { if (typeof player.mute === 'function' && !player.isMuted?.()) player.mute(); } catch (e) { /* ignore */ }
      }
      const err = errorText();
      if (err && err !== lastErrorText) {
        lastErrorText = err;
        post({ t: 'embed', event: 'error', message: err });
      }
      if (video) {
        try { mutedDesc.set.call(video, true); volDesc.set.call(video, 0); } catch (e) { /* ignore */ }
        if (video.paused && !video.ended && video.readyState >= 1) video.play().catch(() => {});
        if (video.paused && !video.ended && Date.now() - started > 2000 && kicks < 20) {
          // no autoplay: poke the player like a click would
          kicks++;
          try { if (player && typeof player.playVideo === 'function') player.playVideo(); } catch (e) { /* ignore */ }
          const btn = document.querySelector('.ytp-large-play-button, .ytp-play-button');
          if (btn) { try { btn.click(); } catch (e) { /* ignore */ } }
        }
        const buffered = [];
        try { for (let i = 0; i < video.buffered.length; i++) buffered.push([video.buffered.start(i), video.buffered.end(i)]); } catch (e) { /* ignore */ }
        const ad = inAd;
        const duration = video.duration;
        const end = ad ? null : bufferedEndAt(video, video.currentTime);
        if (end !== null) {
          if (end > fetchedTo) fetchedTo = end;
          const now = Date.now();
          if (end !== lastEnd) { lastEnd = end; endStillSince = now; }
          const stillFor = now - endStillSince;
          const runway = end - video.currentTime;
          if (stillFor >= BUFFER_STILL_MS && runway >= SEEK_KEEP_SECONDS + SEEK_MIN_GAIN_SECONDS && now - lastSeekAt > 1000
              && Number.isFinite(duration) && end < duration - 0.5) {
            lastSeekAt = now;
            try { video.currentTime = end - SEEK_KEEP_SECONDS; } catch (e) { /* ignore */ }
          }
        }
        // the whole track is buffered (so captured), or the player reached the end on its own
        const complete = !ad && Number.isFinite(duration) && duration > 0 && (fetchedTo >= duration - 0.5 || video.ended);
        post({ t: 'embed', event: complete ? 'ended' : 'progress', currentTime: video.currentTime, duration, buffered, fetchedTo, rate: video.playbackRate, paused: video.paused, readyState: video.readyState, ad, networkState: video.networkState });
        if (complete) { finished = true; try { if (player && typeof player.pauseVideo === 'function') player.pauseVideo(); } catch (e) { /* ignore */ } }
      } else {
        // no video element yet: try to start the player and report what the page looks like
        if (Date.now() - started > 2000 && kicks < 20) {
          kicks++;
          try { if (player && typeof player.playVideo === 'function') player.playVideo(); } catch (e) { /* ignore */ }
          const btn = document.querySelector('.ytp-large-play-button, .ytp-play-button, #movie_player');
          if (btn) { try { btn.click(); } catch (e) { /* ignore */ } }
        }
        if (Date.now() - lastDom > 3000) {
          lastDom = Date.now();
          const body = document.body ? (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160) : '';
          post({ t: 'embed', event: 'dom', hasPlayer: !!player, hasVideo: false, readyState: document.readyState, title: document.title, error: err, text: body, hidden: document.hidden, size: [window.innerWidth, window.innerHeight] });
        }
      }
    };
    setInterval(drive, 400);
    document.addEventListener('pause', (e) => {
      const v = e.target;
      if (v && v.tagName === 'VIDEO' && !v.ended && !finished && !helperThrottled) setTimeout(() => { if (v.paused && !v.ended && !finished && !helperThrottled) v.play().catch(() => {}); }, 200);
    }, true);
    post({ t: 'embed', event: 'alive', href: location.href, top: window === window.top, kind: location.pathname.startsWith('/embed/') ? 'embed' : 'watch' });
  }

  post({ t: 'hook-ready', embed: isOurEmbed });
})();
