// Glue test for SegmentStore + IncrementalDecoder using the WPT WebM fixture and a fake
// OfflineAudioContext whose decodeAudioData synthesises PCM from the file's own timing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ByteStreamParser } from '../src/media/segments.js';

// classic shared scripts expose globalThis.VRX
vm.runInThisContext(readFileSync(new URL('../src/shared/ranges.js', import.meta.url), 'utf8'));
vm.runInThisContext(readFileSync(new URL('../src/shared/base64.js', import.meta.url), 'utf8'));

const SR = 44100;
const PRESKIP = 312;
const decodeCalls = [];
// A decoder that returns sin(2*pi*440*t) for the absolute times covered by the file and, like a real
// Opus decoder handling a mid-stream file, drops the first PRESKIP samples when the file does not start at 0.
class FakeOfflineAudioContext {
  constructor(channels, length, sampleRate) { this.sampleRate = sampleRate; }
  async decodeAudioData(ab) {
    const p = new ByteStreamParser();
    const units = p.push(new Uint8Array(ab)).concat(p.flush());
    const media = units.filter((u) => u.kind === 'media');
    if (!media.length) throw new Error('no media');
    const bad = globalThis.__failIfStartIn; // [a, b] seconds: any file containing a cluster starting in this range is rejected
    if (bad && media.some((u) => u.info.start >= bad[0] && u.info.start <= bad[1])) throw new Error('EncodingError: unable to decode');
    const start = media[0].info.start, end = media[media.length - 1].info.end;
    let n = Math.round((end - start) * SR);
    let t0 = start;
    if (start > 0.001) { n -= PRESKIP; t0 = start + PRESKIP / SR; }
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = t0 + i / SR; L[i] = Math.sin(2 * Math.PI * 440 * t); R[i] = -L[i]; }
    decodeCalls.push({ start, end, n });
    return { length: n, numberOfChannels: 2, getChannelData: (c) => (c === 0 ? L : R) };
  }
}
globalThis.OfflineAudioContext = FakeOfflineAudioContext;

const { TrackBuffers, INT16_SCALE } = await import('../src/offscreen/buffers.js');
const { SegmentStore, IncrementalDecoder } = await import('../src/offscreen/decoder.js');

const fixture = new Uint8Array(readFileSync(new URL('./fixtures/test-a-128k-44100Hz-1ch.webm', import.meta.url)));
function fixtureUnits() {
  const p = new ByteStreamParser();
  return p.push(fixture).concat(p.flush());
}
const units = fixtureUnits();
const DURATION = units.filter((u) => u.kind === 'media').at(-1).info.end;

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(decoder) { for (let i = 0; i < 50 && decoder.running; i++) await sleep(5); }

function checkSamples(buffers, ranges) {
  let maxErr = 0, checked = 0;
  for (const [a, b] of ranges) {
    for (let x = a; x < b; x += 97) {
      const expected = Math.sin(2 * Math.PI * 440 * (x / SR));
      const got = buffers.mixL[x] / INT16_SCALE;
      maxErr = Math.max(maxErr, Math.abs(got - expected));
      checked++;
    }
  }
  return { maxErr, checked };
}

test('store ingests appends in arbitrary pieces, dedupes, drops ads and foreign media', () => {
  const store = new SegmentStore({ quarantineMs: 0 });
  const r = rng(5);
  let pos = 0;
  while (pos < fixture.length) { const n = 1 + Math.floor(r() * 3000); store.ingest({ key: 'a', source: 'embed', mime: 'audio/webm', bytes: fixture.subarray(pos, Math.min(fixture.length, pos + n)), expectedDuration: DURATION }); pos += n; }
  const s = store.streams.get('a');
  assert.equal(s.segments.length, units.filter((u) => u.kind === 'media').length);
  // duplicates from a second source are ignored
  store.ingest({ key: 'b', source: 'main', mime: 'audio/webm', bytes: fixture, expectedDuration: DURATION });
  assert.equal(store.coverage().length, 1);
  assert.ok(Math.abs(store.coverage()[0][1] - DURATION) < 1e-9);
  // ad-flagged and foreign-duration appends are dropped
  const before = store.version;
  store.ingest({ key: 'c', source: 'main', mime: 'audio/webm', bytes: fixture, ad: true, expectedDuration: DURATION });
  store.ingest({ key: 'd', source: 'main', mime: 'audio/webm', bytes: fixture, expectedDuration: DURATION, msDuration: 30 });
  assert.equal(store.version, before);
});

test('decoder fills the whole track from a complete stream and aligns samples', async () => {
  decodeCalls.length = 0;
  const store = new SegmentStore({ quarantineMs: 0 });
  const buffers = new TrackBuffers(Math.round(DURATION * SR));
  const progress = [];
  const decoder = new IncrementalDecoder(store, buffers, (p) => progress.push(p));
  store.ingest({ key: 'a', source: 'embed', mime: 'audio/webm', bytes: fixture, expectedDuration: DURATION });
  decoder.pump();
  await settle(decoder);
  assert.ok(decoder.isComplete(), 'decoded ranges cover the track: ' + JSON.stringify(decoder.decodedSamples));
  assert.equal(buffers.countReady(buffers.mixReady), buffers.numBlocks);
  assert.ok(progress.some((p) => p.complete));
  const { maxErr, checked } = checkSamples(buffers, decoder.decodedSamples);
  assert.ok(checked > 500);
  assert.ok(maxErr < 0.02, `sample alignment error ${maxErr}`);
});

test('decoder handles out-of-order arrival and merges two sources with identical inits', async () => {
  decodeCalls.length = 0;
  const store = new SegmentStore({ quarantineMs: 0 });
  const buffers = new TrackBuffers(Math.round(DURATION * SR));
  const decoder = new IncrementalDecoder(store, buffers, () => {});
  const init = units.find((u) => u.kind === 'init');
  const media = units.filter((u) => u.kind === 'media');
  // stream A: init + clusters 0..2 ; stream B (other source, same format): init + clusters 3..7 in reverse order
  store.ingest({ key: 'A', source: 'main', mime: 'audio/webm', bytes: init.bytes, expectedDuration: DURATION });
  for (const u of media.slice(0, 3)) store.ingest({ key: 'A', source: 'main', mime: 'audio/webm', bytes: u.bytes, expectedDuration: DURATION });
  store.ingest({ key: 'B', source: 'embed', mime: 'audio/webm', bytes: init.bytes, expectedDuration: DURATION });
  // nothing is settled yet and the run does not reach the end: the decoder must wait
  decoder.pump(); await settle(decoder);
  assert.equal(buffers.countReady(buffers.mixReady), 0);
  for (const u of media.slice(3).reverse()) store.ingest({ key: 'B', source: 'embed', mime: 'audio/webm', bytes: u.bytes, expectedDuration: DURATION });
  decoder.pump(); await settle(decoder);
  assert.ok(decoder.isComplete(), 'complete: ' + JSON.stringify(decoder.decodedSamples));
  // the two streams were merged into one run and decoded as a single window from 0 (no pre-skip loss)
  assert.equal(decodeCalls.length, 1);
  assert.ok(decodeCalls[0].start < 0.001);
  const { maxErr } = checkSamples(buffers, decoder.decodedSamples);
  assert.ok(maxErr < 0.02, `sample alignment error ${maxErr}`);
});

test('decoder uses a margin segment so mid-stream windows stay sample-aligned', async () => {
  decodeCalls.length = 0;
  const store = new SegmentStore({ quarantineMs: 0 });
  const buffers = new TrackBuffers(Math.round(DURATION * SR));
  const decoder = new IncrementalDecoder(store, buffers, () => {}, { windowSeconds: 0.6, minWindowSeconds: 0.5 });
  store.ingest({ key: 'A', source: 'embed', mime: 'audio/webm', bytes: fixture, expectedDuration: DURATION });
  decoder.pump(); await settle(decoder);
  assert.ok(decoder.isComplete(), 'complete: ' + JSON.stringify(decoder.decodedSamples));
  assert.ok(decodeCalls.length >= 3, 'several windows: ' + decodeCalls.length);
  assert.ok(decodeCalls.some((c) => c.start > 0.5), 'decoded mid-stream windows');
  const { maxErr } = checkSamples(buffers, decoder.decodedSamples);
  assert.ok(maxErr < 0.02, `sample alignment error ${maxErr}`);
});

test('decoder tolerates a boundary between incompatible formats (pre-roll lost only at the seam)', async () => {
  decodeCalls.length = 0;
  const store = new SegmentStore({ quarantineMs: 0 });
  const buffers = new TrackBuffers(Math.round(DURATION * SR));
  const decoder = new IncrementalDecoder(store, buffers, () => {});
  const init = units.find((u) => u.kind === 'init');
  const media = units.filter((u) => u.kind === 'media');
  // stream B gets a different init (an extra EBML Void element), so the streams cannot be merged
  const initB = new Uint8Array(init.bytes.length + 3); initB.set(init.bytes); initB.set([0xec, 0x81, 0x00], init.bytes.length);
  store.ingest({ key: 'A', source: 'main', mime: 'audio/webm', bytes: init.bytes, expectedDuration: DURATION });
  for (const u of media.slice(0, 3)) store.ingest({ key: 'A', source: 'main', mime: 'audio/webm', bytes: u.bytes, expectedDuration: DURATION });
  store.ingest({ key: 'B', source: 'embed', mime: 'audio/webm', bytes: initB, expectedDuration: DURATION });
  for (const u of media.slice(3)) store.ingest({ key: 'B', source: 'embed', mime: 'audio/webm', bytes: u.bytes, expectedDuration: DURATION });
  store.streams.get('A').lastAppendAt = Date.now() - 5000;
  decoder.pump(); await settle(decoder);
  assert.ok(decoder.isComplete(), 'complete: ' + JSON.stringify(decoder.decodedSamples));
  assert.equal(decodeCalls.length, 2);
  const seam = Math.round(media[3].info.start * SR);
  const before = checkSamples(buffers, [[0, seam]]);
  const after = checkSamples(buffers, [[seam + 400, buffers.totalSamples]]);
  assert.ok(before.maxErr < 0.02 && after.maxErr < 0.02, `aligned outside the seam: ${before.maxErr} ${after.maxErr}`);
});

test('decoder decodes a settled partial stream and silences a short tail on finish()', async () => {
  const store = new SegmentStore({ quarantineMs: 0 });
  const buffers = new TrackBuffers(Math.round(DURATION * SR));
  const decoder = new IncrementalDecoder(store, buffers, () => {});
  const init = units.find((u) => u.kind === 'init');
  const media = units.filter((u) => u.kind === 'media');
  store.ingest({ key: 'A', source: 'main', mime: 'audio/webm', bytes: init.bytes, expectedDuration: DURATION });
  for (const u of media.slice(0, 5)) store.ingest({ key: 'A', source: 'main', mime: 'audio/webm', bytes: u.bytes, expectedDuration: DURATION });
  decoder.pump(); await settle(decoder);
  assert.equal(buffers.countReady(buffers.mixReady), 0, 'waits while data may still arrive');
  store.streams.get('A').lastAppendAt = Date.now() - 5000; // simulate a settled stream
  decoder.pump(); await settle(decoder);
  const readyAfterSettle = buffers.countReady(buffers.mixReady);
  assert.ok(readyAfterSettle > 0 && readyAfterSettle < buffers.numBlocks, `partial decode: ${readyAfterSettle}/${buffers.numBlocks}`);
  const { maxErr } = checkSamples(buffers, decoder.decodedSamples);
  assert.ok(maxErr < 0.02, `sample alignment error ${maxErr}`);
  // the remaining ~0.75 s never arrives: finish() silences the tail so the track completes
  decoder.finish(); await settle(decoder);
  assert.ok(decoder.isComplete(), 'complete after finish: ' + JSON.stringify(decoder.decodedSamples));
});

test('decoder skips a segment the browser cannot decode instead of silencing it', async () => {
  decodeCalls.length = 0;
  const media = units.filter((u) => u.kind === 'media');
  const badStart = media[3].info.start;
  globalThis.__failIfStartIn = [badStart - 0.001, badStart + 0.001];
  try {
    const store = new SegmentStore({ quarantineMs: 0 });
    const buffers = new TrackBuffers(Math.round(DURATION * SR));
    const events = [];
    const decoder = new IncrementalDecoder(store, buffers, (p) => events.push(p), { windowSeconds: 0.6, minWindowSeconds: 0.5 });
    store.ingest({ key: 'A', source: 'embed', mime: 'audio/webm', bytes: fixture, expectedDuration: DURATION });
    decoder.pump(); await settle(decoder);
    assert.ok(decoder.captureComplete, 'loop terminates');
    assert.ok(events.some((e) => e.complete && e.failed), 'reports completion with failures');
    assert.equal(decoder.failedRanges.length, 1, 'exactly one skipped region: ' + JSON.stringify(decoder.failedRanges));
    const [fa, fb] = decoder.failedRanges[0];
    assert.ok(Math.abs(fa / SR - badStart) < 0.02 && Math.abs(fb / SR - media[3].info.end) < 0.02, 'skipped exactly the bad cluster');
    // the skipped region is not marked ready (so it never turns green / silent), everything else is
    const badBlockA = Math.ceil(fa / 1024), badBlockB = Math.floor(fb / 1024);
    for (let b = badBlockA; b < badBlockB; b++) assert.equal(buffers.mixReady[b], 0, 'block ' + b + ' must stay unready');
    assert.ok(buffers.countReady(buffers.mixReady) >= buffers.numBlocks - (badBlockB - badBlockA) - 2, 'rest decoded');
    assert.ok(!decoder.isComplete());
    // aligned everywhere except the codec pre-roll (~7 ms) right after the skipped segment
    const { maxErr } = checkSamples(buffers, [[0, fa], [fb + 400, buffers.totalSamples]]);
    assert.ok(maxErr < 0.02, `aligned elsewhere ${maxErr}`);
    // finish() retries once; still failing, it terminates again with the region skipped
    decoder.finish(); await settle(decoder);
    assert.ok(decoder.captureComplete && decoder.failedRanges.length === 1);
    // and when the decoder starts working (new data), the retry on finish fills it
    globalThis.__failIfStartIn = null;
    decoder.finish(); await settle(decoder);
    assert.ok(decoder.isComplete(), 'fully decoded after a successful retry: ' + JSON.stringify(decoder.failedRanges));
  } finally { globalThis.__failIfStartIn = null; }
});

// The regression behind "fetched but never processed": nothing pumped the decoder again after the
// last append, so the final window of a run that had merely not settled yet stayed undecoded, and
// the chunks over it could never be separated.
test('decoder comes back on its own once a growing stream has settled', async () => {
  const store = new SegmentStore({ quarantineMs: 0 });
  const buffers = new TrackBuffers(Math.round(DURATION * SR));
  const decoder = new IncrementalDecoder(store, buffers, () => {});
  const init = units.find((u) => u.kind === 'init');
  const media = units.filter((u) => u.kind === 'media');
  store.ingest({ key: 'A', source: 'main', mime: 'audio/webm', bytes: init.bytes, expectedDuration: DURATION });
  for (const u of media.slice(0, 5)) store.ingest({ key: 'A', source: 'main', mime: 'audio/webm', bytes: u.bytes, expectedDuration: DURATION });
  decoder.pump(); await settle(decoder);
  assert.equal(buffers.countReady(buffers.mixReady), 0, 'waits while data may still arrive');
  // no further append ever comes, and nobody pumps again
  await sleep(2100); await settle(decoder);
  assert.ok(buffers.countReady(buffers.mixReady) > 0, 'the settle timer decoded what was there');
});

// The regression that put ad audio into the mixture: an ad's MediaSource can report the video's own
// length, so a flagged append that was let through on the strength of that length was an ad.
test('an ad-flagged append is dropped whatever length its MediaSource reports', () => {
  const store = new SegmentStore({ quarantineMs: 0 });
  assert.equal(store.ingest({ key: 'a', source: 'main', mime: 'audio/webm', bytes: fixture, ad: true, expectedDuration: DURATION, msDuration: DURATION }), 0, 'the video\'s own length does not vouch for it');
  assert.equal(store.ingest({ key: 'a', source: 'main', mime: 'audio/webm', bytes: fixture, ad: true, expectedDuration: DURATION }), 0, 'nor does an unknown one');
  assert.equal(store.droppedAd, 2);
  assert.equal(store.coverage().length, 0);
});

// Ad media can be appended a moment before the player flags the ad. Fresh segments are therefore
// quarantined briefly, and an ad's start takes back what its player's streams received just before,
// and everything from a stream that only appeared just before the ad (the ad's own MediaSource).
test('an ad that has just begun takes back the segments appended right before it', async () => {
  const store = new SegmentStore({ quarantineMs: 300 });
  const init = units.find((u) => u.kind === 'init');
  const media = units.filter((u) => u.kind === 'media');
  // an old content stream (seen long before the ad) with settled segments
  store.ingest({ key: 'main:1:0', source: 'main', mime: 'audio/webm', bytes: init.bytes, expectedDuration: DURATION });
  for (const u of media.slice(0, 3)) store.ingest({ key: 'main:1:0', source: 'main', mime: 'audio/webm', bytes: u.bytes, expectedDuration: DURATION });
  store.streams.get('main:1:0').firstSeenAt = Date.now() - 60000;
  assert.equal(store.coverage().length, 0, 'fresh segments are not used yet');
  await sleep(350);
  assert.equal(store.coverage().length, 1, 'and become usable once the quarantine has passed');
  // the ad's own stream appears, its first cluster unflagged, then the old stream gets one more
  store.ingest({ key: 'main:2:0', source: 'main', mime: 'audio/webm', bytes: init.bytes, expectedDuration: DURATION });
  store.ingest({ key: 'main:2:0', source: 'main', mime: 'audio/webm', bytes: media[0].bytes, expectedDuration: DURATION });
  store.ingest({ key: 'main:1:0', source: 'main', mime: 'audio/webm', bytes: media[3].bytes, expectedDuration: DURATION });
  const dropped = store.onAdStart('main:');
  assert.equal(dropped, 2, 'the young stream entirely, and the old stream\'s fresh segment');
  assert.equal(store.streams.get('main:2:0').segments.length, 0);
  assert.equal(store.streams.get('main:1:0').segments.length, 3, 'settled content stays');
  assert.ok(store.streams.get('main:1:0').initBytes, 'and so do its headers');
  // another player's streams are none of this ad's business
  store.ingest({ key: 'embed:1:x:0', source: 'embed', mime: 'audio/webm', bytes: init.bytes, expectedDuration: DURATION });
  store.ingest({ key: 'embed:1:x:0', source: 'embed', mime: 'audio/webm', bytes: media[0].bytes, expectedDuration: DURATION });
  assert.equal(store.onAdStart('main:'), 0);
  assert.equal(store.streams.get('embed:1:x:0').segments.length, 1);
});

// The quarantine must not strand the last segment: finish() pumps at once, sees nothing usable yet,
// and nothing else would ever pump again.
test('a segment that arrives right before finish() is decoded once its quarantine has passed', async () => {
  const store = new SegmentStore({ quarantineMs: 300 });
  const buffers = new TrackBuffers(Math.round(DURATION * SR));
  const decoder = new IncrementalDecoder(store, buffers, () => {});
  store.ingest({ key: 'A', source: 'embed', mime: 'audio/webm', bytes: fixture, expectedDuration: DURATION });
  decoder.finish(); await settle(decoder);
  assert.equal(buffers.countReady(buffers.mixReady), 0, 'everything is still held back');
  await sleep(2100); await settle(decoder);
  assert.ok(decoder.isComplete(), 'decoded on its own once released: ' + JSON.stringify(decoder.decodedSamples));
});

test('a stream whose duration is merely close is still this video', () => {
  const store = new SegmentStore({ quarantineMs: 0 });
  // a few seconds of disagreement between MediaSource.duration and the video element is normal
  const n = store.ingest({ key: 'a', source: 'main', mime: 'audio/webm', bytes: fixture, expectedDuration: DURATION, msDuration: DURATION + 2 });
  assert.ok(n > 0, 'accepted');
  // an ad carries its own, wildly different duration
  const store2 = new SegmentStore({ quarantineMs: 0 });
  assert.equal(store2.ingest({ key: 'a', source: 'main', mime: 'audio/webm', bytes: fixture, expectedDuration: 349, msDuration: 15 }), 0, 'rejected');
});
