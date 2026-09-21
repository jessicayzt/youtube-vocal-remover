// Shared PCM stores for one video: mixture and instrumental as Int16 with 3.5 dB headroom,
// plus per-block readiness bitmaps. Everything lives in SharedArrayBuffers so the separator
// worker and the playback AudioWorklet read/write them without copies.
export const SAMPLE_RATE = 44100;
export const BLOCK_SIZE = 1024;
export const INT16_SCALE = 21845; // 32767 / 1.5

export class TrackBuffers {
  constructor(totalSamples) {
    this.totalSamples = totalSamples;
    this.numBlocks = Math.ceil(totalSamples / BLOCK_SIZE);
    const sab = (bytes) => new SharedArrayBuffer(bytes);
    this.mixL = new Int16Array(sab(totalSamples * 2));
    this.mixR = new Int16Array(sab(totalSamples * 2));
    this.instL = new Int16Array(sab(totalSamples * 2));
    this.instR = new Int16Array(sab(totalSamples * 2));
    this.mixReady = new Uint8Array(sab(this.numBlocks));
    this.instReady = new Uint8Array(sab(this.numBlocks));
  }

  get bytes() { return this.totalSamples * 8 + this.numBlocks * 2; }

  shareable() {
    return {
      totalSamples: this.totalSamples, blockSize: BLOCK_SIZE, scale: INT16_SCALE, sampleRate: SAMPLE_RATE,
      mixL: this.mixL.buffer, mixR: this.mixR.buffer, instL: this.instL.buffer, instR: this.instR.buffer,
      mixReady: this.mixReady.buffer, instReady: this.instReady.buffer,
    };
  }

  /** Copy float samples into the mixture store at sample offset `at`. */
  writeMixture(at, left, right) {
    const s = INT16_SCALE, n = left.length;
    const L = this.mixL, Rr = this.mixR;
    for (let i = 0; i < n; i++) {
      const x = at + i;
      if (x < 0 || x >= this.totalSamples) continue;
      let l = left[i] * s, r = right[i] * s;
      L[x] = l > 32767 ? 32767 : l < -32768 ? -32768 : Math.round(l);
      Rr[x] = r > 32767 ? 32767 : r < -32768 ? -32768 : Math.round(r);
    }
  }

  /** Mark blocks fully inside [startSample, endSample) as decoded. */
  markMixReady(startSample, endSample) {
    const b0 = Math.ceil(startSample / BLOCK_SIZE);
    let b1 = Math.floor(endSample / BLOCK_SIZE); // exclusive block index
    if (endSample >= this.totalSamples) b1 = this.numBlocks;
    for (let b = b0; b < b1; b++) this.mixReady[b] = 1;
  }

  /**
   * Recompute readiness for every block touching [startSample, endSample) from the union of
   * decoded ranges, so blocks straddling two decode windows become ready once both are in.
   */
  syncMixReady(ranges, startSample, endSample) {
    const b0 = Math.max(0, Math.floor(startSample / BLOCK_SIZE) - 1);
    const b1 = Math.min(this.numBlocks - 1, Math.floor(Math.max(0, endSample - 1) / BLOCK_SIZE) + 1);
    for (let b = b0; b <= b1; b++) {
      const s = b * BLOCK_SIZE, e = Math.min(this.totalSamples, s + BLOCK_SIZE);
      let covered = 0;
      for (const r of ranges) { if (r[0] <= s && r[1] >= e) { covered = 1; break; } if (r[0] > s) break; }
      this.mixReady[b] = covered;
    }
  }

  isMixReady(startSample, endSample) {
    const b0 = Math.max(0, Math.floor(startSample / BLOCK_SIZE));
    const b1 = Math.min(this.numBlocks - 1, Math.floor((endSample - 1) / BLOCK_SIZE));
    for (let b = b0; b <= b1; b++) if (!this.mixReady[b]) return false;
    return true;
  }

  /**
   * True when every block in the range can be played through our engine: either the mixture is
   * decoded, or the instrumental for it is known (a cached instrumental plays on its own).
   */
  isPlayable(startSample, endSample) {
    const b0 = Math.max(0, Math.floor(startSample / BLOCK_SIZE));
    const b1 = Math.min(this.numBlocks - 1, Math.floor((endSample - 1) / BLOCK_SIZE));
    for (let b = b0; b <= b1; b++) if (!this.mixReady[b] && !this.instReady[b]) return false;
    return true;
  }

  countReady(bitmap) { let n = 0; for (let i = 0; i < bitmap.length; i++) n += bitmap[i]; return n; }

  /** Restore from a cache record. */
  restore(record) {
    if (record.totalSamples !== this.totalSamples) return false;
    this.mixL.set(new Int16Array(record.mixL)); this.mixR.set(new Int16Array(record.mixR));
    this.instL.set(new Int16Array(record.instL)); this.instR.set(new Int16Array(record.instR));
    this.mixReady.set(new Uint8Array(record.mixReady)); this.instReady.set(new Uint8Array(record.instReady));
    return true;
  }

  /** Plain-ArrayBuffer copies for IndexedDB. */
  snapshot() {
    const copy = (a) => { const out = new a.constructor(a.length); out.set(a); return out.buffer; };
    return { mixL: copy(this.mixL), mixR: copy(this.mixR), instL: copy(this.instL), instR: copy(this.instR), mixReady: copy(this.mixReady), instReady: copy(this.instReady) };
  }
}
