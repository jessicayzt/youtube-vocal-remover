// MDX-Net chunking + overlap-add bookkeeping, mirroring UVR's MdxSeparator.demix():
//   chunk_size = hop * (dim_t - 1); trim = n_fft // 2; step = int((1 - overlap) * chunk_size)
//   mixture is padded with `trim` zeros in front; chunks are windowed with np.hanning(chunk) and
//   normalised by the summed windows; output is trimmed back and multiplied by `compensate`.
// Here chunk k covers original-sample range [k*step - trim, k*step - trim + chunkSize).
// Chunks may be processed in any order; a block of samples becomes final once every chunk
// that overlaps it has been processed.
import { symmetricHann } from './stft.js';

export class MdxGrid {
  /**
   * @param {object} p { nFft, hop, dimT, overlap, totalSamples, blockSize }
   */
  constructor({ nFft, hop, dimT, overlap, totalSamples, blockSize = 1024 }) {
    this.nFft = nFft; this.hop = hop; this.dimT = dimT;
    this.chunkSize = hop * (dimT - 1);
    this.trim = nFft >> 1;
    this.overlap = overlap;
    this.step = overlap > 0 ? Math.floor((1 - overlap) * this.chunkSize) : this.chunkSize;
    if (this.step < 1) throw new Error('overlap too large');
    this.totalSamples = totalSamples;
    this.blockSize = blockSize;
    this.numBlocks = Math.ceil(totalSamples / blockSize);
    // last chunk index needed so that every sample < totalSamples is covered
    this.numChunks = Math.floor((totalSamples - 1 + this.trim) / this.step) + 1;
    this.window = overlap > 0 ? symmetricHann(this.chunkSize) : null;
  }

  chunkStart(k) { return k * this.step - this.trim; }          // may be negative
  chunkEnd(k) { return this.chunkStart(k) + this.chunkSize; }  // exclusive

  /** Inclusive chunk index range covering sample x (before clamping to [0, numChunks-1]). */
  chunksCoveringSample(x) {
    const kmin = Math.floor((x + this.trim - this.chunkSize) / this.step) + 1;
    const kmax = Math.floor((x + this.trim) / this.step);
    return [Math.max(0, kmin), Math.min(this.numChunks - 1, kmax)];
  }

  /** Inclusive chunk range covering block b. */
  chunksCoveringBlock(b) {
    const x0 = b * this.blockSize;
    const x1 = Math.min(this.totalSamples, x0 + this.blockSize) - 1;
    const [kmin] = this.chunksCoveringSample(x0);
    const [, kmax] = this.chunksCoveringSample(x1);
    return [kmin, kmax];
  }

  /** Inclusive block range touched by chunk k (clamped to the signal). */
  blocksOfChunk(k) {
    const s = Math.max(0, this.chunkStart(k));
    const e = Math.min(this.totalSamples, this.chunkEnd(k));
    if (e <= s) return null;
    return [Math.floor(s / this.blockSize), Math.floor((e - 1) / this.blockSize)];
  }

  /** Chunk index of the first chunk whose processing is needed to finalise sample x. */
  firstChunkForSample(x) { return this.chunksCoveringSample(Math.max(0, Math.min(this.totalSamples - 1, x)))[0]; }
}

/**
 * Accumulates per-chunk model outputs and finalises blocks.
 * readMixture(startSample, length, outL, outR) must fill zeros outside the signal.
 */
export class MdxAccumulator {
  constructor(grid, { compensate = 1, onBlockFinal }) {
    this.grid = grid;
    this.compensate = compensate;
    this.onBlockFinal = onBlockFinal; // (blockIndex, Float32Array L, Float32Array R) with length = samples in block
    this.processed = new Uint8Array(grid.numChunks);
    this.finalBlocks = new Uint8Array(grid.numBlocks);
    this.pending = new Map(); // k -> { L, R, remainingBlocks }
    this.processedCount = 0;
    this.finalCount = 0;
    this._tmpL = new Float32Array(grid.blockSize);
    this._tmpR = new Float32Array(grid.blockSize);
    this._wsum = new Float64Array(grid.blockSize);
    this._accL = new Float64Array(grid.blockSize);
    this._accR = new Float64Array(grid.blockSize);
  }

  isProcessed(k) { return this.processed[k] === 1; }

  /** Smallest unprocessed chunk index >= from, or -1. */
  nextUnprocessed(from = 0) {
    for (let k = Math.max(0, from); k < this.grid.numChunks; k++) if (!this.processed[k]) return k;
    return -1;
  }

  /**
   * Register the model output for chunk k (two Float32Array of chunkSize, in chunk coordinates).
   * Returns the list of block indices finalised by this call.
   */
  addChunkOutput(k, outL, outR) {
    if (this.processed[k]) return [];
    const grid = this.grid;
    const range = grid.blocksOfChunk(k);
    this.processed[k] = 1;
    this.processedCount++;
    if (!range) return [];
    this.pending.set(k, { L: outL, R: outR });
    const finalised = [];
    for (let b = range[0]; b <= range[1]; b++) {
      if (this.finalBlocks[b]) continue;
      const [kmin, kmax] = grid.chunksCoveringBlock(b);
      let ready = true;
      for (let j = kmin; j <= kmax; j++) if (!this.processed[j]) { ready = false; break; }
      if (!ready) continue;
      this._finaliseBlock(b, kmin, kmax); // may release pending outputs, including chunk k itself
      finalised.push(b);
    }
    if (this.pending.has(k) && this._chunkFullyFinal(k)) this.pending.delete(k);
    return finalised;
  }

  _finaliseBlock(b, kmin, kmax) {
    const grid = this.grid, bs = grid.blockSize;
    const x0 = b * bs;
    const n = Math.min(grid.totalSamples, x0 + bs) - x0;
    const accL = this._accL, accR = this._accR, wsum = this._wsum;
    accL.fill(0, 0, n); accR.fill(0, 0, n); wsum.fill(0, 0, n);
    const win = grid.window;
    for (let k = kmin; k <= kmax; k++) {
      const p = this.pending.get(k);
      if (!p) continue; // should not happen: processed but released
      const cs = grid.chunkStart(k);
      for (let i = 0; i < n; i++) {
        const idx = x0 + i - cs; // index inside chunk
        if (idx < 0 || idx >= grid.chunkSize) continue;
        const w = win ? win[idx] : 1;
        accL[i] += p.L[idx] * w; accR[i] += p.R[idx] * w; wsum[i] += w;
      }
    }
    const outL = this._tmpL, outR = this._tmpR, comp = this.compensate;
    for (let i = 0; i < n; i++) {
      let s = wsum[i];
      if (s > 1e-9) { outL[i] = accL[i] / s * comp; outR[i] = accR[i] / s * comp; }
      else {
        // window edge with a single covering chunk: fall back to that chunk's raw output
        let l = 0, r = 0;
        for (let k = kmin; k <= kmax; k++) {
          const p = this.pending.get(k); if (!p) continue;
          const idx = x0 + i - grid.chunkStart(k);
          if (idx >= 0 && idx < grid.chunkSize) { l = p.L[idx]; r = p.R[idx]; }
        }
        outL[i] = l * comp; outR[i] = r * comp;
      }
    }
    this.finalBlocks[b] = 1;
    this.finalCount++;
    this.onBlockFinal(b, outL.subarray(0, n), outR.subarray(0, n));
    // release chunk outputs no longer needed
    for (let k = kmin; k <= kmax; k++) {
      const p = this.pending.get(k);
      if (!p) continue;
      if (this._chunkFullyFinal(k)) this.pending.delete(k);
    }
  }

  _chunkFullyFinal(k) {
    const range = this.grid.blocksOfChunk(k);
    if (!range) return true;
    for (let b = range[0]; b <= range[1]; b++) if (!this.finalBlocks[b]) return false;
    return true;
  }
}

/**
 * Fill chunk input [L, R] (Float32Array chunkSize) for chunk k from a sample reader.
 * reader(start, count, outL, outR) fills samples in original coordinates; it must zero
 * out-of-range samples itself.
 */
export function fillChunkInput(grid, k, reader, outL, outR) {
  reader(grid.chunkStart(k), grid.chunkSize, outL, outR);
}
