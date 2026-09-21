import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComplexFFT, RealFFT } from '../src/dsp/fft.js';
import { STFT } from '../src/dsp/stft.js';
import { MdxGrid, MdxAccumulator } from '../src/dsp/mdx.js';

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function naiveDFT(re, im) {
  const n = re.length, outRe = new Float64Array(n), outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let t = 0; t < n; t++) {
      const a = -2 * Math.PI * k * t / n, c = Math.cos(a), s = Math.sin(a);
      sr += re[t] * c - im[t] * s; si += re[t] * s + im[t] * c;
    }
    outRe[k] = sr; outIm[k] = si;
  }
  return [outRe, outIm];
}

for (const n of [1, 2, 3, 5, 8, 12, 30, 96, 160, 6144, 5120]) {
  test(`ComplexFFT n=${n} matches naive DFT and inverts`, () => {
    const r = rng(n);
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) { re[i] = r() * 2 - 1; im[i] = r() * 2 - 1; }
    const [er, ei] = naiveDFT(re, im);
    const fr = Float64Array.from(re), fi = Float64Array.from(im);
    const fft = new ComplexFFT(n);
    fft.forward(fr, fi);
    let maxErr = 0;
    for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(fr[i] - er[i]), Math.abs(fi[i] - ei[i]));
    assert.ok(maxErr < 1e-8 * Math.max(1, n), `forward max error ${maxErr}`);
    fft.inverse(fr, fi);
    let maxErr2 = 0;
    for (let i = 0; i < n; i++) maxErr2 = Math.max(maxErr2, Math.abs(fr[i] - re[i]), Math.abs(fi[i] - im[i]));
    assert.ok(maxErr2 < 1e-10 * Math.max(1, n), `round trip max error ${maxErr2}`);
  });
}

for (const n of [8, 12, 20, 6144, 5120]) {
  test(`RealFFT n=${n} matches naive DFT and inverts`, () => {
    const r = rng(n + 7);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = r() * 2 - 1;
    const [er, ei] = naiveDFT(x, new Float64Array(n));
    const rf = new RealFFT(n);
    const re = new Float64Array(n / 2 + 1), im = new Float64Array(n / 2 + 1);
    rf.forward(x, re, im);
    let maxErr = 0;
    for (let k = 0; k <= n / 2; k++) maxErr = Math.max(maxErr, Math.abs(re[k] - er[k]), Math.abs(im[k] - ei[k]));
    assert.ok(maxErr < 1e-8 * Math.max(1, n), `forward max error ${maxErr}`);
    const y = new Float64Array(n);
    rf.inverse(re, im, y);
    let maxErr2 = 0;
    for (let i = 0; i < n; i++) maxErr2 = Math.max(maxErr2, Math.abs(y[i] - x[i]));
    assert.ok(maxErr2 < 1e-10 * Math.max(1, n), `round trip max error ${maxErr2}`);
  });
}

for (const cfg of [{ nFft: 6144, hop: 1024, dimF: 3072 }, { nFft: 5120, hop: 1024, dimF: 2560 }]) {
  test(`STFT/iSTFT round trip nFft=${cfg.nFft}`, () => {
    const st = new STFT(cfg);
    for (const len of [255 * 1024, 10 * 1024 + 37]) {
      const T = st.frames(len);
      assert.equal(T, 1 + Math.floor(len / cfg.hop));
      if (len === 255 * 1024) assert.equal(T, 256);
      const r = rng(len);
      // band-limited noise: a 2-tap average has a zero at Nyquist, and the model spectrogram drops
      // the Nyquist bin (dimF = nFft/2), so reconstruction can only be near-exact for such signals
      const L = new Float32Array(len), R = new Float32Array(len);
      let pl = r() * 2 - 1, pr = r() * 2 - 1;
      for (let i = 0; i < len; i++) { const a = r() * 2 - 1, b = r() * 2 - 1; L[i] = 0.5 * (a + pl); R[i] = 0.5 * (b + pr); pl = a; pr = b; }
      const spec = new Float32Array(4 * cfg.dimF * T);
      st.forward([L, R], spec, 0);
      const outLen = cfg.hop * (T - 1);
      const oL = new Float32Array(outLen), oR = new Float32Array(outLen);
      st.inverse(spec, T, [oL, oR]);
      let maxErr = 0, e = 0, s = 0;
      for (let i = 0; i < outLen; i++) {
        maxErr = Math.max(maxErr, Math.abs(oL[i] - L[i]), Math.abs(oR[i] - R[i]));
        e += (oL[i] - L[i]) ** 2; s += L[i] ** 2;
      }
      assert.ok(maxErr < 5e-3, `len=${len} max error ${maxErr}`);
      assert.ok(e / s < 1e-5, `relative error energy ${e / s}`);
    }
  });

  test(`STFT zeroes the lowest bins when asked (nFft=${cfg.nFft})`, () => {
    const st = new STFT(cfg);
    const len = 4096;
    const L = new Float32Array(len).fill(0.5), R = new Float32Array(len).fill(-0.25);
    const T = st.frames(len);
    const spec = new Float32Array(4 * cfg.dimF * T);
    st.forward([L, R], spec, 3);
    for (let ch = 0; ch < 4; ch++) for (let f = 0; f < 3; f++) for (let t = 0; t < T; t++) assert.equal(spec[ch * cfg.dimF * T + f * T + t], 0);
    // DC of a constant signal is zeroed, so bin 3 carries little; just check the layout is finite
    assert.ok(spec.every(Number.isFinite));
  });
}

test('STFT of a smooth signal reconstructs almost exactly', () => {
  const st = new STFT({ nFft: 6144, hop: 1024, dimF: 3072 });
  const len = 40 * 1024;
  const L = new Float32Array(len), R = new Float32Array(len);
  for (let i = 0; i < len; i++) { L[i] = 0.7 * Math.sin(i * 0.01) + 0.2 * Math.sin(i * 0.37); R[i] = 0.5 * Math.cos(i * 0.021); }
  const T = st.frames(len);
  const spec = new Float32Array(4 * 3072 * T);
  st.forward([L, R], spec, 0);
  const outLen = 1024 * (T - 1);
  const oL = new Float32Array(outLen), oR = new Float32Array(outLen);
  st.inverse(spec, T, [oL, oR]);
  let maxErr = 0;
  for (let i = 0; i < outLen; i++) maxErr = Math.max(maxErr, Math.abs(oL[i] - L[i]), Math.abs(oR[i] - R[i]));
  assert.ok(maxErr < 1e-5, `max error ${maxErr}`);
});

test('MdxGrid chunk coverage math matches brute force', () => {
  const grid = new MdxGrid({ nFft: 6144, hop: 1024, dimT: 256, overlap: 0.25, totalSamples: 44100 * 13 + 777 });
  assert.equal(grid.chunkSize, 261120);
  assert.equal(grid.trim, 3072);
  assert.equal(grid.step, Math.floor(0.75 * 261120));
  const r = rng(3);
  for (let i = 0; i < 2000; i++) {
    const x = Math.floor(r() * grid.totalSamples);
    const [kmin, kmax] = grid.chunksCoveringSample(x);
    const brute = [];
    for (let k = 0; k < grid.numChunks; k++) if (grid.chunkStart(k) <= x && x < grid.chunkEnd(k)) brute.push(k);
    assert.ok(brute.length > 0, `sample ${x} uncovered`);
    assert.equal(kmin, brute[0]); assert.equal(kmax, brute[brute.length - 1]);
  }
  // every block's covering range is consistent with its samples
  for (let b = 0; b < grid.numBlocks; b++) {
    const [kmin, kmax] = grid.chunksCoveringBlock(b);
    const x0 = b * grid.blockSize, x1 = Math.min(grid.totalSamples, x0 + grid.blockSize) - 1;
    assert.equal(kmin, grid.chunksCoveringSample(x0)[0]);
    assert.equal(kmax, grid.chunksCoveringSample(x1)[1]);
  }
});

for (const overlap of [0, 0.25, 0.5, 0.75]) {
  test(`MdxAccumulator reconstructs an identity model in random order (overlap=${overlap})`, () => {
    const total = 44100 * 9 + 321;
    const grid = new MdxGrid({ nFft: 6144, hop: 1024, dimT: 256, overlap, totalSamples: total });
    const r = rng(11);
    const mixL = new Float32Array(total), mixR = new Float32Array(total);
    for (let i = 0; i < total; i++) { mixL[i] = r() * 2 - 1; mixR[i] = r() * 2 - 1; }
    const outL = new Float32Array(total).fill(NaN), outR = new Float32Array(total).fill(NaN);
    const comp = 1.022;
    const finalisedAt = [];
    const acc = new MdxAccumulator(grid, {
      compensate: comp,
      onBlockFinal: (b, l, rr) => {
        outL.set(l, b * grid.blockSize); outR.set(rr, b * grid.blockSize);
        finalisedAt.push([b, acc.processedCount]);
      },
    });
    const order = [...Array(grid.numChunks).keys()];
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (const k of order) {
      const cl = new Float32Array(grid.chunkSize), cr = new Float32Array(grid.chunkSize);
      const cs = grid.chunkStart(k);
      for (let i = 0; i < grid.chunkSize; i++) { const x = cs + i; if (x >= 0 && x < total) { cl[i] = mixL[x]; cr[i] = mixR[x]; } }
      acc.addChunkOutput(k, cl, cr);
    }
    assert.equal(acc.finalCount, grid.numBlocks, 'all blocks final');
    assert.equal(acc.pending.size, 0, 'all chunk outputs released');
    let maxErr = 0;
    for (let i = 0; i < total; i++) maxErr = Math.max(maxErr, Math.abs(outL[i] - mixL[i] * comp), Math.abs(outR[i] - mixR[i] * comp));
    assert.ok(maxErr < 1e-5, `max error ${maxErr}`);
    // blocks were finalised progressively, not all at the end
    assert.ok(finalisedAt.some(([, n]) => n < grid.numChunks), 'some blocks finalised before the last chunk');
  });
}

test('MdxAccumulator sequential processing finalises blocks promptly', () => {
  const total = 44100 * 20;
  const grid = new MdxGrid({ nFft: 5120, hop: 1024, dimT: 256, overlap: 0.5, totalSamples: total });
  const acc = new MdxAccumulator(grid, { compensate: 1, onBlockFinal: () => {} });
  const z = new Float32Array(grid.chunkSize);
  const finalsAfter = [];
  for (let k = 0; k < grid.numChunks; k++) { acc.addChunkOutput(k, z, z); finalsAfter.push(acc.finalCount); }
  // after chunk k, everything before chunkStart(k+1) must be final
  for (let k = 0; k + 1 < grid.numChunks; k++) {
    const expectMin = Math.floor(Math.max(0, grid.chunkStart(k + 1)) / grid.blockSize);
    assert.ok(finalsAfter[k] >= expectMin, `after chunk ${k}: ${finalsAfter[k]} < ${expectMin}`);
  }
  assert.ok(acc.pending.size <= 2, 'only the overlapping tail stays pending');
});
