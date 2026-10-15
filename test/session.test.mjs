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

function makeEngine() {
  const engine = {
    registry: { default: 'inst_hq_5' },
    active: null,
    player: {
      ready: true, bound: null, running: true, params: [],
      bind(s) { if (this.bound !== s) this.bound = s; this.setParams(s.playbackParams()); },
      unbind() { this.bound = null; }, sync() {}, ensureRunning() {},
      setParams(p) { this.params.push(p); },
    },
    separator: {
      requests: [], cancels: 0,
      request(s) { this.requests.push(s); }, setActive() {}, cancel() { this.cancels++; },
      cancelAndWait() { this.cancels++; return Promise.resolve(); }, priority() {}, mixProgress() {},
      reprocess(s) { this.cancels++; this.requests.push(s); }, suspected: 0, suspectBackend() { this.suspected++; },
    },
    cache: { load: async () => null, save: async () => true, touch() {}, clear() {} },
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
function silentReport() { return { playing: true, hasBuffers: true, outPeak: 0, srcPeak: 0, gain: 1, envelope: 1, mixSeen: 50, instSeen: 50 }; }
async function sessionAt(engine, fillInst) {
  const s = new Session(engine, { videoId: 'v4', duration: 10, title: 't' });
  const p = makePort();
  await s.attachController(p, { settings: { enabled: true, semitones: 0, vocalLevel: 0, modelId: 'inst_hq_5', quality: 'high' } });
  const SR = 44100, BS = 1024;
  for (let x = 0; x < SR * 3; x++) { const v = Math.round(10000 * Math.sin(2 * Math.PI * 440 * x / SR)); s.buffers.mixL[x] = v; s.buffers.mixR[x] = v; fillInst(x, s.buffers); }
  s.buffers.mixReady.fill(1, 0, Math.ceil(SR * 3 / BS)); s.buffers.instReady.fill(1, 0, Math.ceil(SR * 3 / BS));
  s.lastSync = { mediaTime: 0.5, playing: false, wall: Date.now(), rate: 1 };
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
  const [b0, b1] = s.storePeaks(0.5, 1.5).blocks;
  for (let b = b0; b <= b1; b++) assert.equal(s.buffers.instReady[b], 0, 'block ' + b + ' is no longer green');
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
