// Runs the playback AudioWorkletProcessor under Node with stubs for the audio-thread globals,
// including the real Signalsmith Stretch WASM. Covers the mixing rules (which store is audible
// when), the video-clock mapping, and the transpose/rate path.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const SR = 44100, BS = 1024, SCALE = 21845;
globalThis.sampleRate = SR;
globalThis.currentTime = 0;
let Registered = null;
globalThis.registerProcessor = (name, cls) => { if (name === 'vrx-player') Registered = cls; };
const sent = [];
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, postMessage: (m) => sent.push(m) }; } };
await import('../src/offscreen/player-worklet.js');

const total = SR * 2, nb = Math.ceil(total / BS);
const sab = (n) => new SharedArrayBuffer(n);
const mixL = new Int16Array(sab(total * 2)), mixR = new Int16Array(sab(total * 2));
const instL = new Int16Array(sab(total * 2)), instR = new Int16Array(sab(total * 2));
const mixReady = new Uint8Array(sab(nb)), instReady = new Uint8Array(sab(nb));
for (let i = 0; i < total; i++) {
  const t = i / SR;
  mixL[i] = mixR[i] = Math.round(SCALE * 0.5 * Math.sin(2 * Math.PI * 440 * t));   // "mixture"
  instL[i] = instR[i] = Math.round(SCALE * 0.25 * Math.sin(2 * Math.PI * 220 * t)); // "instrumental"
}

const bufferMessage = () => ({
  type: 'buffers', totalSamples: total, blockSize: BS, scale: SCALE,
  mixL: mixL.buffer, mixR: mixR.buffer, instL: instL.buffer, instR: instR.buffer,
  mixReady: mixReady.buffer, instReady: instReady.buffer,
});

let proc;
before(async () => {
  assert.ok(Registered, 'processor registered');
  proc = new Registered();
  for (let i = 0; i < 400 && !proc.wasmReady; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(proc.wasmReady, 'stretch WASM loaded');
  proc.onMessage(bufferMessage());
});

function render(ctxTime) {
  globalThis.currentTime = ctxTime;
  const L = new Float32Array(128), R = new Float32Array(128);
  proc.process([], [[L, R]]);
  return L;
}
/** Play from `mediaTime` and return the block after the start fade has opened. */
function playBlock(mediaTime, ctxBase) {
  proc.onMessage({ type: 'sync', mediaTime, ctxTime: ctxBase, rate: 1, playing: true });
  for (let i = 0; i < 4; i++) render(ctxBase + i * 128 / SR);
  return { out: render(ctxBase + 4 * 128 / SR), at: Math.round((mediaTime + 4 * 128 / SR) * SR) };
}
/**
 * Like playBlock, but first lets the smoothed gain, the start envelope and the stretch crossfade
 * converge, so the sampled block reflects the mix alone rather than whatever the previous test
 * left those at. Then it re-anchors the clock so the sampled block sits at a known position.
 */
function playSettled(mediaTime, ctxBase, tail = 10) {
  proc.onMessage({ type: 'sync', mediaTime, ctxTime: ctxBase, rate: 1, playing: true });
  for (let i = 0; i < 140; i++) render(ctxBase + i * 128 / SR);
  const ctx2 = ctxBase + 200 * 128 / SR;
  proc.onMessage({ type: 'sync', mediaTime, ctxTime: ctx2, rate: 1, playing: true });
  for (let i = 0; i < tail; i++) render(ctx2 + i * 128 / SR);
  return { out: render(ctx2 + tail * 128 / SR), at: Math.round((mediaTime + tail * 128 / SR) * SR) };
}
const maxDiff = (out, ref, at) => { let m = 0; for (let i = 0; i < out.length; i++) m = Math.max(m, Math.abs(out[i] - ref[at + i] / SCALE)); return m; };
const rms = (out) => { let s = 0; for (const v of out) s += v * v; return Math.sqrt(s / out.length); };
const setReady = (mix, inst) => { mixReady.fill(0); instReady.fill(0); if (mix) mixReady.fill(1, mix[0], mix[1]); if (inst) instReady.fill(1, inst[0], inst[1]); };

test('a processed block plays the instrumental when vocals are removed', () => {
  setReady([0, nb], [0, nb]);
  proc.onMessage({ type: 'params', params: { vocalLevel: 0, semitones: 0, gain: 1 } });
  const { out, at } = playBlock(0.5, 10);
  assert.ok(maxDiff(out, instL, at) < 1e-6, 'output is the instrumental');
});

test('vocals at 100% plays the untouched mixture', () => {
  setReady([0, nb], [0, nb]);
  proc.onMessage({ type: 'params', params: { vocalLevel: 1 } });
  const { out, at } = playBlock(0.6, 20);
  assert.ok(maxDiff(out, mixL, at) < 1e-6, 'output is the mixture');
});

test('an unprocessed block plays the mixture even with vocals removed', () => {
  setReady([0, nb], [0, 4]);
  proc.onMessage({ type: 'params', params: { vocalLevel: 0 } });
  const { out, at } = playBlock(1.6, 30);
  assert.ok(maxDiff(out, mixL, at) < 1e-6, 'output is the mixture');
});

// This is the "green but silent" regression: a block whose instrumental is known (restored from
// cache, or separated before its mixture window was re-decoded) must still be audible.
test('a processed block with no decoded mixture plays the instrumental, not silence', () => {
  setReady(null, [0, nb]);
  proc.onMessage({ type: 'params', params: { vocalLevel: 0 } });
  const { out, at } = playBlock(0.5, 40);
  assert.ok(rms(out) > 0.05, `audible (rms ${rms(out)})`);
  assert.ok(maxDiff(out, instL, at) < 1e-6, 'output is the instrumental');
});

test('a block neither decoded nor processed is silent so the page audio can play', () => {
  setReady([0, 4], [0, 4]);
  proc.onMessage({ type: 'params', params: { vocalLevel: 0 } });
  const { out } = playBlock(1.7, 50);
  assert.ok(out.every((v) => Math.abs(v) < 1e-9), 'silent');
});

test('the video clock is followed: jitter is absorbed, a seek re-anchors', () => {
  setReady([0, nb], [0, nb]);
  proc.onMessage({ type: 'sync', mediaTime: 1.0, ctxTime: 60, rate: 1, playing: true });
  render(60);
  proc.onMessage({ type: 'sync', mediaTime: 1.0 + 128 / SR + 0.005, ctxTime: 60 + 128 / SR, rate: 1, playing: true });
  assert.equal(proc.timeline.ctx, 60, '5 ms of jitter does not move the anchor');
  proc.onMessage({ type: 'sync', mediaTime: 0.2, ctxTime: 60 + 256 / SR, rate: 1, playing: true });
  assert.equal(proc.timeline.media, 0.2, 'a seek moves the anchor');
  assert.ok(proc.snapFrom, 'and is crossfaded');
  render(60 + 256 / SR);
});

test('transpose shifts pitch and playback rate does not', () => {
  setReady([0, nb], [0, nb]);
  const freqOf = (blocks) => {
    const tail = blocks.slice(60).flatMap((b) => Array.from(b));
    let zc = 0;
    for (let i = 1; i < tail.length; i++) if ((tail[i - 1] < 0) !== (tail[i] < 0)) zc++;
    return zc / 2 / (tail.length / SR);
  };
  proc.onMessage({ type: 'params', params: { vocalLevel: 1, semitones: 3 } });
  proc.onMessage({ type: 'sync', mediaTime: 0.3, ctxTime: 80, rate: 1, playing: true });
  const a = []; for (let i = 0; i < 120; i++) a.push(render(80 + i * 128 / SR));
  const f3 = freqOf(a);
  assert.ok(Math.abs(f3 - 440 * Math.pow(2, 3 / 12)) < 25, `+3 semitones ≈ 523 Hz, got ${f3.toFixed(1)}`);
  proc.onMessage({ type: 'params', params: { semitones: 0 } });
  proc.onMessage({ type: 'sync', mediaTime: 0.3, ctxTime: 100, rate: 1.5, playing: true });
  const b = []; for (let i = 0; i < 120; i++) b.push(render(100 + i * 128 / SR));
  const f1 = freqOf(b);
  assert.ok(Math.abs(f1 - 440) < 25, `1.5x keeps 440 Hz, got ${f1.toFixed(1)}`);
});

test('pausing fades out to silence', () => {
  proc.onMessage({ type: 'sync', mediaTime: 0.6, ctxTime: 120, rate: 1, playing: false });
  for (let i = 0; i < 6; i++) render(120 + i * 128 / SR);
  assert.ok(render(120 + 6 * 128 / SR).every((v) => v === 0), 'silent');
});

// The engine measures its own output so it can tell that it has gone silent, and say whether the
// audio it read was silent or something after the mix silenced it.
test('the worklet reports what it read and what it emitted', () => {
  setReady([0, nb], [0, nb]);
  proc.onMessage({ type: 'params', params: { vocalLevel: 0, semitones: 0, gain: 1 } });
  sent.length = 0;
  proc.onMessage({ type: 'sync', mediaTime: 0.5, ctxTime: 200, rate: 1, playing: true });
  for (let i = 0; i < 120; i++) render(200 + i * 128 / SR); // past the quarter-second report interval
  const levels = sent.filter((m) => m.type === 'level');
  assert.ok(levels.length >= 1, 'a level report was sent');
  const last = levels[levels.length - 1];
  assert.ok(last.srcPeak > 0.05, `read real audio (${last.srcPeak})`);
  assert.ok(last.outPeak > 0.05, `emitted real audio (${last.outPeak})`);
  assert.equal(last.hasBuffers, true);
  assert.equal(last.playing, true);
});

test('a silenced output is distinguishable from silent source audio', () => {
  setReady([0, nb], [0, nb]);
  // gain 0 is the failure that left processed sections inaudible: the source is fine, the
  // output is not, and the two peaks say so
  proc.onMessage({ type: 'params', params: { vocalLevel: 0, gain: 0 } });
  sent.length = 0;
  proc.onMessage({ type: 'sync', mediaTime: 0.5, ctxTime: 300, rate: 1, playing: true });
  for (let i = 0; i < 400; i++) render(300 + i * 128 / SR); // let the gain smoother settle
  const last = sent.filter((m) => m.type === 'level').pop();
  assert.ok(last.srcPeak > 0.05, 'the audio read from the stores is fine');
  assert.ok(last.outPeak < 1e-4, `nothing came out (${last.outPeak})`);
  proc.onMessage({ type: 'params', params: { gain: 1 } });
});

// An exception out of process() makes the browser drop the processor for good: the extension
// then produces silence forever, whatever else is fixed. Losing the stores mid-fade did exactly
// that, because the fade-out path still read from them.
test('losing the stores mid-playback neither throws nor kills the thread', () => {
  setReady([0, nb], [0, nb]);
  proc.onMessage({ type: 'params', params: { vocalLevel: 0, gain: 1 } });
  playBlock(0.5, 400); // playing, envelope open
  proc.onMessage({ type: 'clear' }); // the engine dropped the session
  let out;
  assert.doesNotThrow(() => { for (let i = 0; i < 12; i++) out = render(400 + (5 + i) * 128 / SR); });
  assert.ok(out.every((v) => v === 0), 'silent, not crashed');
  proc.onMessage(bufferMessage());
  const again = playSettled(0.5, 500);
  assert.ok(maxDiff(again.out, instL, again.at) < 1e-6, 'and plays again afterwards');
});

// Fallback for a playback thread that cannot see the shared stores: the engine copies the audio
// in, and what arrives that way takes precedence.
test('audio copied into the playback thread is used when the shared stores show nothing', () => {
  proc.onMessage(bufferMessage()); // resets any previous copies
  setReady(null, null); // the shared stores offer nothing at all
  proc.onMessage({ type: 'params', params: { vocalLevel: 0, gain: 1 } });
  const start = 20, count = 4, at = start * BS, len = count * BS;
  const L = new Int16Array(instL.subarray(at, at + len));
  const R = new Int16Array(instR.subarray(at, at + len));
  proc.onMessage({ type: 'blocks', kind: 'inst', start, count, a: L.buffer, b: R.buffer });
  const { out, at: sampleAt } = playSettled((at + 512) / SR, 600);
  assert.ok(maxDiff(out, instL, sampleAt) < 1e-6, 'plays the copied instrumental');
  sent.length = 0;
  for (let i = 0; i < 120; i++) render(700 + i * 128 / SR);
  const last = sent.filter((m) => m.type === 'level').pop();
  assert.equal(last.pushed, true, 'the report says it is running on copied audio');
  assert.equal(last.instSeen, count, 'and counts only what it can actually see');
});
