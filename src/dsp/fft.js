// Mixed-radix FFT (radices 2, 3, 5) with a real-input wrapper.
// Sizes used by the MDX-Net models are 6144 = 2^11*3 and 5120 = 2^10*5, so a
// power-of-two-only FFT is not enough. The complex transform is a Stockham
// autosort (decimation in frequency), ping-ponging between two buffers so no
// bit-reversal pass is needed. Everything is allocated once per plan.

const TWO_PI = 2 * Math.PI;

function factorize(n) {
  const radices = [];
  for (const r of [5, 3, 2]) {
    while (n % r === 0) { radices.push(r); n /= r; }
  }
  if (n !== 1) throw new Error(`FFT size must factor into 2, 3 and 5 (got remainder ${n})`);
  return radices;
}

export class ComplexFFT {
  constructor(n) {
    if (!(n >= 1) || (n | 0) !== n) throw new Error('FFT size must be a positive integer');
    this.n = n;
    this.radices = factorize(n);
    // Per level: stride s, sub-size m = n_level / r, twiddles W_{n_level}^{j*p} for j<r, p<m.
    this.levels = [];
    let size = n, s = 1;
    for (const r of this.radices) {
      const m = size / r;
      const twRe = new Float64Array(r * m), twIm = new Float64Array(r * m);
      for (let j = 0; j < r; j++) {
        for (let p = 0; p < m; p++) {
          const a = -TWO_PI * j * p / size;
          twRe[j * m + p] = Math.cos(a);
          twIm[j * m + p] = Math.sin(a);
        }
      }
      this.levels.push({ r, m, s, size, twRe, twIm });
      size = m; s *= r;
    }
    this.workRe = new Float64Array(n);
    this.workIm = new Float64Array(n);
    // radix-3 / radix-5 constants
    this.c3 = Math.cos(TWO_PI / 3); this.s3 = Math.sin(TWO_PI / 3);
    this.c51 = Math.cos(TWO_PI / 5); this.s51 = Math.sin(TWO_PI / 5);
    this.c52 = Math.cos(2 * TWO_PI / 5); this.s52 = Math.sin(2 * TWO_PI / 5);
  }

  /** In-place forward transform (sign -1). re/im are Float64Array(n). */
  forward(re, im) { this._transform(re, im, false); }
  /** In-place inverse transform, scaled by 1/n. */
  inverse(re, im) { this._transform(re, im, true); }

  _transform(re, im, inverse) {
    const n = this.n;
    if (inverse) { for (let i = 0; i < n; i++) im[i] = -im[i]; }
    let xr = re, xi = im, yr = this.workRe, yi = this.workIm;
    for (const lv of this.levels) {
      this._level(lv, xr, xi, yr, yi);
      // swap
      let t = xr; xr = yr; yr = t; t = xi; xi = yi; yi = t;
    }
    if (xr !== re) { re.set(xr); im.set(xi); }
    if (inverse) {
      const k = 1 / n;
      for (let i = 0; i < n; i++) { re[i] *= k; im[i] = -im[i] * k; }
    }
  }

  // One Stockham DIF stage: y[q + s*(r*p + j)] = W^(j*p) * sum_k x[q + s*(p + k*m)] W_r^(j*k)
  _level(lv, xr, xi, yr, yi) {
    const { r, m, s, twRe, twIm } = lv;
    if (r === 2) {
      for (let p = 0; p < m; p++) {
        const wr = twRe[m + p], wi = twIm[m + p];
        const base0 = s * p, base1 = s * (p + m), out0 = s * (2 * p), out1 = s * (2 * p + 1);
        for (let q = 0; q < s; q++) {
          const ar = xr[base0 + q], ai = xi[base0 + q];
          const br = xr[base1 + q], bi = xi[base1 + q];
          yr[out0 + q] = ar + br; yi[out0 + q] = ai + bi;
          const dr = ar - br, di = ai - bi;
          yr[out1 + q] = dr * wr - di * wi; yi[out1 + q] = dr * wi + di * wr;
        }
      }
    } else if (r === 3) {
      const c3 = this.c3, s3 = this.s3;
      for (let p = 0; p < m; p++) {
        const w1r = twRe[m + p], w1i = twIm[m + p], w2r = twRe[2 * m + p], w2i = twIm[2 * m + p];
        const b0 = s * p, b1 = s * (p + m), b2 = s * (p + 2 * m);
        const o0 = s * (3 * p), o1 = s * (3 * p + 1), o2 = s * (3 * p + 2);
        for (let q = 0; q < s; q++) {
          const ar = xr[b0 + q], ai = xi[b0 + q];
          const br = xr[b1 + q], bi = xi[b1 + q];
          const cr = xr[b2 + q], ci = xi[b2 + q];
          const tr = br + cr, ti = bi + ci;
          const ur = ar + c3 * tr, ui = ai + c3 * ti;
          const vr = s3 * (bi - ci), vi = -s3 * (br - cr); // -i*sin*(b-c)... sign for forward
          yr[o0 + q] = ar + tr; yi[o0 + q] = ai + ti;
          let zr = ur + vr, zi = ui + vi;   // X1 = a + b*W3 + c*W3^2
          yr[o1 + q] = zr * w1r - zi * w1i; yi[o1 + q] = zr * w1i + zi * w1r;
          zr = ur - vr; zi = ui - vi;       // X2
          yr[o2 + q] = zr * w2r - zi * w2i; yi[o2 + q] = zr * w2i + zi * w2r;
        }
      }
    } else if (r === 5) {
      const c1 = this.c51, s1 = this.s51, c2 = this.c52, s2 = this.s52;
      for (let p = 0; p < m; p++) {
        const b = [s * p, s * (p + m), s * (p + 2 * m), s * (p + 3 * m), s * (p + 4 * m)];
        const o = [s * (5 * p), s * (5 * p + 1), s * (5 * p + 2), s * (5 * p + 3), s * (5 * p + 4)];
        for (let q = 0; q < s; q++) {
          const a0r = xr[b[0] + q], a0i = xi[b[0] + q];
          const a1r = xr[b[1] + q], a1i = xi[b[1] + q];
          const a2r = xr[b[2] + q], a2i = xi[b[2] + q];
          const a3r = xr[b[3] + q], a3i = xi[b[3] + q];
          const a4r = xr[b[4] + q], a4i = xi[b[4] + q];
          const t1r = a1r + a4r, t1i = a1i + a4i, t2r = a2r + a3r, t2i = a2i + a3i;
          const t3r = a1r - a4r, t3i = a1i - a4i, t4r = a2r - a3r, t4i = a2i - a3i;
          yr[o[0] + q] = a0r + t1r + t2r; yi[o[0] + q] = a0i + t1i + t2i;
          // X1 = a0 + t1*c1 + t2*c2 - i*(t3*s1 + t4*s2)
          const m1r = a0r + t1r * c1 + t2r * c2, m1i = a0i + t1i * c1 + t2i * c2;
          const n1r = t3i * s1 + t4i * s2, n1i = -(t3r * s1 + t4r * s2);
          // X2 = a0 + t1*c2 + t2*c1 - i*(t3*s2 - t4*s1)
          const m2r = a0r + t1r * c2 + t2r * c1, m2i = a0i + t1i * c2 + t2i * c1;
          const n2r = t3i * s2 - t4i * s1, n2i = -(t3r * s2 - t4r * s1);
          let zr, zi, wr, wi;
          zr = m1r + n1r; zi = m1i + n1i; wr = twRe[m + p]; wi = twIm[m + p];
          yr[o[1] + q] = zr * wr - zi * wi; yi[o[1] + q] = zr * wi + zi * wr;
          zr = m2r + n2r; zi = m2i + n2i; wr = twRe[2 * m + p]; wi = twIm[2 * m + p];
          yr[o[2] + q] = zr * wr - zi * wi; yi[o[2] + q] = zr * wi + zi * wr;
          zr = m2r - n2r; zi = m2i - n2i; wr = twRe[3 * m + p]; wi = twIm[3 * m + p];
          yr[o[3] + q] = zr * wr - zi * wi; yi[o[3] + q] = zr * wi + zi * wr;
          zr = m1r - n1r; zi = m1i - n1i; wr = twRe[4 * m + p]; wi = twIm[4 * m + p];
          yr[o[4] + q] = zr * wr - zi * wi; yi[o[4] + q] = zr * wi + zi * wr;
        }
      }
    }
  }
}

/**
 * Real-input FFT of even size n using one complex FFT of size n/2.
 * forward(x[n]) -> (re[n/2+1], im[n/2+1]); inverse((re, im)) -> x[n].
 */
export class RealFFT {
  constructor(n) {
    if (n % 2 !== 0) throw new Error('RealFFT size must be even');
    this.n = n;
    this.half = n / 2;
    this.cfft = new ComplexFFT(this.half);
    this.zr = new Float64Array(this.half);
    this.zi = new Float64Array(this.half);
    // twiddles e^{-2 pi i k / n} for k < n/2
    this.twRe = new Float64Array(this.half);
    this.twIm = new Float64Array(this.half);
    for (let k = 0; k < this.half; k++) {
      this.twRe[k] = Math.cos(-TWO_PI * k / n);
      this.twIm[k] = Math.sin(-TWO_PI * k / n);
    }
  }

  /** x: array-like of length n (Float32/64). Writes n/2+1 bins into outRe/outIm. */
  forward(x, outRe, outIm) {
    const h = this.half, zr = this.zr, zi = this.zi;
    for (let i = 0; i < h; i++) { zr[i] = x[2 * i]; zi[i] = x[2 * i + 1]; }
    this.cfft.forward(zr, zi);
    // X[k] = E[k] + W^k O[k], with E = (Z[k] + conj Z[h-k])/2, O = (Z[k] - conj Z[h-k])/(2i)
    for (let k = 0; k <= h; k++) {
      const k1 = k === h ? 0 : k, k2 = k === 0 ? 0 : h - k;
      const ar = zr[k1], ai = zi[k1], br = zr[k2], bi = -zi[k2]; // b = conj(Z[h-k])
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi);
      // O = (Z - conj)/2i : (dr + i di)/(2i) = (di - i dr)/2
      const dr = ar - br, di = ai - bi;
      const or = 0.5 * di, oi = -0.5 * dr;
      let wr, wi;
      if (k === h) { wr = -1; wi = 0; } else { wr = this.twRe[k]; wi = this.twIm[k]; }
      outRe[k] = er + wr * or - wi * oi;
      outIm[k] = ei + wr * oi + wi * or;
    }
  }

  /** Inverse of forward: takes n/2+1 bins (imag of DC and Nyquist ignored), writes n real samples into out. */
  inverse(inRe, inIm, out) {
    const h = this.half, zr = this.zr, zi = this.zi;
    // E[k] = (X[k] + conj X[h-k])/2 ; O[k] = (X[k] - conj X[h-k]) * conj(W^k) / 2 ; Z = E + i O
    for (let k = 0; k < h; k++) {
      const ar = inRe[k], ai = k === 0 ? 0 : inIm[k];
      const br = inRe[h - k], bi = (h - k) === h ? 0 : -inIm[h - k];
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi);
      const dr = 0.5 * (ar - br), di = 0.5 * (ai - bi);
      const wr = this.twRe[k], wi = -this.twIm[k]; // conj(W^k)
      const or = dr * wr - di * wi, oi = dr * wi + di * wr;
      zr[k] = er - oi; // E + i*O = (er - oi) + i(ei + or)
      zi[k] = ei + or;
    }
    this.cfft.inverse(zr, zi);
    for (let i = 0; i < h; i++) { out[2 * i] = zr[i]; out[2 * i + 1] = zi[i]; }
  }
}
