// Runs the page-world hook (src/content/hook.js) inside a stub DOM to pin the audio-takeover
// contract. The subtle part: the hook shadows the <video> volume so YouTube's own UI keeps
// working while the real element is muted and we play instead. Only this world can tell the
// user's volume from the zero we impose, so it is the only place allowed to report volume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HOOK = readFileSync(new URL('../src/content/hook.js', import.meta.url), 'utf8');

const PRELUDE = (hash) => `
var __HASH = ${JSON.stringify(hash || '')};
globalThis.window = globalThis; globalThis.self = globalThis;
var __posted = [], __docL = {}, __winL = {};
window.name = '';
var location = { pathname: '/watch', search: '?v=abc', hash: __HASH, origin: 'https://www.youtube.com', href: 'https://www.youtube.com/watch?v=abc' + __HASH };
function __fire(type, target) { for (const f of (__docL[type] || [])) f({ type, target }); }
class HTMLMediaElement { constructor() { this._v = 1; this._m = false; this.tagName = 'VIDEO'; this.playbackRate = 1; this.paused = true; this.ended = false; this.readyState = 4; this.currentTime = 0; this.duration = 100; this.buffered = { length: 0 }; } play() { this.paused = false; return Promise.resolve(); } pause() { this.paused = true; } }
Object.defineProperty(HTMLMediaElement.prototype, 'volume', { configurable: true, get() { return this._v; }, set(v) { this._v = v; __fire('volumechange', this); } });
Object.defineProperty(HTMLMediaElement.prototype, 'muted', { configurable: true, get() { return this._m; }, set(v) { this._m = !!v; __fire('volumechange', this); } });
var __video = new HTMLMediaElement();
var __quality = null, __playerMuted = false, __adClasses = new Set();
var __player = {
  classList: { contains: (c) => __adClasses.has(c) }, querySelector: () => __video,
  setPlaybackQualityRange: (a, b) => { __quality = a + '/' + b; },
  mute: () => { __playerMuted = true; }, isMuted: () => __playerMuted,
  playVideo: () => __video.play(), pauseVideo: () => __video.pause(),
};
var localStorage = { _s: {}, getItem(k) { return k in this._s ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
var document = {
  addEventListener(t, f) { (__docL[t] = __docL[t] || []).push(f); }, removeEventListener() {},
  getElementById(id) { return id === 'movie_player' ? __player : null; },
  querySelector() { return __video; }, querySelectorAll() { return []; },
  readyState: 'complete', title: 'T', hidden: false, body: { innerText: '' },
};
window.addEventListener = (t, f) => { (__winL[t] = __winL[t] || []).push(f); };
window.postMessage = (msg) => { __posted.push(msg); };
var __intervals = [];
var setInterval = (f) => __intervals.push(f), clearInterval = () => {};
function __tick(n) { for (let i = 0; i < (n || 1); i++) for (const f of __intervals) f(); }
class SourceBuffer { constructor() { this.timestampOffset = 0; } appendBuffer() {} abort() {} changeType() {} }
class MediaSource { constructor() { this.duration = 300; this.readyState = 'open'; } addSourceBuffer() { return new SourceBuffer(); } }
function __kinds() { return __posted.map((p) => p.t); }
function __segBytes() { return __posted.filter((p) => p.t === 'seg').map((p) => Array.from(new Uint8Array(p.buf))); }
function __segAds() { return __posted.filter((p) => p.t === 'seg').map((p) => p.ad); }
function __cmd(o) { for (const f of (__winL['message'] || [])) f({ source: window, data: Object.assign({ __vrxCmd: true }, o) }); }
function __lastVol() { for (let i = __posted.length - 1; i >= 0; i--) if (__posted[i].t === 'vol') return __posted[i]; return null; }
`;

function world(hash) {
  const ctx = vm.createContext({ console, setTimeout, Promise });
  vm.runInContext(PRELUDE(hash), ctx);
  vm.runInContext(HOOK, ctx);
  return {
    run: (code) => vm.runInContext(code, ctx),
    tick: (n) => vm.runInContext(`__tick(${n || 1})`, ctx),
    quality: () => vm.runInContext('__quality', ctx),
    kinds: () => JSON.parse(vm.runInContext('JSON.stringify(__kinds())', ctx)),
    segBytes: () => JSON.parse(vm.runInContext('JSON.stringify(__segBytes())', ctx)),
    segAds: () => JSON.parse(vm.runInContext('JSON.stringify(__segAds())', ctx)),
    paused: () => vm.runInContext('__video.paused', ctx),
    rate: () => vm.runInContext('__video.playbackRate', ctx),
    cmd: (o) => vm.runInContext(`__cmd(${JSON.stringify(o)})`, ctx),
    lastVol: () => vm.runInContext('JSON.stringify(__lastVol())', ctx) && JSON.parse(vm.runInContext('JSON.stringify(__lastVol())', ctx)),
    realVolume: () => vm.runInContext('__video._v', ctx),
    realMuted: () => vm.runInContext('__video._m', ctx),
    seenVolume: () => vm.runInContext('__video.volume', ctx),
    embedEvents: () => JSON.parse(vm.runInContext('JSON.stringify(__posted.filter((p) => p.t === "embed").map((p) => p.event))', ctx)),
    currentTime: () => vm.runInContext('__video.currentTime', ctx),
  };
}

test('the hook installs a volume shadow and reports the user volume', () => {
  const w = world();
  w.cmd({ t: 'shadow' });
  assert.deepEqual(w.lastVol(), { __vrx: true, t: 'vol', volume: 1, muted: false });
  w.run('__video.volume = 0.8'); // YouTube's volume slider
  assert.equal(w.realVolume(), 0.8, 'not taken over: the element follows the user');
  assert.equal(w.lastVol().volume, 0.8);
});

// The regression: taking over mutes the element, which fires volumechange. Anything that reads
// the element at that moment sees 0. The reported volume must stay the user's.
test('taking over mutes the element but still reports the user volume', () => {
  const w = world();
  w.cmd({ t: 'shadow' });
  w.run('__video.volume = 0.8');
  w.cmd({ t: 'takeover', on: true });
  assert.equal(w.realVolume(), 0, 'the page is silenced');
  assert.equal(w.seenVolume(), 0.8, "YouTube's own UI still sees the user's volume");
  assert.equal(w.lastVol().volume, 0.8, 'the engine is told the user volume, not the imposed zero');
  assert.equal(w.lastVol().muted, false);
});

test('volume changes while taken over reach the engine and leave the page silent', () => {
  const w = world();
  w.cmd({ t: 'shadow' });
  w.cmd({ t: 'takeover', on: true });
  w.run('__video.volume = 0.4');
  assert.equal(w.realVolume(), 0, 'the page stays silent');
  assert.equal(w.lastVol().volume, 0.4, 'the engine follows the slider');
  w.run('__video.muted = true');
  assert.equal(w.lastVol().muted, true);
});

test('a stray volumechange from elsewhere cannot silence the engine', () => {
  const w = world();
  w.cmd({ t: 'shadow' });
  w.run('__video.volume = 0.7');
  w.cmd({ t: 'takeover', on: true });
  // something outside our shadow writes the element directly (another extension, the page)
  w.run('Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume").set.call(__video, 0.9)');
  assert.equal(w.realVolume(), 0, 'we re-assert silence on the page');
  assert.equal(w.lastVol().volume, 0.7, 'and keep reporting the user volume');
});

test('releasing takeover restores the page volume', () => {
  const w = world();
  w.cmd({ t: 'shadow' });
  w.run('__video.volume = 0.6');
  w.cmd({ t: 'takeover', on: true });
  assert.equal(w.realVolume(), 0);
  w.cmd({ t: 'takeover', on: false });
  assert.equal(w.realVolume(), 0.6, 'the page gets its audio back');
  assert.equal(w.lastVol().volume, 0.6);
  w.run('__video.volume = 0.3');
  assert.equal(w.realVolume(), 0.3, 'and follows the user again');
});

// Cross-world invariant that cannot be simulated here: content.js runs in the extension's
// isolated world, where the shadow above does not exist and `video.volume` is the raw element
// value -- 0 whenever we have taken the audio over. Reporting that value silenced our own
// output until the page happened to set the volume again (a reload). Only hook.js may report it.
test('the isolated-world content script never reports the element volume', () => {
  const src = readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
  const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const offenders = [...stripped.matchAll(/(?:video|v)\s*\.\s*(?:volume|muted)/g)].map((m) => m[0]);
  assert.deepEqual(offenders, [], `content.js must not read the element volume: ${offenders.join(', ')}`);
  assert.match(stripped, /m\.t === 'vol'[\s\S]{0,120}volume: m\.volume/, 'it forwards the page-world report instead');
});

// YouTube stores the quality a player was set to in the origin's localStorage and applies it to
// the next video from that origin. A helper on www.youtube.com shares it with the watched page.
test("the helper's quality request never becomes the person's saved preference", () => {
  const w = world('#vrx-helper');
  w.run(`
    localStorage.setItem('yt-player-quality', 'PREF-1080');
    __player.setPlaybackQualityRange = (a, b) => { __quality = a + '/' + b; localStorage.setItem('yt-player-quality', 'PREF-144'); };
  `);
  w.tick();
  assert.equal(w.quality(), 'tiny/tiny', 'the request itself is made');
  assert.equal(w.run("localStorage.getItem('yt-player-quality')"), 'PREF-1080', 'and the preference is back to what it was');
  w.run("localStorage.setItem('yt-player-quality', 'PREF-144')"); // the player writes it again later
  w.tick();
  assert.equal(w.run("localStorage.getItem('yt-player-quality')"), 'PREF-1080', 'every tick puts it back');
});

test("a page with no saved preference is left with none", () => {
  const w = world('#vrx-helper');
  w.run("__player.setPlaybackQualityRange = (a, b) => { __quality = a + '/' + b; localStorage.setItem('yt-player-quality', 'PREF-144'); };");
  w.tick();
  assert.equal(w.run("localStorage.getItem('yt-player-quality')"), null, 'removed, so quality stays automatic');
});

// The helper is a second copy of the same video. Everything here exists to keep it from
// competing with the player the person is actually watching, and from looking to YouTube like a
// player in trouble.
test('the helper asks for the cheapest video and plays at normal speed', () => {
  const w = world('#vrx-helper');
  w.tick();
  assert.equal(w.quality(), 'tiny/tiny', 'lowest video quality: only the audio track matters');
  assert.equal(w.rate(), 1, 'never faster than realtime: a 16x helper rebuffered constantly, and YouTube logs those interruptions against the account');
  assert.equal(w.paused(), false, 'and keeps itself playing');
});

// Fetching happens by seeking: once the player has filled its buffer and stopped fetching, the
// playhead moves up to just short of the buffered end, so the player fetches the next stretch
// without its buffer ever running dry.
test('the helper fetches by seeking to the buffered end, and finishes when the track is buffered', async () => {
  const w = world('#vrx-helper');
  w.run('__video.duration = 300; __video.buffered = { length: 1, start: () => 0, end: () => 60 };');
  w.tick();
  assert.equal(w.currentTime(), 0, 'the buffer may still be growing: no seek yet');
  await new Promise((r) => setTimeout(r, 900)); // the buffered end has not moved: the player is done fetching
  w.tick();
  assert.equal(w.currentTime(), 57, 'seeks to 3 s short of the buffered end, keeping a little runway');
  assert.equal(w.embedEvents().pop(), 'progress');
  w.run('__video.buffered = { length: 1, start: () => 0, end: () => 299.8 };'); // the player fills the rest from there
  w.tick();
  assert.equal(w.embedEvents().pop(), 'ended', 'the whole track is buffered, so captured: done');
  assert.equal(w.paused(), true, 'and the helper stands still');
});

test('a throttled helper stops playing so the real player gets the bandwidth', () => {
  const w = world('#vrx-helper');
  w.tick();
  assert.equal(w.paused(), false);
  w.cmd({ t: 'throttle', on: true });
  w.tick();
  assert.equal(w.paused(), true, 'stands down while the real player rebuffers');
  w.tick(3);
  assert.equal(w.paused(), true, 'and stays down');
  w.cmd({ t: 'throttle', on: false });
  w.tick();
  assert.equal(w.paused(), false, 'resumes once the player has recovered');
});

test('the throttle does not touch a normal watch page', () => {
  const w = world('');
  w.cmd({ t: 'shadow' });
  w.cmd({ t: 'throttle', on: true });
  w.tick();
  assert.equal(w.paused(), true, 'the stub video was never started by the hook');
  assert.equal(w.quality(), null, 'the hook never changes quality on the page you are watching');
});

// The controller delays switching capture on until the player has settled, so that starting the
// engine does not compete with YouTube's own startup. That is only safe because the hook keeps
// the audio appended in the meantime and hands it over when capture begins.
test('audio appended before capture is switched on is retained, then flushed', () => {
  const w = world('');
  w.cmd({ t: 'arm', on: true });
  w.run(`
    var ms = new MediaSource();
    var sbA = ms.addSourceBuffer('audio/webm; codecs="opus"');
    var sbV = ms.addSourceBuffer('video/webm; codecs="vp9"');
    sbA.appendBuffer(new Uint8Array([1, 2, 3]).buffer);
    sbV.appendBuffer(new Uint8Array([9, 9, 9, 9]).buffer);
    sbA.appendBuffer(new Uint8Array([4, 5]).buffer);
  `);
  assert.deepEqual(w.segBytes(), [], 'nothing is sent while capture is off');

  w.cmd({ t: 'capture', on: true });
  assert.deepEqual(w.segBytes(), [[1, 2, 3], [4, 5]], 'the audio kept during the wait is handed over, in order');
  // Nothing was dropped, so the kept appends and the live ones that follow are one contiguous
  // byte stream. A reset here would throw away a unit split across the hand-over.
  assert.ok(!w.kinds().includes('discontinuity'), 'the parser is not told about a hole that does not exist');
});

test('video appends are never captured, and live audio flows once capture is on', () => {
  const w = world('');
  w.cmd({ t: 'arm', on: true });
  w.cmd({ t: 'capture', on: true });
  w.run(`
    var ms2 = new MediaSource();
    var a = ms2.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    var v = ms2.addSourceBuffer('video/mp4; codecs="avc1.4d401f"');
    v.appendBuffer(new Uint8Array([7, 7]).buffer);
    a.appendBuffer(new Uint8Array([1, 2]).buffer);
    v.appendBuffer(new Uint8Array([8]).buffer);
    a.appendBuffer(new Uint8Array([3]).buffer);
  `);
  assert.deepEqual(w.segBytes(), [[1, 2], [3]], 'only the audio track is copied');
});

// The regression behind a permanent "audio fetched 0%". The first appends on a stream carry the
// codec headers, and nothing after them can be decoded without them. YouTube can append them
// before the extension's other scripts have run, so the hook must already be keeping them.
test('the start of the stream is kept even before the extension arms', () => {
  const w = world('');
  w.run(`
    var ms = new MediaSource();
    var sb = ms.addSourceBuffer('audio/webm; codecs="opus"');
    sb.appendBuffer(new Uint8Array([1, 2, 3]).buffer);
  `); // the codec header, appended before anything armed us
  w.cmd({ t: 'arm', on: true });
  w.run('sb.appendBuffer(new Uint8Array([4, 5]).buffer)');
  w.cmd({ t: 'capture', on: true });
  assert.deepEqual(w.segBytes(), [[1, 2, 3], [4, 5]], 'the header is still there when capture starts');
});

test('the idle budget keeps the oldest data, which is where the headers are', () => {
  const w = world('');
  w.run(`
    var ms = new MediaSource();
    var sb = ms.addSourceBuffer('audio/webm; codecs="opus"');
    for (var i = 0; i < 40; i++) sb.appendBuffer(new Uint8Array([i]).buffer);
  `);
  w.cmd({ t: 'capture', on: true });
  const got = w.segBytes();
  assert.ok(got.length > 0 && got.length <= 16, `capped at the idle budget, got ${got.length}`);
  assert.deepEqual(got[0], [0], 'the first append survives');
  assert.deepEqual(got[got.length - 1], [got.length - 1], 'the newest were dropped, not the oldest');
  assert.ok(w.kinds().includes('discontinuity'), 'and the parser is told about the hole where they were dropped');
});

// abort() resets the player's parser, not the stream: the codec headers appended before it are
// still the ones in force. Wiping the kept data on abort() lost them whenever a seek happened
// before the switch was turned on -- another road to a permanent 0%.
test('an abort() while idle keeps the stream start and is replayed as a reset', () => {
  const w = world('');
  w.run(`
    var ms = new MediaSource();
    var sb = ms.addSourceBuffer('audio/webm; codecs="opus"');
    sb.appendBuffer(new Uint8Array([1, 2, 3]).buffer);
    sb.abort();
    sb.appendBuffer(new Uint8Array([4, 5]).buffer);
  `);
  w.cmd({ t: 'capture', on: true });
  assert.deepEqual(w.segBytes(), [[1, 2, 3], [4, 5]], 'both sides of the abort survive');
  const seq = w.kinds().filter((k) => k === 'seg' || k === 'sb-reset' || k === 'discontinuity');
  assert.deepEqual(seq, ['seg', 'sb-reset', 'seg'], 'the reset sits between them, and no hole is reported');
});

// The same held for data appended after a reset while idle: it was kept but never handed over.
// And an engine store that is new to a stream which has long been playing (the engine or the
// session restarted) gets the stream's headers again ahead of it.
test('audio appended while capture is switched off is handed over when it comes back, headers first', () => {
  const w = world('');
  w.cmd({ t: 'arm', on: true });
  w.cmd({ t: 'capture', on: true });
  w.run(`
    var ms = new MediaSource();
    var sb = ms.addSourceBuffer('audio/webm; codecs="opus"');
    sb.appendBuffer(new Uint8Array([1]).buffer);
  `);
  w.cmd({ t: 'capture', on: false });
  w.run(`
    sb.abort();
    sb.appendBuffer(new Uint8Array([2]).buffer);
    sb.appendBuffer(new Uint8Array([3]).buffer);
  `);
  w.cmd({ t: 'capture', on: true });
  assert.deepEqual(w.segBytes(), [[1], [1], [2], [3]], 'the headers are re-sent, then nothing appended while capture was off is lost');
  const seq = w.kinds().filter((k) => k === 'seg' || k === 'sb-reset' || k === 'discontinuity');
  // the retained data follows the head directly, so there is no hole to report between them
  assert.deepEqual(seq, ['seg', 'seg', 'sb-reset', 'seg', 'seg'], 'headers, then the abort replayed in its place');
});

test('switching capture back on long into a stream replays the headers and reports the hole', () => {
  const w = world('');
  w.cmd({ t: 'arm', on: true });
  w.cmd({ t: 'capture', on: true });
  w.run(`
    var ms = new MediaSource();
    var sb = ms.addSourceBuffer('audio/webm; codecs="opus"');
    for (var i = 0; i < 6; i++) sb.appendBuffer(new Uint8Array([i]).buffer);
  `);
  w.cmd({ t: 'capture', on: false });
  w.run('sb.appendBuffer(new Uint8Array([6]).buffer); sb.appendBuffer(new Uint8Array([7]).buffer);');
  w.cmd({ t: 'capture', on: true });
  const got = w.segBytes();
  assert.deepEqual(got.slice(0, 6), [[0], [1], [2], [3], [4], [5]], 'the live stream so far');
  assert.deepEqual(got.slice(6, 10), [[0], [1], [2], [3]], 'the kept start of the stream (only what the headers need)');
  assert.deepEqual(got.slice(10), [[6], [7]], 'then what was appended while capture was off');
  const seq = w.kinds().filter((k) => k === 'seg' || k === 'sb-reset' || k === 'discontinuity').slice(6);
  assert.deepEqual(seq, ['seg', 'seg', 'seg', 'seg', 'discontinuity', 'seg', 'seg'], 'the hole between the head and the rest is reported, and only that one');
});

test('the helper can be asked for the headers again when the engine starts a fresh store', () => {
  const w = world('#vrx-helper');
  w.run(`
    var ms = new MediaSource();
    var sb = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    for (var i = 0; i < 6; i++) sb.appendBuffer(new Uint8Array([i, i]).buffer);
  `);
  assert.equal(w.segBytes().length, 6, 'the helper captures from the start');
  w.cmd({ t: 'heads' });
  assert.deepEqual(w.segBytes().slice(6), [[0, 0], [1, 1], [2, 2], [3, 3]], 'the stream start is repeated');
  const seq = w.kinds().filter((k) => k === 'seg' || k === 'discontinuity').slice(6);
  assert.deepEqual(seq, ['seg', 'seg', 'seg', 'seg', 'discontinuity'], 'and the parser is told the live stream does not follow on from it');
});

// The engine finalises the decode when the helper reports 'ended'. A pre-roll ad ends in the same
// <video> element long before the track does.
test('an ad ending inside the helper is not reported as the track ending', () => {
  const w = world('#vrx-helper');
  w.tick();
  w.run('__video.ended = true; __adClasses.add("ad-interrupting");');
  w.tick();
  assert.equal(w.embedEvents().pop(), 'progress', 'the ad ending is just progress');
  assert.equal(w.paused(), false, 'and the helper does not stop');
  w.run('__adClasses.clear();');
  w.tick();
  assert.equal(w.embedEvents().pop(), 'ended', 'the content ending is the real end');
  assert.equal(w.paused(), true, 'after which the helper stands still');
});

// The flag travels with the bytes. Kept data flushed during an ad is not ad audio.
test('kept audio keeps the ad state from when it was appended, not from when it is sent', () => {
  const w = world('');
  w.cmd({ t: 'arm', on: true });
  w.run(`
    var ms = new MediaSource();
    var sb = ms.addSourceBuffer('audio/webm; codecs="opus"');
    sb.appendBuffer(new Uint8Array([1]).buffer);
    __adClasses.add('ad-interrupting');
    sb.appendBuffer(new Uint8Array([2]).buffer);
  `);
  w.cmd({ t: 'capture', on: true }); // switched on while the ad is still playing
  assert.deepEqual(w.segBytes(), [[1], [2]]);
  assert.deepEqual(w.segAds(), [false, true], 'the content appended before the ad is not flagged by the flush');
});

// Switching videos: YouTube detaches the previous video's MediaSource. Replaying that stream's start
// into the next video's session put the previous video's audio at the beginning of the next one.
test('a detached MediaSource is dead: its headers and kept data are never replayed', () => {
  const w = world('');
  w.cmd({ t: 'arm', on: true });
  w.cmd({ t: 'capture', on: true });
  w.run(`
    var msA = new MediaSource();
    var sbA = msA.addSourceBuffer('audio/webm; codecs="opus"');
    sbA.appendBuffer(new Uint8Array([1]).buffer);
  `);
  w.cmd({ t: 'capture', on: false }); // the session for video A ends
  w.run(`
    sbA.appendBuffer(new Uint8Array([2]).buffer);   // a last append before YouTube lets go of it
    msA.readyState = 'closed';                      // ... and the element moves on to video B
    var msB = new MediaSource();
    var sbB = msB.addSourceBuffer('audio/webm; codecs="opus"');
    sbB.appendBuffer(new Uint8Array([9]).buffer);
  `);
  w.cmd({ t: 'capture', on: true }); // the session for video B begins
  assert.deepEqual(w.segBytes(), [[1], [9]], "B's session gets B's kept start and nothing of A");
  w.cmd({ t: 'heads' });
  assert.deepEqual(w.segBytes(), [[1], [9], [9]], 'a request for the headers is answered for the live video only');
});

test('the hook reports which video the player is on and how long it says it is', () => {
  const w = world('');
  w.cmd({ t: 'ping' });
  let pong = JSON.parse(w.run('JSON.stringify(__posted.filter((p) => p.t === "pong").pop())'));
  assert.equal(pong.videoId, null, 'a player without the API leaves it open');
  w.run('__player.getVideoData = () => ({ video_id: "abc" }); __player.getDuration = () => 212.4;');
  w.cmd({ t: 'ping' });
  pong = JSON.parse(w.run('JSON.stringify(__posted.filter((p) => p.t === "pong").pop())'));
  assert.equal(pong.videoId, 'abc');
  assert.equal(pong.duration, 212.4);
});

// A playlist's "next" reuses the MediaSource and its SourceBuffers for the preloaded next video.
// The buffer's kept start then belonged to the previous video, and replaying it put that video's
// first seconds at the start of the next one. A new initialization segment starts a new media.
test('a new initialization segment in a reused SourceBuffer starts the kept data over', () => {
  const w = world('');
  w.cmd({ t: 'arm', on: true });
  w.cmd({ t: 'capture', on: true });
  w.run(`
    var ms = new MediaSource();
    var sb = ms.addSourceBuffer('audio/webm; codecs="opus"');
    sb.appendBuffer(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 1, 1, 1]).buffer); // video A: EBML header (init)
    sb.appendBuffer(new Uint8Array([0x1f, 0x43, 0xb6, 0x75, 2, 2, 2, 2]).buffer); // a cluster
  `);
  w.cmd({ t: 'capture', on: false }); // the session for video A ends
  w.run(`
    sb.abort();
    ms.duration = 200; // YouTube sets the next video's length ...
    sb.appendBuffer(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 9, 9, 9, 9]).buffer); // ... and appends video B's init into the same buffer
    sb.appendBuffer(new Uint8Array([0x1f, 0x43, 0xb6, 0x75, 8, 8, 8, 8]).buffer);
  `);
  w.cmd({ t: 'capture', on: true }); // the session for video B begins
  const got = w.segBytes().slice(2);
  assert.deepEqual(got, [[0x1a, 0x45, 0xdf, 0xa3, 9, 9, 9, 9], [0x1f, 0x43, 0xb6, 0x75, 8, 8, 8, 8]], "B's session receives B's start and nothing of A");
  const durations = JSON.parse(w.run('JSON.stringify(__posted.filter((p) => p.t === "seg").map((p) => p.msDuration))'));
  assert.deepEqual(durations, [300, 300, 200, 200], 'each append carries the length its media had when it was appended');
  w.cmd({ t: 'heads' });
  assert.deepEqual(w.segBytes().slice(4), got, "the headers on request are B's, not A's");
});

test('the same initialization segment sent again is the same media: nothing kept is dropped', () => {
  const w = world('');
  w.run(`
    var ms = new MediaSource();
    var sb = ms.addSourceBuffer('audio/webm; codecs="opus"');
    sb.appendBuffer(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 5, 5, 5, 5]).buffer); // init
    sb.appendBuffer(new Uint8Array([0x1f, 0x43, 0xb6, 0x75, 6, 6, 6, 6]).buffer); // cluster
    sb.appendBuffer(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 5, 5, 5, 5]).buffer); // the same init, re-announced
    sb.appendBuffer(new Uint8Array([0x1f, 0x43, 0xb6, 0x75, 7, 7, 7, 7]).buffer);
  `);
  w.cmd({ t: 'capture', on: true });
  assert.equal(w.segBytes().length, 4, 'everything kept is handed over');
  assert.ok(!w.kinds().includes('sb-reset'), 'and no restart is reported');
});

test('a new initialization segment while capture is on tells the engine the stream restarted', () => {
  const w = world('');
  w.cmd({ t: 'arm', on: true });
  w.cmd({ t: 'capture', on: true });
  w.run(`
    var ms = new MediaSource();
    var sb = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    sb.appendBuffer(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 1, 1]).buffer); // ftyp: init
    sb.appendBuffer(new Uint8Array([0, 0, 0, 24, 0x6d, 0x6f, 0x6f, 0x66, 2, 2]).buffer); // moof: media
    sb.appendBuffer(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 3, 3]).buffer); // ftyp again: a new media
  `);
  const seq = w.kinds().filter((k) => k === 'seg' || k === 'sb-reset');
  assert.deepEqual(seq, ['seg', 'seg', 'sb-reset', 'seg'], 'the parser is reset before the new media');
});

// `ad-showing` is also set by overlay and banner ads while the content keeps playing. Treating
// that as "this audio is an ad" threw away every captured segment for the whole video.
test('only a linear ad marks captured audio as an ad', () => {
  const w = world('');
  w.cmd({ t: 'arm', on: true });
  w.cmd({ t: 'capture', on: true });
  w.run(`
    var ms = new MediaSource();
    var sb = ms.addSourceBuffer('audio/webm; codecs="opus"');
    sb.appendBuffer(new Uint8Array([1]).buffer);
    __adClasses.add('ad-showing');
    sb.appendBuffer(new Uint8Array([2]).buffer);
    __adClasses.add('ad-interrupting');
    sb.appendBuffer(new Uint8Array([3]).buffer);
  `);
  assert.deepEqual(w.segAds(), [false, false, true], 'a banner ad is not the content being replaced');
});

// Captured bytes arrive before the engine is ready, because the engine deliberately waits for
// the player to settle. Discarding them in the meantime loses the stream's headers, and without
// those nothing captured afterwards can ever be decoded -- the track sits at 0% forever.
test('the controller holds captured messages instead of dropping them', () => {
  const src = readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
  const listener = src.slice(src.indexOf('hookListeners.add((m) => {', src.indexOf('PENDING_MAX_BYTES')));
  const body = listener.slice(0, listener.indexOf('\n  });'));
  assert.doesNotMatch(body, /if \(!S\.port\) return;/, 'must not drop captured data before the engine exists');
  // a port that is still connecting, or that the engine refused, swallows what is sent through it
  assert.match(body, /if \(!S\.port \|\| !S\.engineReady\) \{ pendingPush\(m\); return; \}/, 'holds it until the engine has confirmed the session');
  assert.match(src, /case 'plan':[\s\S]{0,400}pendingDrain\(\); \/\/ everything captured while the engine was starting/, 'and hands it over on that confirmation');
  // capture has to be switched on with arming, not after the engine gate
  const armCalls = [...src.matchAll(/cmdHook\(\{ t: 'arm', on: ([^}]+) \}\);\s*\n\s*cmdHook\(\{ t: 'capture', on: \1 \}\);/g)];
  assert.ok(armCalls.length >= 2, 'capture is enabled wherever the hook is armed');
});

// Turning the feature off tears the engine port down right away. The engine has to hear
// "disabled" before that, or its session keeps separating -- and playing -- in the background
// with the switch off, which is what made the next video stutter.
test('the engine hears a settings change before anything is awaited', () => {
  const src = readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function saveSettings('), src.indexOf('chrome.storage.onChanged'));
  const tell = fn.indexOf("sendToEngine({ type: 'settings'"), store = fn.indexOf('chrome.storage.local.set');
  assert.ok(tell >= 0 && store >= 0 && tell < store, 'saveSettings tells the engine, then writes storage');
  assert.doesNotMatch(fn.slice(0, tell), /await/, 'nothing is awaited before the engine hears');
  const start = src.indexOf('toggle: (enabled) =>');
  const off = src.slice(start, src.indexOf('vocalLevel:', start));
  assert.ok(off.indexOf('saveSettings({ enabled })') < off.indexOf('stopSession()'), 'and the switch saves before it stops the session');
});
