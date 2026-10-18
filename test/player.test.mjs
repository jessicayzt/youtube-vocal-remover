// How the engine maps the page's position onto its audio clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { heardCtxTime, Player } from '../src/offscreen/player.js';

test('no output timestamp yet (zeros) falls back to the render clock minus the latency', () => {
  const t = heardCtxTime({ ts: { contextTime: 0, performanceTime: 0 }, perfNow: 50000, currentTime: 12, latency: 0.05, ageMs: 20 });
  assert.ok(Math.abs(t - (12 - 0.05 - 0.02)) < 1e-9, String(t));
});

test('a consistent timestamp is used', () => {
  // heard clock 11.95 at perf 49990 ms; now perf 50000: heard now 11.96; the position is 20 ms old
  const t = heardCtxTime({ ts: { contextTime: 11.95, performanceTime: 49990 }, perfNow: 50000, currentTime: 12, latency: 0.05, ageMs: 20 });
  assert.ok(Math.abs(t - 11.94) < 1e-9, String(t));
});

test('a stale or absurd timestamp is not trusted', () => {
  const t = heardCtxTime({ ts: { contextTime: 3, performanceTime: 1000 }, perfNow: 50000, currentTime: 12, latency: 0.05, ageMs: 0 });
  assert.ok(Math.abs(t - 11.95) < 1e-9, 'fallback: ' + t);
});

test('the latency is subtracted: what is rendered now is heard later', () => {
  const t = heardCtxTime({ ts: null, perfNow: 0, currentTime: 10, latency: 0.2, ageMs: 0 });
  assert.ok(t < 10, String(t));
});

// The regression: performance.timeOrigin + performance.now() stops while the computer sleeps, per
// document, so the engine's long-lived document and a page loaded after a sleep disagreed by the
// length of the sleep, and the playback thread read the track that far away: green and silent.
test('positions cross from the page to the engine on Date.now()', () => {
  const strip = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const content = strip(readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8'));
  assert.match(content, /const wall = \(\) => Date\.now\(\);/);
  for (const f of ['session.js', 'player.js']) {
    const src = strip(readFileSync(new URL('../src/offscreen/' + f, import.meta.url), 'utf8'));
    assert.doesNotMatch(src, /timeOrigin/, f + ' must not compare per-document clocks with the page');
  }
});

test('the separation worker checks both passes and the audio before storing a chunk, and publishes blocks atomically', () => {
  const w = readFileSync(new URL('../src/offscreen/separator-worker.js', import.meta.url), 'utf8');
  assert.match(w, /checker\.output\(in1, outData, audible\)/);
  assert.match(w, /checker\.output\(in2, d2, audible\)/);
  assert.match(w, /checker\.audio\(cl, cr, oL, oR\);\s*\n\s*acc\.addChunkOutput\(k, oL, oR\);/);
  assert.match(w, /Atomics\.store\(instReady, b, 1\)/);
});

// An audio output whose start-up never settles (a resume() or module load hanging on a machine
// short of memory) left the original playing under a green bar for good: nothing retried it.
test('a start-up that hangs is replaced, and the abandoned one cannot take over when it finally finishes', async () => {
  const contexts = [];
  let releaseFirst;
  globalThis.chrome = { runtime: { getURL: (p) => p } };
  globalThis.AudioContext = class {
    constructor() {
      this.state = 'running'; this.currentTime = 0; this.destination = {};
      const idx = contexts.push(this) - 1;
      this.audioWorklet = { addModule: () => (idx === 0 ? new Promise((r) => { releaseFirst = r; }) : Promise.resolve()) };
    }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  };
  globalThis.AudioWorkletNode = class {
    constructor() { this.port = { postMessage() {}, set onmessage(f) { setTimeout(() => f({ data: { type: 'ready' } }), 0); } }; }
    connect() {}
  };
  const p = new Player();
  p.init();
  p.initStartedAt = Date.now() - 21000; // hanging for 21 s
  p.ensureRunning();
  await p.restarting;
  assert.equal(p.ready, true, 'the replacement started');
  assert.equal(p.ctx, contexts[1]);
  assert.equal(contexts[0].state, 'closed', 'the hung one was closed');
  releaseFirst();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(p.ctx, contexts[1], 'and the abandoned start-up did not take over');
  delete globalThis.AudioContext; delete globalThis.AudioWorkletNode; delete globalThis.chrome;
});

