// Range-list helpers shared by content scripts (classic script) and the offscreen page.
// A range list is a sorted array of [start, end) pairs (numbers), non-overlapping.
(function (root) {
  function normalize(ranges) {
    const sorted = ranges.filter((r) => r && r[1] > r[0]).slice().sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1]) { if (r[1] > last[1]) last[1] = r[1]; }
      else out.push([r[0], r[1]]);
    }
    return out;
  }
  function add(ranges, start, end) { return normalize(ranges.concat([[start, end]])); }
  function total(ranges) { let t = 0; for (const r of ranges) t += r[1] - r[0]; return t; }
  function covers(ranges, start, end) {
    for (const r of ranges) if (r[0] <= start && r[1] >= end) return true;
    return false;
  }
  function contains(ranges, x) {
    for (const r of ranges) if (x >= r[0] && x < r[1]) return true;
    return false;
  }
  /** First uncovered point >= from, or null when everything up to `limit` is covered. */
  function firstGap(ranges, from, limit) {
    let p = from;
    for (const r of ranges) {
      if (r[1] <= p) continue;
      if (r[0] > p) return p;
      p = r[1];
      if (p >= limit) return null;
    }
    return p >= limit ? null : p;
  }
  /** Convert a block bitmap (Uint8Array, one byte per block) into a range list in seconds. */
  function fromBitmap(bitmap, blockSize, sampleRate, totalSamples) {
    const out = [];
    let start = -1;
    for (let b = 0; b <= bitmap.length; b++) {
      const on = b < bitmap.length && bitmap[b] === 1;
      if (on && start < 0) start = b;
      if (!on && start >= 0) {
        const s = start * blockSize, e = Math.min(totalSamples, b * blockSize);
        out.push([s / sampleRate, e / sampleRate]);
        start = -1;
      }
    }
    return out;
  }
  const api = { normalize, add, total, covers, contains, firstGap, fromBitmap };
  root.VRX = root.VRX || {};
  root.VRX.ranges = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
