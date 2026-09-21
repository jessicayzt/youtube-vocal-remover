// STFT / iSTFT matching torch.stft / torch.istft as used by UVR's MDX-Net code:
//   torch.stft(x, n_fft, hop_length, window=hann_window(n_fft) [periodic], center=True, pad_mode='reflect')
//   spectrogram layout for the model: [4, dimF, T] = [L.re, L.im, R.re, R.im] x freq (first dimF bins) x frames
//   torch.istft(..., center=True) with window-envelope normalisation and trimming of n_fft/2 on both sides.
import { RealFFT } from './fft.js';

export function periodicHann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  return w;
}

/** np.hanning(n): symmetric Hann, zero at both ends. */
export function symmetricHann(n) {
  const w = new Float64Array(n);
  if (n === 1) { w[0] = 1; return w; }
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  return w;
}

export class STFT {
  /**
   * @param {object} p  { nFft, hop, dimF }
   */
  constructor({ nFft, hop, dimF }) {
    this.nFft = nFft;
    this.hop = hop;
    this.dimF = dimF;
    this.pad = nFft >> 1;
    this.bins = (nFft >> 1) + 1;
    if (dimF > this.bins) throw new Error('dimF larger than n_fft/2+1');
    this.window = periodicHann(nFft);
    this.fft = new RealFFT(nFft);
    this.frame = new Float64Array(nFft);
    this.re = new Float64Array(this.bins);
    this.im = new Float64Array(this.bins);
  }

  /** Number of frames torch.stft(center=True) produces for a signal of length len. */
  frames(len) { return 1 + Math.floor(len / this.hop); }

  /**
   * Forward transform of a stereo chunk.
   * @param {Float32Array[]} channels  [L, R] each of length len
   * @param {Float32Array} out  length 4*dimF*T, layout [c*2+ri][f][t]
   * @param {number} zeroLowBins  number of lowest bins to zero (UVR uses 3)
   */
  forward(channels, out, zeroLowBins = 0) {
    const len = channels[0].length;
    const T = this.frames(len), dimF = this.dimF, pad = this.pad, nFft = this.nFft, hop = this.hop;
    const frame = this.frame, w = this.window, re = this.re, im = this.im;
    const last = len - 1;
    for (let c = 0; c < channels.length; c++) {
      const x = channels[c];
      const reBase = (2 * c) * dimF * T, imBase = (2 * c + 1) * dimF * T;
      for (let t = 0; t < T; t++) {
        const start = t * hop - pad; // index into the un-padded signal of frame sample 0
        for (let i = 0; i < nFft; i++) {
          let j = start + i;
          // torch reflect padding: index -k -> k, index len-1+k -> len-1-k
          if (j < 0) j = -j;
          else if (j > last) j = 2 * last - j;
          frame[i] = x[j] * w[i];
        }
        this.fft.forward(frame, re, im);
        for (let f = 0; f < zeroLowBins; f++) { out[reBase + f * T + t] = 0; out[imBase + f * T + t] = 0; }
        for (let f = zeroLowBins; f < dimF; f++) {
          out[reBase + f * T + t] = re[f];
          out[imBase + f * T + t] = im[f];
        }
      }
    }
    return T;
  }

  /**
   * Inverse transform. spec layout as produced by forward (4*dimF*T), output length = hop*(T-1).
   * @param {Float32Array} spec
   * @param {number} T frames
   * @param {Float32Array[]} outChannels [L, R] each of length hop*(T-1)
   */
  inverse(spec, T, outChannels) {
    const dimF = this.dimF, pad = this.pad, nFft = this.nFft, hop = this.hop, bins = this.bins;
    const frame = this.frame, w = this.window, re = this.re, im = this.im;
    const paddedLen = nFft + hop * (T - 1);
    const outLen = hop * (T - 1);
    if (!this._acc || this._acc.length !== paddedLen) {
      this._acc = new Float64Array(paddedLen);
      this._env = new Float64Array(paddedLen);
      // window-square envelope is identical for every channel/chunk of the same T
      const env = this._env;
      for (let t = 0; t < T; t++) {
        const o = t * hop;
        for (let i = 0; i < nFft; i++) env[o + i] += w[i] * w[i];
      }
    }
    const acc = this._acc, env = this._env;
    for (let c = 0; c < outChannels.length; c++) {
      acc.fill(0);
      const reBase = (2 * c) * dimF * T, imBase = (2 * c + 1) * dimF * T;
      for (let t = 0; t < T; t++) {
        for (let f = 0; f < dimF; f++) { re[f] = spec[reBase + f * T + t]; im[f] = spec[imBase + f * T + t]; }
        for (let f = dimF; f < bins; f++) { re[f] = 0; im[f] = 0; }
        this.fft.inverse(re, im, frame);
        const o = t * hop;
        for (let i = 0; i < nFft; i++) acc[o + i] += frame[i] * w[i];
      }
      const out = outChannels[c];
      for (let i = 0; i < outLen; i++) {
        const e = env[i + pad];
        out[i] = e > 1e-11 ? acc[i + pad] / e : acc[i + pad];
      }
    }
  }
}
