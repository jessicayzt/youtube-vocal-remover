// What the separation worker accepts from the model before anything is stored as finished.
// A backend short of memory fails without raising: zeros, or a recycled buffer -- an earlier
// result or an earlier input -- read back as if it were the answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutputChecker, ModelFailure, isAudible, fingerprint } from '../src/dsp/output-check.js';

const N = 8192;
const sig = (f, a = 0.3) => Float32Array.from({ length: N }, (_, i) => a * Math.sin(2 * Math.PI * f * i / 44100));
const zeros = () => new Float32Array(N);

test('an empty result for audible input is a failure; for silence it is fine', () => {
  const c = new OutputChecker('webgpu');
  assert.throws(() => c.audio(sig(220), sig(220), zeros(), zeros()), (e) => e instanceof ModelFailure && /no audio \(webgpu\)/.test(e.message));
  assert.doesNotThrow(() => c.audio(zeros(), zeros(), zeros(), zeros()), 'silence in, silence out');
  assert.doesNotThrow(() => c.audio(sig(220), sig(220), sig(220, 0.01), sig(220, 0.01)), 'quiet but real (-30 dB) passes');
});

test('non-finite or implausibly loud audio is a failure', () => {
  const c = new OutputChecker();
  const bad = sig(220); bad[100] = NaN;
  assert.throws(() => c.audio(sig(220), sig(220), bad, sig(220)), /non-finite/);
  assert.throws(() => c.audio(sig(220, 0.001), sig(220, 0.001), sig(220, 0.9), sig(220, 0.9)), /implausibly loud/);
});

test('a result that is one of the inputs handed back is a failure', () => {
  const c = new OutputChecker();
  const x = sig(330);
  const fp = c.input(x);
  assert.throws(() => c.output(fp, Float32Array.from(x), true), /handed back one of its inputs/);
});

test('the same result for a different input is a recycled buffer; for the same input it is fine', () => {
  const c = new OutputChecker();
  const y = sig(110);
  const a = c.input(sig(330)); c.output(a, y, true);
  const b = c.input(sig(331));
  assert.throws(() => c.output(b, Float32Array.from(y), true), /earlier result/, 'High quality: the negated pass reading back the first pass would cancel it to silence');
  const c2 = new OutputChecker();
  const x = sig(330);
  const f1 = c2.input(x); c2.output(f1, y, true);
  const f2 = c2.input(Float32Array.from(x)); // a loop repeated sample for sample
  assert.doesNotThrow(() => c2.output(f2, Float32Array.from(y), true));
});

test('silent input is never judged, and fingerprints tell tensors apart', () => {
  const c = new OutputChecker();
  const fp = c.input(zeros());
  assert.doesNotThrow(() => c.output(fp, zeros(), false));
  assert.equal(isAudible(zeros(), zeros()), false);
  assert.equal(isAudible(sig(220), sig(220)), true);
  assert.notEqual(fingerprint(sig(220)), fingerprint(sig(221)));
  assert.equal(fingerprint(sig(220)), fingerprint(sig(220)));
});
