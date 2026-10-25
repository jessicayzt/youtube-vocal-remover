// The Session against a stubbed engine: how settings reach the playback worklet. The regression
// behind "transposed audio while the panel says 0": a session the engine kept from an earlier
// controller merged the page's settings silently on re-attach, and the worklet went on with the
// old semitone value. Also pins the rule that the worklet is audible only while we hold the audio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const f of ['ranges', 'base64', 'gate']) vm.runInThisContext(readFileSync(new URL(`../src/shared/${f}.js`, import.meta.url), 'utf8'));
globalThis.OfflineAudioContext = class { async decodeAudioData() { throw new Error('no decoding here'); } };
const { Session } = await import('../src/offscreen/session.js');

function makeEngine({ cache } = {}) {
  const engine = {
    registry: { default: 'inst_hq_5' },
    active: null,
    player: {
      ready: true, bound: null, running: true, rendering: true, params: [], syncs: [], restarts: 0, rebinds: 0, lastLevelAt: 0,
      bind(s) { if (this.bound !== s) this.bound = s; this.setParams(s.playbackParams()); },
      unbind() { this.bound = null; }, sync(s, m) { this.syncs.push(m); }, ensureRunning() {},
      setParams(p) { this.params.push(p); }, dropBlocks() {},
      restart() { this.restarts++; return Promise.resolve(); }, rebind(s) { this.rebinds++; this.bound = s; },
    },
    separator: {
      requests: [], cancels: 0,
      request(s) { this.requests.push(s); }, setActive() {}, cancel() { this.cancels++; },
      cancelAndWait() { this.cancels++; return Promise.resolve(); }, priority() {}, mixProgress() {},
      reprocess(s) { this.cancels++; this.requests.push(s); }, suspected: 0, suspectBackend() { this.suspected++; },
    },
    cache: cache || { load: async () => null, save: async () => true, touch() {}, clear() {} },
    setActive(s) { if (this.active === s) return; this.active = s; this.player.bind(s); },
    onSessionIdle() {},
  };
  return engine;
}
const makePort = () => ({ sent: [], postMessage(m) { this.sent.push(m); } });
const lastParams = (engine) => engine.player.params[engine.player.params.length - 1];
const tick = () => new Promise((r) => setTimeout(r, 0));

test('settings brought by a re-attaching controller reach the worklet', async () => {
  const engine = makeEngine();
  const s = new Session(engine, { videoId: 'v1', duration: 10, title: 't' });
  const p1 = makePort();
  await s.attachController(p1, { settings: { enabled: true, semitones: 3, vocalLevel: 0, modelId: 'inst_hq_5', quality: 'high' } });
  assert.equal(lastParams(engine).semitones, 3, 'first attach: transposed as asked');
  s.onControllerMessage({ type: 'bye' }); // the tab navigates away; the engine keeps the session, still active and bound
  // ... meanwhile the transpose is set back to 0 elsewhere, and the person comes back to this video
  const p2 = makePort();
  await s.attachController(p2, { settings: { enabled: true, semitones: 0, vocalLevel: 0, modelId: 'inst_hq_5', quality: 'high' } });
  assert.equal(engine.active, s, 'the same session is reused');
  assert.equal(lastParams(engine).semitones, 0, 'and the worklet is told the new value');
  s.detachController(p2);
});

test('a model changed while the session had no controller starts the instrumental over on re-attach', async () => {
  const engine = makeEngine();
  const s = new Session(engine, { videoId: 'v2', duration: 10, title: 't' });
  const p1 = makePort();
  await s.attachController(p1, { settings: { enabled: true, semitones: 0, vocalLevel: 0, modelId: 'inst_hq_5', quality: 'high' } });
  s.buffers.instReady[0] = 1; s.buffers.instL[0] = 1234; // some output of model 5
  s.onControllerMessage({ type: 'bye' });
  const cancelsBefore = engine.separator.cancels;
  const p2 = makePort();
  await s.attachController(p2, { settings: { enabled: true, semitones: 0, vocalLevel: 0, modelId: 'inst_hq_3', quality: 'high' } });
  for (let i = 0; i < 5 && s.switching; i++) await tick();
  assert.ok(engine.separator.cancels > cancelsBefore, 'the running job was stopped for the switch');
  assert.equal(s.buffers.instReady[0], 0, "model 5's blocks are not passed off as model 3's");
  assert.equal(s.buffers.instL[0], 0);
  assert.match(s.instKey, /inst_hq_3/);
  s.detachController(p2);
});

test('the worklet is audible only while the session holds the page audio', async () => {
  const engine = makeEngine();
  const s = new Session(engine, { videoId: 'v3', duration: 10, title: 't' });
  const p = makePort();
  await s.attachController(p, { settings: { enabled: true, semitones: 0, vocalLevel: 0, modelId: 'inst_hq_5', quality: 'high' } });
  s.onControllerMessage({ type: 'vol', volume: 0.8, muted: false });
  assert.equal(lastParams(engine).gain, 0, 'not holding the audio: silent, the page plays');
  s.setTakeover(true);
  assert.equal(lastParams(engine).gain, 0.8, 'holding it: the user volume');
  s.setTakeover(false);
  assert.equal(lastParams(engine).gain, 0, 'handed back: silent again, no second copy under the page audio');
  s.detachController(p);
});

// The 0.1.0 report: a green stretch playing the original, vocals and all, on a machine short of
// memory. A failed inference stored exactly nothing as a finished instrumental; the worklet
// played the silence, and the silence guard handed the audio back to the page.
function silentReport(mediaTime = 0.5) { return { playing: true, hasBuffers: true, outPeak: 0, srcPeak: 0, gain: 1, envelope: 1, mixSeen: 50, instSeen: 50, mediaTime }; }
async function sessionAt(engine, fillInst) {
  const s = new Session(engine, { videoId: 'v4', duration: 10, title: 't' });
  const p = makePort();
  await s.attachController(p, { settings: { enabled: true, semitones: 0, vocalLevel: 0, modelId: 'inst_hq_5', quality: 'high' } });
  const SR = 44100, BS = 1024;
  for (let x = 0; x < SR * 3; x++) { const v = Math.round(10000 * Math.sin(2 * Math.PI * 440 * x / SR)); s.buffers.mixL[x] = v; s.buffers.mixR[x] = v; fillInst(x, s.buffers); }
  s.buffers.mixReady.fill(1, 0, Math.ceil(SR * 3 / BS)); s.buffers.instReady.fill(1, 0, Math.ceil(SR * 3 / BS));
  // playing: the playback thread reports only while the video plays
  s.lastSync = { mediaTime: 0.5, playing: true, wall: Date.now(), rate: 1 };
  s.setTakeover(true);
  s.silentSince = Date.now() - 2000; // the guard's 1.5 s of patience has passed
  return { s, p };
}

test('an empty instrumental under a green bar is redone, not played as the original for good', async () => {
  const engine = makeEngine();
  const { s, p } = await sessionAt(engine, () => {}); // instrumental: exactly zero everywhere
  const cancels = engine.separator.cancels;
  s.onLevel(silentReport());
  assert.equal(s.takeover, false, 'the original plays meanwhile');
  assert.match(s.silentReason, /being processed again/);
  // the whole empty stretch, not only the second and a half just heard
  for (let b = 0; b < 129; b++) assert.equal(s.buffers.instReady[b], 0, 'block ' + b + ' is no longer green');
  assert.ok(engine.separator.cancels > cancels, 'and the job is restarted to redo it');
  s.detachController(p);
});

test('a quiet but real instrumental is left alone: silence is the right output there', async () => {
  const engine = makeEngine();
  const { s, p } = await sessionAt(engine, (x, b) => { b.instL[x] = 3; b.instR[x] = -3; }); // a trace of output, as a passage of vocals alone leaves
  s.onLevel(silentReport());
  assert.equal(s.takeover, true, 'we keep the audio');
  assert.equal(s.silentReason, null);
  assert.equal(s.buffers.instReady[20], 1, 'nothing is marked for redoing');
  s.detachController(p);
});

test('a silent mixture is handed back as before, without redoing anything', async () => {
  const engine = makeEngine();
  const { s, p } = await sessionAt(engine, () => {});
  s.buffers.mixL.fill(0); s.buffers.mixR.fill(0); // nothing to separate here
  const cancels = engine.separator.cancels;
  s.onLevel(silentReport());
  assert.equal(s.takeover, false);
  assert.match(s.silentReason, /itself silent/);
  assert.equal(engine.separator.cancels, cancels, 'no reprocessing of a gap');
  s.detachController(p);
});

test('empty output twice makes the engine distrust the backend', async () => {
  const engine = makeEngine();
  const { s, p } = await sessionAt(engine, () => {});
  s.onLevel(silentReport());
  assert.equal(engine.separator.suspected, 0, 'once could be anything');
  s.lastReprocessAt = 0; s.silenceUntil = 0; s.setTakeover(true); s.silentSince = Date.now() - 2000;
  s.buffers.instReady.fill(1, 0, 130);
  s.onLevel(silentReport());
  assert.equal(engine.separator.suspected, 1, 'twice is a pattern');
  s.detachController(p);
});

// ---------------------------------------------------------------- the low-memory report, round two
// "The green part was silent; after a reload it played the original." Each test below is one of
// the ways that happens, and what the engine does about it now.
const SR = 44100, BS = 1024;
const v10 = { enabled: true, semitones: 0, vocalLevel: 0, modelId: 'inst_hq_5', quality: 'high' };
function stores(seconds, fill) {
  const n = Math.round(seconds * SR), nb = Math.ceil(n / BS);
  const mixL = new Int16Array(n), mixR = new Int16Array(n), instL = new Int16Array(n), instR = new Int16Array(n);
  for (let x = 0; x < n; x++) fill(x, Math.floor(x / BS), { mixL, mixR, instL, instR });
  return { n, nb, mixL, mixR, instL, instR };
}
const tone = (x) => Math.round(8000 * Math.sin(2 * Math.PI * 330 * x / SR));

test('a cached instrumental with empty stretches under an audible mixture is processed again, not trusted', async () => {
  const st = stores(10, (x, blk, a) => {
    a.mixL[x] = a.mixR[x] = tone(x);
    if (blk < 100 || blk >= 200) { a.instL[x] = 3; a.instR[x] = -3; } // quiet but real everywhere else
  });
  const mix = { totalSamples: st.n, mixL: st.mixL.buffer, mixR: st.mixR.buffer, mixReady: new Uint8Array(st.nb).fill(1).buffer };
  const inst = { totalSamples: st.n, instL: st.instL.buffer, instR: st.instR.buffer, instReady: new Uint8Array(st.nb).fill(1).buffer };
  const engine = makeEngine({ cache: { load: async (k) => (k.endsWith('|mix') ? mix : inst), save: async () => true, touch() {}, clear() {} } });
  const s = new Session(engine, { videoId: 'c1', duration: 10, title: 't' });
  const p = makePort();
  await s.attachController(p, { settings: v10 });
  for (let b = 100; b < 200; b++) assert.equal(s.buffers.instReady[b], 0, `empty block ${b} is not green`);
  assert.equal(s.buffers.instReady[50], 1, 'a quiet but real instrumental is kept');
  assert.equal(s.buffers.instReady[300], 1);
  assert.equal(s.fromCache, false, 'not presented as complete from cache');
  assert.ok(engine.separator.requests.includes(s), 'and processing is requested for the cleared part');
  s.detachController(p);
});

test('without a cached mixture, only a long empty stretch is distrusted', async () => {
  const st = stores(10, (x, blk, a) => { if (!(blk < 150 || (blk >= 200 && blk < 210))) { a.instL[x] = 50; a.instR[x] = 50; } });
  const inst = { totalSamples: st.n, instL: st.instL.buffer, instR: st.instR.buffer, instReady: new Uint8Array(st.nb).fill(1).buffer };
  const engine = makeEngine({ cache: { load: async (k) => (k.endsWith('|mix') ? null : inst), save: async () => true, touch() {}, clear() {} } });
  const s = new Session(engine, { videoId: 'c2', duration: 10, title: 't' });
  const p = makePort();
  await s.attachController(p, { settings: v10 });
  assert.equal(s.buffers.instReady[10], 0, 'three seconds and more of nothing, with no mixture to compare: processed again');
  assert.equal(s.buffers.instReady[205], 1, 'a short gap could be real silence: kept');
  s.detachController(p);
});

test('a block finished while the instrumental is being saved is not saved as ready', async () => {
  const saved = [];
  const engine = makeEngine({ cache: { load: async () => null, save: async (r) => { saved.push(r); return true; }, touch() {}, clear() {} } });
  const s = new Session(engine, { videoId: 'c3', duration: 10, title: 't' });
  const p = makePort();
  await s.attachController(p, { settings: v10 });
  s.buffers.instReady.fill(1, 0, 5);
  for (let x = 0; x < 5 * BS; x++) { s.buffers.instL[x] = 100; s.buffers.instR[x] = 100; }
  // the separator finishes block 5 the moment the first sample slice is copied
  const RealBlob = globalThis.Blob;
  let raced = false;
  globalThis.Blob = class extends RealBlob {
    constructor(parts, opts) {
      if (!raced) { raced = true; for (let x = 5 * BS; x < 6 * BS; x++) { s.buffers.instL[x] = 100; s.buffers.instR[x] = 100; } Atomics.store(s.buffers.instReady, 5, 1); }
      super(parts, opts);
    }
  };
  try { await s.persistInst('k'); } finally { globalThis.Blob = RealBlob; }
  const rec = saved.pop();
  const ready = new Uint8Array(await rec.instReady.arrayBuffer());
  const instL = new Int16Array(await rec.instL.arrayBuffer());
  assert.ok(raced, 'the race happened');
  assert.equal(ready[4], 1, 'blocks finished before the save are saved ready');
  assert.equal(ready[5], 0, 'the block finished during the save is not saved ready');
  for (let b = 0; b < 6; b++) if (ready[b]) assert.equal(instL[b * BS], 100, `ready block ${b} has its samples`);
  s.detachController(p);
});

test('playing, holding the page audio, and nothing coming from the playback thread: the audio goes back, the output is rebuilt', async () => {
  const engine = makeEngine();
  const s = new Session(engine, { videoId: 'w1', duration: 10, title: 't' });
  const p = makePort();
  await s.attachController(p, { settings: v10 });
  s.buffers.mixReady.fill(1);
  const ago = Date.now() - 3000;
  s.onSync({ type: 'sync', mediaTime: 2, wall: Date.now(), rate: 1, playing: true });
  assert.equal(s.takeover, true, 'we hold the audio');
  s.takeoverSince = ago; s.playingSince = ago; engine.player.lastLevelAt = ago; engine.player.rendering = false;
  s.updateTakeover();
  assert.equal(s.takeover, true, 'one quiet check could be a busy main thread');
  s.stallSeenAt = Date.now() - 600;
  s.updateTakeover();
  assert.equal(s.takeover, false, 'confirmed: the page plays its own audio');
  assert.match(s.silentReason, /audio output stopped/);
  assert.equal(engine.player.restarts, 1, 'and the dead output is rebuilt');
  s.detachController(p);
});

test('a playback thread that renders but lost its stores is given them again, not rebuilt', async () => {
  const engine = makeEngine();
  const s = new Session(engine, { videoId: 'w2', duration: 10, title: 't' });
  const p = makePort();
  await s.attachController(p, { settings: v10 });
  s.buffers.mixReady.fill(1);
  s.onSync({ type: 'sync', mediaTime: 2, wall: Date.now(), rate: 1, playing: true });
  const ago = Date.now() - 3000;
  s.takeoverSince = ago; s.playingSince = ago; engine.player.lastLevelAt = ago; engine.player.rendering = true;
  s.stallSeenAt = Date.now() - 600;
  s.updateTakeover();
  assert.equal(s.takeover, false);
  assert.equal(engine.player.rebinds, 1);
  assert.equal(engine.player.restarts, 0);
  s.detachController(p);
});

test('silence from a playback thread reading far from the video is a clock fault, not a quiet instrumental', async () => {
  const engine = makeEngine();
  const { s, p } = await sessionAt(engine, (x, b) => { b.instL[x] = 3; b.instR[x] = -3; }); // fine, quiet stores
  s.lastSync = { mediaTime: 0.5, playing: true, wall: Date.now(), rate: 1 };
  const syncs = engine.player.syncs.length;
  s.onLevel(silentReport(40)); // it is reading 40 s away
  assert.equal(s.takeover, false, 'the original plays rather than silence');
  assert.match(s.silentReason, /clock/);
  assert.ok(engine.player.syncs.length > syncs, 'and the playback thread is re-synchronised');
  assert.equal(s.buffers.instReady[10], 1, 'nothing is marked for redoing');
  s.detachController(p);
});

test('audio output that will not start does not stop processing, and the panel says why', async () => {
  const engine = makeEngine();
  engine.player.running = false; engine.player.error = 'NotAllowedError';
  const s = new Session(engine, { videoId: 'o1', duration: 10, title: 't' });
  const p = makePort();
  await s.attachController(p, { settings: v10 }, 'Audio output could not be started: NotAllowedError');
  assert.equal(s.error, null, 'not a processing error');
  assert.equal(s.needsProcessing, true, 'separating needs no speakers');
  s.lastSync = { mediaTime: 1, playing: true, wall: Date.now(), rate: 1 };
  assert.match(s.snapshot().detail, /Audio output is not working \(NotAllowedError\)/);
  s.detachController(p);
});

// Inst HQ 3 and Balanced are both not the engine's built-in defaults. On a session's first attach
// those defaults were taken for the previous settings: the instrumental just loaded from the cache
// was wiped and loaded again, and anything unsaved was filed under the default model's name.
test("a first attach with another model and quality keeps the cached instrumental and files nothing under another model's key", async () => {
  const st = stores(10, (x, blk, a) => { a.mixL[x] = a.mixR[x] = tone(x); a.instL[x] = a.instR[x] = Math.round(tone(x) / 2); });
  const mix = { totalSamples: st.n, mixL: st.mixL.buffer, mixR: st.mixR.buffer, mixReady: new Uint8Array(st.nb).fill(1).buffer };
  const inst = { totalSamples: st.n, instL: st.instL.buffer, instR: st.instR.buffer, instReady: new Uint8Array(st.nb).fill(1).buffer };
  const loads = [], saves = [];
  const engine = makeEngine({ cache: { load: async (k) => { loads.push(k); return k.endsWith('|mix') ? mix : k.includes('inst_hq_3|balanced') ? inst : null; }, save: async (r) => { saves.push(r.key); return true; }, touch() {}, clear() {} } });
  const s = new Session(engine, { videoId: 'f1', duration: 10, title: 't' });
  const p = makePort();
  await s.attachController(p, { settings: { ...v10, modelId: 'inst_hq_3', quality: 'balanced' } });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(s.switching, false, 'no model switch on a first attach');
  assert.equal(loads.filter((k) => k.includes('inst_hq')).length, 1, 'the instrumental is loaded once');
  assert.equal(s.buffers.instReady[100], 1, 'and stays loaded');
  assert.equal(s.fromCache, true);
  await s.persist();
  assert.ok(!saves.some((k) => k.includes('inst_hq_5')), "nothing is saved under the default model's key: " + saves.join(', '));
  s.detachController(p);
});

test('an attach that left before its settings applied still switches when the next one brings others', async () => {
  const engine = makeEngine();
  const s = new Session(engine, { videoId: 'f2', duration: 10, title: 't' });
  const p1 = makePort();
  await s.attachController(p1, { settings: v10 }); // Inst HQ 5 / High loaded (nothing cached)
  s.buffers.instReady[0] = 1; s.buffers.instL[0] = 777;
  s.onControllerMessage({ type: 'bye' });
  const p2 = makePort();
  await s.attachController(p2, { settings: { ...v10, modelId: 'inst_hq_3', quality: 'balanced' } });
  for (let i = 0; i < 5 && s.switching; i++) await tick();
  assert.equal(s.buffers.instReady[0], 0, "Inst HQ 5's output is not played as Inst HQ 3's");
  assert.equal(s.outputKey, s.instKey, 'the stores now hold what the settings ask for');
  s.detachController(p2);
});

// The report: paused while processing lagged, snippets kept playing until the scrubber moved.
// The playback thread reports only while it plays, so a report under a paused video is a pause
// that never reached it.
test('a playback thread still playing under a paused video is paused again', async () => {
  const engine = makeEngine();
  const s = new Session(engine, { videoId: 'p1', duration: 10, title: 't' });
  const p = makePort();
  await s.attachController(p, { settings: v10 });
  s.onSync({ type: 'sync', mediaTime: 3, wall: Date.now(), rate: 1, playing: false }); // the video is paused
  const before = engine.player.syncs.length;
  s.onLevel({ playing: true, hasBuffers: true, outPeak: 0.3, srcPeak: 0.3, gain: 1, envelope: 1, mixSeen: 1, instSeen: 1, mediaTime: 4.2 });
  const sent = engine.player.syncs.slice(before);
  assert.equal(sent.length, 1, 'one pause sent');
  assert.equal(sent[0].playing, false);
  assert.equal(sent[0].mediaTime, 3, 'at the position the video paused at');
  s.onLevel({ playing: false, hasBuffers: true, outPeak: 0, srcPeak: 0, gain: 1, envelope: 0, mixSeen: 1, instSeen: 1, mediaTime: 3 });
  assert.equal(engine.player.syncs.length, before + 1, 'nothing more once it has stopped');
  s.detachController(p);
});

