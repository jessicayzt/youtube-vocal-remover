// Checks on what the separation model hands back, made before any of it is stored as finished.
//
// A backend short of memory can fail without raising anything. On WebGPU, an allocation that
// fails leaves the commands that needed it unexecuted, so the "result" read back is whatever the
// output buffer held: zeros, or a buffer recycled from an earlier run -- an earlier result, or
// an earlier input. In High quality the second, negated pass then reads back the first pass's
// result and the two cancel exactly: a green stretch of silence. None of that may be stored.
// Pure ES module: the separation worker uses it, and so do the Node tests.

export const SILENT_RMS = 1e-4;        // input quieter than this (about -80 dBFS) leaves nothing to compare with
export const MIN_ENERGY_RATIO = 1e-8;  // output 80 dB below its input is no output at all
export const MAX_ENERGY_RATIO = 1e3;   // and 30 dB above it is not an instrumental of that input

export class ModelFailure extends Error {
  constructor(message) { super(message); this.name = 'ModelFailure'; }
}

export function energy(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return s; }

export function isFiniteArray(a) {
  for (let i = 0; i < a.length; i++) { const v = a[i]; if (v !== v || v === Infinity || v === -Infinity) return false; }
  return true;
}

/** Does this stereo chunk carry sound? Silence in gives nothing to judge the output by. */
export function isAudible(inL, inR) {
  const n = inL.length + inR.length;
  return n > 0 && (energy(inL) + energy(inR)) / n >= SILENT_RMS * SILENT_RMS;
}

/** Hash of a strided sample of the float bit patterns: equal when the same tensor comes back twice. */
export function fingerprint(a) {
  const u = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const step = Math.max(1, Math.floor(u.length / 4096));
  let h = 0x811c9dc5;
  for (let i = 0; i < u.length; i += step) { h ^= u[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return u.length + ':' + h.toString(16);
}

export class OutputChecker {
  /** @param {string} label  the backend, named in the failure messages */
  constructor(label = 'backend') { this.label = label; this.inputs = []; this.outputs = []; }

  /** Remember a model input just before it is run. Returns its fingerprint. */
  input(tensor) {
    const fp = fingerprint(tensor);
    this.inputs.push(fp);
    if (this.inputs.length > 8) this.inputs.shift(); // a recycled buffer is usually a recent one
    return fp;
  }

  /** The raw model output for the input fingerprinted `inFp`; `audible` says whether that input carried sound. */
  output(inFp, data, audible) {
    if (!isFiniteArray(data)) throw new ModelFailure(`the model produced non-finite output (${this.label})`);
    const fp = fingerprint(data);
    const repeated = this.outputs.some((o) => o.fp === fp && o.inFp !== inFp);
    this.outputs.push({ fp, inFp });
    if (this.outputs.length > 6) this.outputs.shift();
    if (!audible) return;
    if (this.inputs.includes(fp)) throw new ModelFailure(`the model handed back one of its inputs (${this.label})`);
    if (repeated) throw new ModelFailure(`the model handed back an earlier result (${this.label})`);
  }

  /** The chunk's audio in and the instrumental out, both in the time domain. */
  audio(inL, inR, outL, outR) {
    if (!isFiniteArray(outL) || !isFiniteArray(outR)) throw new ModelFailure(`the separation produced non-finite audio (${this.label})`);
    if (!isAudible(inL, inR)) return;
    const eIn = energy(inL) + energy(inR), eOut = energy(outL) + energy(outR);
    if (eOut < eIn * MIN_ENERGY_RATIO) throw new ModelFailure(`the model returned no audio (${this.label})`);
    if (eOut > eIn * MAX_ENERGY_RATIO) throw new ModelFailure(`the model returned implausibly loud audio (${this.label})`);
  }
}
