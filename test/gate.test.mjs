// The rule that keeps the extension from disturbing the page's player while it is starting up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL('../src/shared/gate.js', import.meta.url), 'utf8'), ctx);
const settled = (state, minBuffer = 8) => vm.runInContext('VRX.gate.playerSettled', ctx)(state, minBuffer);
const isSilent = (info, takeover = true) => vm.runInContext('VRX.gate.outputIsSilent', ctx)(info, takeover);
const cause = (info) => vm.runInContext('VRX.gate.silenceCause', ctx)(info);

// The regression. At page load the player is paused because it has not started yet, and a gate
// that treated "paused" as safe opened immediately -- launching the engine straight into the
// player's cold start, which is exactly when YouTube complains about interruptions.
test('a player that has not started yet is never settled', () => {
  assert.equal(settled({ readyState: 0, paused: true, bufferedAhead: 0 }), false);
  assert.equal(settled({ readyState: 1, paused: true, bufferedAhead: 0 }), false, 'metadata known, still starting');
  assert.equal(settled({ readyState: 2, paused: true, bufferedAhead: 3 }), false);
  assert.equal(settled({ readyState: 1, paused: false, bufferedAhead: 30 }), false, 'readyState rules, whatever the buffer says');
});

test('a playing player needs a real buffer ahead of it', () => {
  assert.equal(settled({ readyState: 4, paused: false, bufferedAhead: 0 }), false);
  assert.equal(settled({ readyState: 4, paused: false, bufferedAhead: 7.9 }), false);
  assert.equal(settled({ readyState: 4, paused: false, bufferedAhead: 8 }), true);
  assert.equal(settled({ readyState: 3, paused: false, bufferedAhead: 40 }), true);
});

test('a loaded but never started player is not a steady state either', () => {
  // whoever presses play is about to make the player fetch hard
  assert.equal(settled({ readyState: 4, paused: true, bufferedAhead: 60 }), false);
  assert.equal(settled({ readyState: 4, paused: true, bufferedAhead: 60, hasPlayed: false }), false);
});

test('a player paused mid-watch needs less runway', () => {
  assert.equal(settled({ readyState: 4, paused: true, hasPlayed: true, bufferedAhead: 3.9 }), false);
  assert.equal(settled({ readyState: 4, paused: true, hasPlayed: true, bufferedAhead: 4 }), true, 'half of the playing threshold');
});

test('an ad is never a good time to start', () => {
  assert.equal(settled({ readyState: 4, paused: false, bufferedAhead: 60, adShowing: true }), false);
});

test('missing or nonsense state is treated as not settled', () => {
  assert.equal(settled(null), false);
  assert.equal(settled({}), false);
  assert.equal(settled({ readyState: 4, paused: false, bufferedAhead: NaN }), false);
  assert.equal(settled({ readyState: 4, paused: false, bufferedAhead: undefined }), false);
});

test('the threshold is honoured', () => {
  assert.equal(settled({ readyState: 4, paused: false, bufferedAhead: 10 }, 12), false);
  assert.equal(settled({ readyState: 4, paused: false, bufferedAhead: 10 }, 4), true);
});

// Silence is always worse than the untouched original, so the engine watches its own output and
// hands the audio back when it produces nothing.
test('holding the audio while emitting nothing counts as silent', () => {
  const quiet = { playing: true, hasBuffers: true, outPeak: 0, srcPeak: 0.5 };
  assert.equal(isSilent(quiet, true), true);
  assert.equal(isSilent(quiet, false), false, 'not our problem when the page still has its audio');
  assert.equal(isSilent({ ...quiet, playing: false }, true), false, 'paused is meant to be silent');
  assert.equal(isSilent({ ...quiet, hasBuffers: false }, true), false, 'nothing loaded yet');
  assert.equal(isSilent({ ...quiet, outPeak: 0.2 }, true), false, 'audible');
  assert.equal(isSilent(null, true), false);
});

test('the two peaks say which side went quiet', () => {
  assert.equal(cause({ srcPeak: 0.5, outPeak: 0 }), 'after-mix', 'read audio but emitted none');
  assert.equal(cause({ srcPeak: 0, outPeak: 0 }), 'source', 'the decoded audio is itself silent');
});
