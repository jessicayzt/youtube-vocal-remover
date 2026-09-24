// Turns captured MSE byte streams into decoded PCM inside a TrackBuffers, incrementally.
//   SegmentStore  – one ByteStreamParser per SourceBuffer stream; keeps complete media units
//                   with absolute times (container time + SourceBuffer.timestampOffset).
//   IncrementalDecoder – picks the earliest undecoded gap, finds a contiguous run of segments
//                   covering it, decodes a window (with one-segment margins so codec pre-roll
//                   never lands inside the region we keep) via decodeAudioData, and copies the
//                   result into the shared mixture store.
import { ByteStreamParser, buildFile } from '../media/segments.js';
import { SAMPLE_RATE } from './buffers.js';

const R = globalThis.VRX.ranges;
const GAP_TOLERANCE = 0.04;      // seconds; segments closer than this are considered contiguous
const WINDOW_SECONDS = 40;       // decode at most this much per decodeAudioData call
const MIN_WINDOW_SECONDS = 1;    // decode as soon as this much is available with a trailing margin segment
const SETTLE_MS = 1500;          // a stream with no new data for this long is decoded as-is
const DECODE_TIMEOUT_MS = 20000; // decodeAudioData that takes longer is treated as failed
const FAILED_RETRY_MS = 30000;   // a window the browser rejected is tried again after this long ...
const FAILED_MAX_TRIES = 3;      // ... this many times in all (other sources may have arrived meanwhile)

const QUARANTINE_MS = 1200;      // a fresh segment is not used until this long after it arrived (see onAdStart)
const AD_LEAD_MS = 8000;         // a stream first seen this shortly before an ad began is the ad's own

export class SegmentStore {
  constructor({ quarantineMs = QUARANTINE_MS } = {}) {
    this.streams = new Map();
    this.version = 0; // bumps on every accepted media unit
    this.lastAppendAt = 0;
    this.youngestAcceptedAt = 0;
    this.quarantineMs = quarantineMs;
    this.droppedAd = 0;
    this.droppedAdRetro = 0; // segments taken back when an ad turned out to have begun
    this.droppedForeign = 0; // appends whose MediaSource has a different length than this video
  }

  _stream(key, source, mime) {
    let s = this.streams.get(key);
    if (!s) {
      s = { key, source, mime, parser: new ByteStreamParser(), init: null, initBytes: null, epoch: 0, segments: [], lastAppendAt: 0, firstSeenAt: Date.now() };
      this.streams.set(key, s);
    }
    return s;
  }

  /** Segments younger than the quarantine are not used yet: an ad that turns out to have begun can still take them back. */
  _usable(seg, now) { return now - seg.acceptedAt >= this.quarantineMs; }

  /** @returns number of media units accepted */
  ingest({ key, source, mime, bytes, tsOffset = 0, ad = false, expectedDuration = null, msDuration = null }) {
    // Ignore streams that clearly belong to a different media item, such as an ad with its own
    // MediaSource. The tolerance is generous on purpose: a stream whose duration merely differs a
    // little from the video element's is still this video, and rejecting it would leave the track
    // permanently empty.
    const known = !!expectedDuration && Number.isFinite(msDuration) && msDuration > 0;
    if (known && Math.abs(msDuration - expectedDuration) > Math.max(10, expectedDuration * 0.1)) { this.droppedForeign++; return 0; }
    // The flag is the player's state at append time, and it is final. An ad's MediaSource can
    // report the video's own length, so the length test above does not catch every ad; letting a
    // flagged append through on the strength of its length put ad audio into the mixture.
    if (ad) {
      this.droppedAd++;
      // whatever this stream had half-parsed must not be glued onto the content that follows the ad
      const s = this.streams.get(key);
      if (s) s.parser.reset();
      return 0;
    }
    const s = this._stream(key, source, mime);
    let units;
    try { units = s.parser.push(bytes); } catch (e) { console.warn('[VocalRemover] parser error, resetting stream', key, e); s.parser.reset(); return 0; }
    let accepted = 0;
    const now = Date.now();
    for (const u of units) {
      if (u.kind === 'init') { s.init = u.info; s.initBytes = u.bytes; s.initKey = hashBytes(u.bytes); s.epoch++; continue; }
      if (u.kind !== 'media' || !s.initBytes) continue;
      const start = u.info.start + tsOffset, end = u.info.end + tsOffset;
      if (!(end > start) || start < -0.5) continue;
      const seg = { start, end, bytes: u.bytes, epoch: s.epoch, initKey: s.initKey, stream: s, acceptedAt: now };
      // insert sorted, skipping exact duplicates (same start within 1 ms)
      const list = s.segments;
      let lo = 0, hi = list.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].start < start) lo = mid + 1; else hi = mid; }
      if ((list[lo] && Math.abs(list[lo].start - start) < 0.001) || (list[lo - 1] && Math.abs(list[lo - 1].start - start) < 0.001)) continue;
      list.splice(lo, 0, seg);
      accepted++;
    }
    if (accepted) { this.version++; this.lastAppendAt = s.lastAppendAt = now; this.youngestAcceptedAt = now; }
    return accepted;
  }

  /** Time until which some accepted segment is still held back by the quarantine. */
  quarantinedUntil() { return this.youngestAcceptedAt + this.quarantineMs; }

  reset(key) { const s = this.streams.get(key); if (s) s.parser.reset(); }

  /**
   * An ad has begun on the player whose streams start with `keyPrefix`. Its media can be appended a
   * moment before the player says so, unflagged: take back what that player's streams received
   * within the quarantine period, and everything from a stream that appeared only just before the
   * ad, which is the ad's own MediaSource. Headers already parsed are kept, so a content stream
   * caught by this only loses a few seconds that the helper fills in.
   */
  onAdStart(keyPrefix) {
    const now = Date.now();
    let dropped = 0;
    for (const s of this.streams.values()) {
      if (!s.key.startsWith(keyPrefix)) continue;
      const young = now - s.firstSeenAt < AD_LEAD_MS;
      const kept = s.segments.filter((seg) => !young && this._usable(seg, now));
      if (kept.length !== s.segments.length) { dropped += s.segments.length - kept.length; s.segments = kept; s.parser.reset(); }
    }
    if (dropped) { this.droppedAdRetro += dropped; this.version++; }
    return dropped;
  }

  /** Union of captured time ranges (seconds); sub-frame gaps between segments are bridged. */
  coverage() {
    const now = Date.now();
    const ranges = [];
    for (const s of this.streams.values()) for (const seg of s.segments) if (this._usable(seg, now)) ranges.push([seg.start, seg.end]);
    const merged = [];
    for (const r of R.normalize(ranges)) {
      const last = merged[merged.length - 1];
      if (last && r[0] - last[1] <= GAP_TOLERANCE) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    return merged;
  }

  /** Start time of the first captured segment beginning after t, or null. */
  nextCoveredStart(t) {
    const now = Date.now();
    let best = null;
    for (const s of this.streams.values()) {
      if (!s.initBytes) continue;
      for (const seg of s.segments) { if (seg.start > t + GAP_TOLERANCE && this._usable(seg, now)) { if (best === null || seg.start < best) best = seg.start; break; } }
    }
    return best;
  }

  /**
   * Contiguous run of segments containing time t, or null. Streams whose init segments are
   * byte-identical (e.g. the main player and the helper embed fetching the same format) are
   * merged, so a decode window can take its margin segment from either of them.
   */
  runAt(t) {
    const now = Date.now();
    const groups = new Map(); // initKey -> { initBytes, init, segments[], lastAppendAt }
    for (const s of this.streams.values()) {
      if (!s.initBytes) continue;
      for (const seg of s.segments) {
        if (!this._usable(seg, now)) continue;
        let g = groups.get(seg.initKey);
        if (!g) { g = { initBytes: null, init: null, segments: [], lastAppendAt: 0 }; groups.set(seg.initKey, g); }
        if (seg.initKey === s.initKey) { g.initBytes = s.initBytes; g.init = s.init; }
        g.segments.push(seg);
        if (s.lastAppendAt > g.lastAppendAt) g.lastAppendAt = s.lastAppendAt;
      }
    }
    let best = null;
    for (const g of groups.values()) {
      if (!g.initBytes) continue;
      g.segments.sort((a, b) => a.start - b.start);
      // drop near-duplicates coming from different streams
      const list = [];
      for (const seg of g.segments) {
        const last = list[list.length - 1];
        if (last && seg.start - last.start < 0.001) { if (seg.end > last.end) list[list.length - 1] = seg; continue; }
        if (last && seg.end <= last.end) continue; // fully covered
        list.push(seg);
      }
      let idx = -1;
      for (let i = 0; i < list.length; i++) {
        const seg = list[i];
        if (seg.start <= t + GAP_TOLERANCE && seg.end > t) { idx = i; break; }
        if (seg.start > t + GAP_TOLERANCE) break;
      }
      if (idx < 0) continue;
      let a = idx, b = idx;
      while (a > 0 && list[a].start - list[a - 1].end <= GAP_TOLERANCE) a--;
      while (b + 1 < list.length && list[b + 1].start - list[b].end <= GAP_TOLERANCE) b++;
      // Settled means the stream that delivered this run's last segment has gone quiet, not the whole
      // group: the main player appending somewhere else in the video (the same format, so the same
      // group) must not keep a finished helper's tail window waiting for a margin that never comes.
      const run = { initBytes: g.initBytes, init: g.init, list, first: a, last: b, index: idx, settled: now - list[b].stream.lastAppendAt > SETTLE_MS };
      if (!best || list[b].end > best.list[best.last].end) best = run;
    }
    return best;
  }
}

function hashBytes(u8) {
  let h = 0x811c9dc5;
  for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return u8.length + ':' + h.toString(16);
}

export class IncrementalDecoder {
  /**
   * @param {SegmentStore} store
   * @param {import('./buffers.js').TrackBuffers} buffers
   * @param {(info: object) => void} onProgress
   */
  constructor(store, buffers, onProgress, { windowSeconds = WINDOW_SECONDS, minWindowSeconds = MIN_WINDOW_SECONDS, failedRetryMs = FAILED_RETRY_MS } = {}) {
    this.store = store;
    this.buffers = buffers;
    this.onProgress = onProgress;
    this.windowSeconds = windowSeconds;
    this.minWindowSeconds = minWindowSeconds;
    this.failedRetryMs = failedRetryMs;
    this.decodedSamples = []; // ranges in samples that hold real audio
    this.failed = [];         // { a, b, tries, at }: ranges in samples the browser could not decode (never played through us)
    this.running = false;
    this.errorCount = 0;
    this.captureComplete = false;
    this.error = null;
    this.ctx = null;
    this.decodedSecondsTotal = 0;
    this.lastVersion = -1;
    this.settleTimer = null;
  }

  get totalSamples() { return this.buffers.totalSamples; }
  decodedRanges() { return this.decodedSamples.map(([a, b]) => [a / SAMPLE_RATE, b / SAMPLE_RATE]); }
  isComplete() { return this.decodedSamples.length === 1 && this.decodedSamples[0][0] === 0 && this.decodedSamples[0][1] >= this.totalSamples; }
  /** Failed ranges still standing, as [a, b] samples (ranges whose retry is due do not count: they are gaps again). */
  get failedRanges() { const now = Date.now(); return this.failed.filter((f) => !this._retryDue(f, now)).map((f) => [f.a, f.b]); }
  failedRangesSeconds() { return this.failedRanges.map(([a, b]) => [a / SAMPLE_RATE, b / SAMPLE_RATE]); }
  _attempted() { return R.normalize(this.decodedSamples.concat(this.failedRanges)); }
  _retryDue(f, now) { return f.tries < FAILED_MAX_TRIES && now - f.at >= this.failedRetryMs; }
  _recordFailure(a, b) {
    const hit = this.failed.find((f) => f.a < b && a < f.b);
    if (hit) { hit.a = Math.min(hit.a, a); hit.b = Math.max(hit.b, b); hit.tries++; hit.at = Date.now(); }
    else this.failed.push({ a, b, tries: 1, at: Date.now() });
  }
  /** Earliest time a standing failure becomes due for another try, or null. */
  _nextRetryAt() {
    let t = null;
    for (const f of this.failed) if (f.tries < FAILED_MAX_TRIES) { const due = f.at + this.failedRetryMs; if (t === null || due < t) t = due; }
    return t;
  }

  /** Called whenever new segments may be available or capture state changed. */
  pump() {
    if (this.running) { this.rerun = true; return; }
    this.running = true;
    this.error = null; // a failure is retried on the next pump rather than sticking
    this._loop().then(() => { this.errorCount = 0; }, (e) => {
      // an exception must not leave the decoder waiting for an append that may never come
      this.error = e; this.errorCount++;
      console.error('[VocalRemover] decoder failed', e);
      this._scheduleSettle(Math.min(30000, 1000 * 2 ** Math.min(this.errorCount, 5)));
    }).finally(() => {
      this.running = false;
      if (this.rerun) { this.rerun = false; this.pump(); }
      else { const due = this._nextRetryAt(); if (due !== null) this._scheduleSettle(Math.max(200, due - Date.now())); }
    });
  }

  /**
   * A run that is still growing is skipped until it has settled, and it settles by *time*: if no
   * further append ever comes (the helper is done or gone, the player paused), nothing would ever
   * look at it again and the last window of captured audio stayed undecoded -- and unprocessed.
   * The same timer brings failed windows back for another try. Only the earliest pending wake-up
   * is kept.
   */
  _scheduleSettle(delay = SETTLE_MS + 200) {
    const at = Date.now() + delay;
    if (this.settleTimer && this.settleAt <= at) return;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleAt = at;
    this.settleTimer = setTimeout(() => { this.settleTimer = null; this.pump(); }, delay);
    if (this.settleTimer && typeof this.settleTimer.unref === 'function') this.settleTimer.unref(); // Node (tests): never keep the process alive
  }

  /** Segments the store still holds back (see SegmentStore.onAdStart) need a look once released, even if nothing else arrives. */
  _quarantinePending() { return Date.now() < this.store.quarantinedUntil(); }

  async _loop() {
    let from = 0;
    let unsettled = false; // a growing run was skipped: come back once it has settled
    for (;;) {
      const gap = R.firstGap(this._attempted(), from, this.totalSamples);
      if (gap === null) {
        if (from === 0 && !this.captureComplete) {
          this.captureComplete = true;
          this.onProgress({ complete: true, failed: this.failedRanges.length > 0 });
        }
        if (unsettled || this._quarantinePending()) this._scheduleSettle();
        return;
      }
      const gapSec = gap / SAMPLE_RATE;
      const run = this.store.runAt(gapSec);
      if (!run) {
        // nothing covers this gap yet; if capture ended and only a short tail is missing, silence it
        if (this.finishing && this.totalSamples - gap < SAMPLE_RATE * 1.5) { this._silence(gap, this.totalSamples); continue; }
        // otherwise look for decodable material further on
        const next = this.store.nextCoveredStart(gapSec);
        if (next === null) { if (unsettled || this._quarantinePending()) this._scheduleSettle(); return; }
        from = Math.max(gap + 1, Math.round(next * SAMPLE_RATE));
        continue;
      }
      const { list, first, last, index } = run;
      let j = index;
      while (j + 1 <= last && list[j + 1].end - list[index].start <= this.windowSeconds) j++;
      const available = list[j].end - Math.max(gapSec, list[index].start);
      const reachesEnd = list[last].end >= this.totalSamples / SAMPLE_RATE - 0.05;
      const hasTrailingMargin = j < last;
      const ready = reachesEnd || run.settled || this.finishing || (hasTrailingMargin && available >= this.minWindowSeconds);
      if (!ready) {
        // this run is still growing; meanwhile other regions may be decodable
        unsettled = true;
        from = Math.max(gap + 1, Math.round(list[last].end * SAMPLE_RATE));
        continue;
      }
      const mStart = index > first ? index - 1 : index; // margin before
      const mEnd = j < last ? j + 1 : j;                 // margin after
      let ok = await this._decodeWindow(run, list, mStart, index, j, mEnd, gap);
      if (!ok) {
        // the browser rejected the assembled file: narrow down to the segment at the gap, trying
        // with and without each margin so a bad neighbour does not take a good segment down with it
        const tries = [[mStart, index < last ? index + 1 : index], [index, index < last ? index + 1 : index], [mStart, index], [index, index]];
        const seen = new Set();
        for (const [a, b] of tries) {
          const key = a + ':' + b;
          if (seen.has(key) || (a === mStart && b === mEnd && j === index)) continue;
          seen.add(key);
          ok = await this._decodeWindow(run, list, a, index, index, b, gap);
          if (ok) break;
        }
      }
      if (!ok) {
        // skip this one segment for now: it stays unprocessed (YouTube's own audio plays there),
        // never silent-green, and is tried again later, when another source may have supplied it
        const b = Math.min(this.totalSamples, Math.max(gap + 1, Math.round(list[index].end * SAMPLE_RATE)));
        this._recordFailure(gap, b);
        this.onProgress({ decoded: this.decodedRanges(), failed: this.failedRangesSeconds() });
      }
      // guarantee forward progress even if the window produced nothing usable
      if (R.firstGap(this._attempted(), gap, this.totalSamples) === gap) this._recordFailure(gap, Math.min(this.totalSamples, gap + Math.round(SAMPLE_RATE * 0.05)));
      from = 0; // earlier gaps regain priority after each decode
    }
  }

  _silence(startSample, endSample) {
    this.decodedSamples = R.add(this.decodedSamples, startSample, endSample);
    this._pruneFailed();
    this.buffers.syncMixReady(this.decodedSamples, startSample, endSample);
    this.onProgress({ decoded: this.decodedRanges() });
  }

  async _decodeWindow(run, list, mStart, wStart, wEnd, mEnd, gapSample) {
    const segs = list.slice(mStart, mEnd + 1);
    const file = buildFile(run.initBytes, segs.map((s) => s.bytes), run.init.container);
    if (!this.ctx) this.ctx = new OfflineAudioContext(2, 1, SAMPLE_RATE);
    // decodeAudioData detaches the buffer it is given, so hand it a copy
    const ab = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
    let audio;
    const ctx = this.ctx;
    let timer = null;
    try {
      // a decode that never comes back would wedge the whole decoder: treat it as a failure and
      // start over with a fresh context
      audio = await Promise.race([
        ctx.decodeAudioData(ab),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('decodeAudioData timed out')), DECODE_TIMEOUT_MS); }),
      ]);
    } catch (e) {
      if (String(e && e.message).includes('timed out') && this.ctx === ctx) this.ctx = null;
      console.debug('[VocalRemover] decodeAudioData rejected a window', segs[0].start.toFixed(2), '-', segs[segs.length - 1].end.toFixed(2), run.init.container, run.init.codec, segs.length, 'segments', String(e && e.message || e));
      return false;
    } finally { if (timer) clearTimeout(timer); }
    const firstStart = segs[0].start;
    const expected = Math.round((segs[segs.length - 1].end - firstStart) * SAMPLE_RATE);
    const actual = audio.length;
    let decodedStart = firstStart;
    // mid-stream windows lose the codec pre-roll at the very beginning: realign by the shortfall
    const shortfall = expected - actual;
    if (firstStart > 0.01 && shortfall > 0 && shortfall < SAMPLE_RATE * 0.25) decodedStart += shortfall / SAMPLE_RATE;
    const L = audio.getChannelData(0);
    const Rch = audio.numberOfChannels > 1 ? audio.getChannelData(1) : L;
    const decodedStartSample = Math.round(decodedStart * SAMPLE_RATE);
    // keep everything from the gap onwards that the decoded audio covers (the leading margin's
    // audio is real audio and closes sub-frame holes between segment boundaries), but not the
    // trailing margin segment
    const keepStart = Math.max(gapSample, decodedStartSample);
    const keepEnd = Math.min(this.totalSamples, Math.round(list[wEnd].end * SAMPLE_RATE), decodedStartSample + actual);
    if (keepStart > gapSample) {
      // a few samples in front of the decoded audio can never be recovered (codec pre-roll at a
      // format seam, or a sub-frame hole): fill with silence so the gap does not stall
      this._silence(gapSample, Math.min(keepStart, this.totalSamples));
    }
    if (keepEnd <= keepStart) {
      const to = Math.min(this.totalSamples, Math.max(keepStart + 1, Math.round(list[wEnd].end * SAMPLE_RATE)));
      if (to > keepStart) this._silence(keepStart, to);
      return true;
    }
    const n = keepEnd - keepStart;
    this.buffers.writeMixture(keepStart, L.subarray(keepStart - decodedStartSample, keepStart - decodedStartSample + n), Rch.subarray(keepStart - decodedStartSample, keepStart - decodedStartSample + n));
    this.decodedSamples = R.add(this.decodedSamples, keepStart, keepEnd);
    this._pruneFailed();
    this.buffers.syncMixReady(this.decodedSamples, keepStart, keepEnd);
    this.decodedSecondsTotal += n / SAMPLE_RATE;
    this.onProgress({ decoded: this.decodedRanges() });
    return true;
  }

  /** Seconds the browser refused to decode for good (all tries used); YouTube's own audio plays there. */
  exhaustedFailedSeconds() {
    let t = 0;
    for (const f of this.failed) if (f.tries >= FAILED_MAX_TRIES) t += (f.b - f.a) / SAMPLE_RATE;
    return t;
  }

  /** Failures that decoding has since covered are forgotten. */
  _pruneFailed() {
    if (this.failed.length) this.failed = this.failed.filter((f) => !R.covers(this.decodedSamples, f.a, f.b));
  }

  /** Capture has ended (helper finished or failed): allow decoding short/unsettled tails and silence tiny gaps. */
  finish() {
    this.finishing = true;
    if (this.failed.length) { this.failed = []; this.captureComplete = false; }
    this.pump();
  }
}
