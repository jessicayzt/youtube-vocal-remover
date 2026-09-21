import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ByteStreamParser, buildFile, detectContainer } from '../src/media/segments.js';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (name) => new Uint8Array(readFileSync(path.join(FIXTURE_DIR, name)));

// What each fixture contains (verified by hand with a hex dump / box walker):
//   initLength  bytes before the first Cluster (WebM) / moof or sidx (MP4) = the init unit
//   dropped     bytes of the file that belong to no unit: index elements the parser discards
//               (WebM trailing Cues; MP4 sidx/styp ahead of each moof; trailing mfra)
//   duration    WebM: Info.Duration in seconds; MP4: sample_count × 1024 AAC frames / timescale
//   Both WebM fixtures have a Segment with a KNOWN 8-byte size (9792 / 190915), so buildFile has to
//   rewrite it. The "1ch" MP4's stsd says channelcount=2 but its esds AudioSpecificConfig says 1.
const FIXTURES = {
  'test-a-128k-44100Hz-1ch.webm': {
    container: 'webm', codec: 'vorbis', sampleRate: 44100, channels: 1, timescale: 1000, trackId: 1,
    codecDelaySeconds: 0, defaultSampleDuration: null, initLength: 3983, mediaUnits: 8, dropped: 242, duration: 2.023,
  },
  'test.webm': { // VP8 track 1 + Vorbis track 2
    container: 'webm', codec: 'vorbis', sampleRate: 22050, channels: 2, timescale: 1000, trackId: 2,
    codecDelaySeconds: 0, defaultSampleDuration: null, initLength: 4116, mediaUnits: 9, dropped: 179, duration: 6.552,
  },
  'test-a-128k-44100Hz-1ch.mp4': {
    container: 'mp4', codec: 'aac', sampleRate: 44100, channels: 1, timescale: 44100, trackId: 1,
    codecDelaySeconds: 0, defaultSampleDuration: 1024, initLength: 763, mediaUnits: 10, dropped: 440, duration: (88 * 1024) / 44100,
  },
  'test.mp4': { // H.264 track 1 + AAC track 2; the audio trun carries no durations/sizes (trex default 1024),
    // except the last fragment, whose single audio sample gets tfhd default_sample_duration 1026
    container: 'mp4', codec: 'aac', sampleRate: 22050, channels: 2, timescale: 22050, trackId: 2,
    codecDelaySeconds: 0, defaultSampleDuration: 1024, initLength: 1413, mediaUnits: 9, dropped: 616, duration: (140 * 1024 + 1026) / 22050,
  },
  'test-boxes-audio.mp4': { // single fragment, trailing mfra; trex present with default_sample_duration 0
    container: 'mp4', codec: 'aac', sampleRate: 44100, channels: 1, timescale: 44100, trackId: 1,
    codecDelaySeconds: 0, defaultSampleDuration: 0, initLength: 742, mediaUnits: 1, dropped: 70, duration: (346 * 1024) / 44100,
  },
  'test-two-audiotracks-opus.mp4': { // init only, two Opus tracks: the first one is chosen; dOps PreSkip = 312
    container: 'mp4', codec: 'opus', sampleRate: 48000, channels: 2, timescale: 48000, trackId: 1,
    codecDelaySeconds: 312 / 48000, defaultSampleDuration: 0, initLength: 968, mediaUnits: 0, dropped: 0, duration: 0,
  },
};
const NAMES = Object.keys(FIXTURES);
const WITH_MEDIA = NAMES.filter((n) => FIXTURES[n].mediaUnits > 0);
const AUDIO_ONLY = ['test-a-128k-44100Hz-1ch.webm', 'test-a-128k-44100Hz-1ch.mp4', 'test-boxes-audio.mp4'];
const MULTI_UNIT = NAMES.filter((n) => FIXTURES[n].mediaUnits >= 4);

// ---------------------------------------------------------------------------- helpers

/** Feeds `bytes` to a fresh parser in the given pieces and returns push() + flush() units. */
function parse(bytes, pieces = [bytes], opts) {
  const parser = new ByteStreamParser(opts);
  const units = [];
  for (const piece of pieces) units.push(...parser.push(piece));
  units.push(...parser.flush());
  return { parser, units };
}
const parseAll = (name) => parse(load(name)).units;
const mediaOf = (units) => units.filter((u) => u.kind === 'media');

function split(bytes, size) {
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomSplit(bytes, seed) {
  const rand = mulberry32(seed);
  const out = [];
  for (let i = 0; i < bytes.length;) {
    const n = 1 + Math.floor(rand() * 3000);
    out.push(bytes.subarray(i, i + n));
    i += n;
  }
  return out;
}
/** Seeded pseudo-random bytes standing in for the tail of a stream picked up mid-way. */
function garbage(length, seed) {
  const rand = mulberry32(seed);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(rand() * 256);
  return out;
}
/** File offset of each unit's bytes (units are in file order). */
function unitOffsets(file, units) {
  const buf = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  const offsets = [];
  let from = 0;
  for (const u of units) {
    const at = buf.indexOf(Buffer.from(u.bytes.buffer, u.bytes.byteOffset, Math.min(64, u.bytes.length)), from);
    assert.ok(at >= 0, 'unit bytes are found in the file');
    offsets.push(at);
    from = at + u.bytes.length;
  }
  return offsets;
}
function assertUnitsEqual(actual, expected) {
  assert.equal(actual.length, expected.length, 'unit count');
  for (let i = 0; i < expected.length; i++) {
    assert.equal(actual[i].kind, expected[i].kind, `unit ${i} kind`);
    assert.deepEqual(actual[i].bytes, expected[i].bytes, `unit ${i} bytes`);
    assert.deepEqual(actual[i].info, expected[i].info, `unit ${i} info`);
  }
}
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// Minimal independent EBML / MP4 walkers so the tests do not lean on the module under test.
const EBML_SEGMENT = 0x18538067, EBML_CLUSTER = 0x1f43b675, EBML_CUES = 0x1c53bb6b, EBML_TIMECODE = 0xe7, EBML_SIMPLEBLOCK = 0xa3, EBML_BLOCKGROUP = 0xa0;
const UNKNOWN_SIZE_8 = Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
function vint(b, pos, isId) {
  const first = b[pos];
  let len = 1;
  for (let m = 0x80; !(first & m); m >>= 1) len++;
  const marker = 0x80 >> (len - 1);
  let value = isId ? first : first & (marker - 1);
  let ones = (first & (marker - 1)) === marker - 1;
  for (let i = 1; i < len; i++) { value = value * 256 + b[pos + i]; if (b[pos + i] !== 0xff) ones = false; }
  return { len, value, unknown: !isId && ones };
}
function ebml(b, pos) {
  const id = vint(b, pos, true), size = vint(b, pos + id.len, false);
  return { id: id.value, start: pos, sizeOffset: pos + id.len, sizeLen: size.len, size: size.value, unknown: size.unknown, dataStart: pos + id.len + size.len };
}
/** Top-level EBML items with the Segment flattened (its children listed as top-level items). */
function ebmlTopLevel(b) {
  const out = [];
  for (let pos = 0; pos < b.length;) {
    const h = ebml(b, pos);
    h.end = h.id === EBML_SEGMENT ? h.dataStart : h.unknown ? b.length : h.dataStart + h.size;
    out.push(h);
    pos = h.end;
  }
  return out;
}
/** Absolute times (Cluster.Timecode + relative, in ticks) of the (Simple)Blocks of `track` in a known-size Cluster item. */
function clusterBlockTimes(b, cluster, track) {
  const times = [];
  let timecode = 0;
  for (let pos = cluster.dataStart; pos < cluster.end;) {
    const h = ebml(b, pos);
    if (h.id === EBML_TIMECODE) timecode = b.subarray(h.dataStart, h.dataStart + h.size).reduce((v, x) => v * 256 + x, 0);
    else if (h.id === EBML_SIMPLEBLOCK || h.id === EBML_BLOCKGROUP) {
      const blockData = h.id === EBML_BLOCKGROUP ? ebml(b, h.dataStart).dataStart : h.dataStart;
      const track_ = vint(b, blockData, false);
      if (track_.value === track) times.push(timecode + ((((b[blockData + track_.len] << 8) | b[blockData + track_.len + 1]) << 16) >> 16));
    }
    pos = h.dataStart + h.size;
  }
  return times;
}
const countClusterBlocks = (b, cluster, track) => clusterBlockTimes(b, cluster, track).length;
const u32 = (b, p) => ((b[p] << 24) >>> 0) + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]);
function mp4TopLevelTypes(b) {
  const out = [];
  for (let pos = 0; pos + 8 <= b.length;) {
    const size = u32(b, pos) || b.length - pos;
    out.push(String.fromCharCode(...b.subarray(pos + 4, pos + 8)));
    pos += size;
  }
  return out;
}
/** Fixture rewritten the way a live/MSE muxer would emit it: unknown-size Segment, no trailing Cues. */
function unknownSegmentVariant(bytes) {
  const items = ebmlTopLevel(bytes);
  const segment = items.find((i) => i.id === EBML_SEGMENT), cues = items.find((i) => i.id === EBML_CUES);
  assert.ok(segment && !segment.unknown && segment.sizeLen === 8 && segment.dataStart + segment.size === bytes.length, 'fixture Segment has a known 8-byte size covering the file');
  assert.equal(cues, items.at(-1), 'fixture ends with a Cues element');
  const out = bytes.slice(0, cues.start);
  out.set(UNKNOWN_SIZE_8, segment.sizeOffset);
  return out;
}
/** As above, and every Cluster made unknown-size too (like a live stream). */
function liveVariant(bytes) {
  const out = unknownSegmentVariant(bytes);
  for (const c of ebmlTopLevel(out).filter((i) => i.id === EBML_CLUSTER)) {
    assert.equal(c.sizeLen, 8);
    out.set(UNKNOWN_SIZE_8, c.sizeOffset);
  }
  return out;
}

// ---------------------------------------------------------------------------- tests

describe('detectContainer', () => {
  for (const name of NAMES) {
    test(`${name} → ${FIXTURES[name].container}`, () => {
      assert.equal(detectContainer(load(name)), FIXTURES[name].container);
    });
  }
  test('recognises a stream that starts mid-way (Cluster / moof at offset 0)', () => {
    assert.equal(detectContainer(mediaOf(parseAll('test-a-128k-44100Hz-1ch.webm'))[0].bytes), 'webm');
    assert.equal(detectContainer(mediaOf(parseAll('test-a-128k-44100Hz-1ch.mp4'))[0].bytes), 'mp4');
  });
  test('returns null for short or unknown input', () => {
    assert.equal(detectContainer(new Uint8Array(0)), null);
    assert.equal(detectContainer(new Uint8Array([0x1a, 0x45, 0xdf])), null);
    assert.equal(detectContainer(new Uint8Array(16)), null);
    assert.equal(detectContainer(new TextEncoder().encode('OggS\0\0\0\0\0\0\0\0')), null);
  });
});

describe('whole-file push', () => {
  for (const name of NAMES) {
    const f = FIXTURES[name];
    test(name, () => {
      const bytes = load(name);
      const parser = new ByteStreamParser();
      const units = parser.push(bytes);
      assert.deepEqual(parser.flush(), [], 'every unit is complete from push() alone');
      assert.equal(parser.container, f.container);

      const inits = units.filter((u) => u.kind === 'init');
      assert.equal(inits.length, 1, 'exactly one init unit');
      assert.equal(units[0].kind, 'init', 'init unit comes first');
      assert.equal(units[0].bytes.length, f.initLength);
      assert.deepEqual(units[0].bytes, bytes.subarray(0, f.initLength));
      assert.deepEqual(units[0].info, {
        container: f.container, codec: f.codec, sampleRate: f.sampleRate, channels: f.channels, timescale: f.timescale,
        trackId: f.trackId, codecDelaySeconds: f.codecDelaySeconds, defaultSampleDuration: f.defaultSampleDuration,
      });
      assert.equal(parser.init, units[0].info);

      const media = mediaOf(units);
      assert.equal(media.length, f.mediaUnits);
      assert.equal(units.length, 1 + f.mediaUnits);
      const unitBytes = units.reduce((n, u) => n + u.bytes.length, 0);
      assert.equal(bytes.length - unitBytes, f.dropped, 'only index elements are left out of the units');
    });
  }
  test('accepts ArrayBuffer and DataView input like appendBuffer does', () => {
    const bytes = load('test-a-128k-44100Hz-1ch.mp4');
    const expected = parseAll('test-a-128k-44100Hz-1ch.mp4');
    assertUnitsEqual(parse(bytes, [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)]).units, expected);
    assertUnitsEqual(parse(bytes, [new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)]).units, expected);
  });
  test('opts.container skips detection but yields the same units', () => {
    for (const name of ['test-a-128k-44100Hz-1ch.webm', 'test-a-128k-44100Hz-1ch.mp4']) {
      const bytes = load(name);
      const { parser, units } = parse(bytes, [bytes], { container: FIXTURES[name].container });
      assert.equal(parser.container, FIXTURES[name].container);
      assertUnitsEqual(units, parseAll(name));
    }
  });
});

describe('media timing', () => {
  for (const name of WITH_MEDIA) {
    const f = FIXTURES[name];
    test(`${name}: increasing, positive, complete units`, () => {
      const media = mediaOf(parseAll(name));
      for (let i = 0; i < media.length; i++) {
        const { start, end, blocks, complete } = media[i].info;
        assert.ok(end > start, `unit ${i}: end ${end} > start ${start}`);
        assert.ok(blocks > 0, `unit ${i}: counted blocks`);
        assert.equal(complete, true);
        if (i) assert.ok(start > media[i - 1].info.start, `unit ${i}: start increases`);
      }
      assert.equal(media[0].info.start, 0);
      assert.ok(Math.abs(media.at(-1).info.end - f.duration) < 0.03, `stream ends near ${f.duration}s (got ${media.at(-1).info.end})`);
    });
  }
  for (const name of AUDIO_ONLY) {
    test(`${name}: consecutive units abut`, () => {
      const media = mediaOf(parseAll(name));
      for (let i = 1; i < media.length; i++) {
        const gap = media[i].info.start - media[i - 1].info.end;
        assert.ok(Math.abs(gap) <= 0.03, `unit ${i} gap ${gap}`);
      }
    });
  }
  test('multi-track fixtures abut too (audio blocks only are timed)', () => {
    for (const name of ['test.webm', 'test.mp4']) {
      const media = mediaOf(parseAll(name));
      for (let i = 1; i < media.length; i++) assert.ok(Math.abs(media[i].info.start - media[i - 1].info.end) <= 0.03, `${name} unit ${i}`);
    }
  });
  test('MP4 durations are exact multiples of the 1024-sample AAC frame', () => {
    for (const name of ['test-a-128k-44100Hz-1ch.mp4', 'test.mp4', 'test-boxes-audio.mp4']) {
      const { timescale } = FIXTURES[name];
      const media = mediaOf(parseAll(name));
      if (name === 'test.mp4') { // last fragment: one sample with tfhd default_sample_duration 1026
        const last = media.pop().info;
        assert.equal(last.blocks, 1);
        assert.ok(Math.abs(last.end - last.start - 1026 / timescale) < 1e-9);
      }
      for (const m of media) {
        assert.ok(Math.abs(m.info.end - m.info.start - (m.info.blocks * 1024) / timescale) < 1e-9, `${name}: ${JSON.stringify(m.info)}`);
      }
    }
  });
  test('WebM: a cluster ends at its last block + the median block spacing; a lone block lasts 20 ms', () => {
    const bytes = load('test.webm');
    const media = mediaOf(parseAll('test.webm'));
    const clusters = ebmlTopLevel(bytes).filter((i) => i.id === EBML_CLUSTER);
    for (let i = 0; i < media.length - 1; i++) {
      const times = clusterBlockTimes(bytes, clusters[i], 2).sort((a, b) => a - b);
      const gaps = times.slice(1).map((t, k) => t - times[k]).sort((a, b) => a - b);
      const median = gaps.length % 2 ? gaps[gaps.length >> 1] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;
      assert.ok(Math.abs(median - 23) <= 1, `Vorbis @22050 Hz packets in this fixture are ~23 ms apart (got ${median})`);
      assert.equal(media[i].info.start, times[0] / 1000, `cluster ${i} start`);
      assert.equal(media[i].info.end, (times.at(-1) + median) / 1000, `cluster ${i} end`);
    }
    // The 9th cluster holds a single audio block: nothing to measure, so it gets the 20 ms default.
    assert.equal(media.at(-1).info.blocks, 1);
    assert.ok(Math.abs(media.at(-1).info.end - media.at(-1).info.start - 0.02) < 1e-9);
  });
});

describe('chunked push equivalence', () => {
  for (const name of NAMES) {
    test(name, () => {
      const bytes = load(name);
      const expected = parseAll(name);
      for (const size of [1, 7, 1000]) assertUnitsEqual(parse(bytes, split(bytes, size)).units, expected);
      for (const seed of [1, 42, 20260920]) assertUnitsEqual(parse(bytes, randomSplit(bytes, seed)).units, expected);
    });
  }
  test('unit bytes are copies, not views into the input', () => {
    for (const name of ['test-a-128k-44100Hz-1ch.webm', 'test-a-128k-44100Hz-1ch.mp4']) {
      const expected = parseAll(name);
      const input = load(name);
      const { units } = parse(input, split(input, 1000));
      input.fill(0);
      assertUnitsEqual(units, expected);
    }
  });
});

describe('buildFile', () => {
  test('MP4: plain concatenation of the init and media units', () => {
    for (const name of ['test-a-128k-44100Hz-1ch.mp4', 'test.mp4', 'test-boxes-audio.mp4']) {
      const [init, ...media] = parseAll(name);
      const built = buildFile(init.bytes, media.map((m) => m.bytes), 'mp4');
      assert.deepEqual(built, concat([init.bytes, ...media.map((m) => m.bytes)]));
      assert.deepEqual(built.subarray(0, init.bytes.length), init.bytes);
      const types = mp4TopLevelTypes(built);
      assert.ok(!types.some((t) => ['sidx', 'styp', 'mfra'].includes(t)), `no index boxes left in ${name}: ${types}`);
      assert.deepEqual(types.slice(-2), ['moof', 'mdat']);
    }
  });
  test('MP4: test-boxes-audio.mp4 rebuilds to the original minus its trailing mfra (70 bytes)', () => {
    const original = load('test-boxes-audio.mp4');
    const [init, ...media] = parseAll('test-boxes-audio.mp4');
    assert.deepEqual(buildFile(init.bytes, media.map((m) => m.bytes), 'mp4'), original.subarray(0, original.length - 70));
    assert.deepEqual(mp4TopLevelTypes(original), ['ftyp', 'moov', 'moof', 'mdat', 'mfra']);
  });
  test('MP4: sidx/styp fixtures lose exactly the index boxes', () => {
    for (const name of ['test-a-128k-44100Hz-1ch.mp4', 'test.mp4']) {
      const original = load(name);
      const [init, ...media] = parseAll(name);
      assert.equal(buildFile(init.bytes, media.map((m) => m.bytes)).length, original.length - FIXTURES[name].dropped);
    }
  });
  test('WebM: fixtures have known-size Segments, which get rewritten to the unknown size', () => {
    for (const name of ['test-a-128k-44100Hz-1ch.webm', 'test.webm']) {
      const original = load(name);
      const [init, ...media] = parseAll(name);
      const segment = ebmlTopLevel(original).find((i) => i.id === EBML_SEGMENT);
      assert.ok(!segment.unknown && segment.sizeLen === 8, 'Segment size is known and 8 bytes long');
      assert.equal(segment.dataStart + segment.size, original.length, 'Segment size spans the rest of the file');

      const built = buildFile(init.bytes, media.map((m) => m.bytes), 'webm');
      const expectedInit = init.bytes.slice();
      expectedInit.set(UNKNOWN_SIZE_8, segment.sizeOffset);
      assert.deepEqual(built.subarray(0, init.bytes.length), expectedInit, 'init bytes with the Segment size made unknown');
      assert.deepEqual(built.subarray(init.bytes.length), concat(media.map((m) => m.bytes)));
      assert.notDeepEqual(built, original, 'trailing Cues are gone and the Segment size changed');
      assert.equal(built.length, original.length - FIXTURES[name].dropped);
    }
  });
  test('WebM: an unknown-size Segment is kept byte for byte, so the rebuilt file equals the source', () => {
    for (const name of ['test-a-128k-44100Hz-1ch.webm', 'test.webm']) {
      const source = unknownSegmentVariant(load(name));
      const [init, ...media] = parse(source).units;
      assert.equal(init.kind, 'init');
      assert.deepEqual(init.info, parseAll(name)[0].info);
      assert.equal(media.length, FIXTURES[name].mediaUnits);
      assert.deepEqual(buildFile(init.bytes, media.map((m) => m.bytes), 'webm'), source);
      assert.deepEqual(buildFile(init.bytes, media.map((m) => m.bytes)), source, 'container detected from the init bytes');
    }
  });
  test('accepts Unit objects as well as raw bytes for the media list', () => {
    const [init, ...media] = parseAll('test-a-128k-44100Hz-1ch.mp4');
    assert.deepEqual(buildFile(init.bytes, media, 'mp4'), buildFile(init.bytes, media.map((m) => m.bytes), 'mp4'));
  });
});

describe('unknown-size clusters (live WebM)', () => {
  for (const name of ['test-a-128k-44100Hz-1ch.webm', 'test.webm']) {
    test(name, () => {
      const source = liveVariant(load(name));
      const reference = parseAll(name);
      const parser = new ByteStreamParser();
      const pushed = parser.push(source);
      const flushed = parser.flush();
      // A cluster of unknown size ends only when the next top-level element starts, so the last one needs flush().
      assert.equal(pushed.length, reference.length - 1);
      assert.equal(flushed.length, 1);
      const units = [...pushed, ...flushed];
      assert.equal(units[0].kind, 'init');
      assert.deepEqual(units[0].info, reference[0].info);
      assert.deepEqual(units[0].bytes, source.subarray(0, FIXTURES[name].initLength), 'init bytes carry the unknown Segment size');
      for (let i = 1; i < units.length; i++) {
        assert.equal(units[i].info.complete, false, `unit ${i}`);
        assert.deepEqual({ ...units[i].info, complete: true }, reference[i].info, `unit ${i} timing matches the known-size parse`);
        assert.equal(units[i].bytes.length, reference[i].bytes.length);
      }
      assert.deepEqual(buildFile(units[0].bytes, units.slice(1).map((u) => u.bytes), 'webm'), source);
      // Byte-by-byte delivery gives the same result.
      assertUnitsEqual(parse(source, split(source, 1)).units, units);
      assertUnitsEqual(parse(source, randomSplit(source, 7)).units, units);
    });
  }
});

describe('reset', () => {
  for (const name of ['test-a-128k-44100Hz-1ch.webm', 'test.webm', 'test-a-128k-44100Hz-1ch.mp4', 'test.mp4']) {
    test(`${name}: a partial unit is discarded and the next complete unit parses`, () => {
      const [init, ...media] = parseAll(name);
      const parser = new ByteStreamParser();
      const before = [...parser.push(init.bytes), ...parser.push(media[0].bytes), ...parser.push(media[1].bytes.subarray(0, 300))];
      assertUnitsEqual(before, [init, media[0]]);
      parser.reset();
      assert.deepEqual(parser.init, init.info, 'init info survives reset()');
      assert.equal(parser.container, FIXTURES[name].container);
      assertUnitsEqual(parser.push(media[2].bytes), [media[2]]);
      assert.deepEqual(parser.flush(), []);
    });
  }
  test('reset() during a partial init segment, then the init is re-sent from the start', () => {
    for (const name of ['test-a-128k-44100Hz-1ch.webm', 'test-a-128k-44100Hz-1ch.mp4']) {
      const [init, ...media] = parseAll(name);
      const parser = new ByteStreamParser();
      assert.deepEqual(parser.push(init.bytes.subarray(0, 200)), []);
      parser.reset();
      assert.equal(parser.init, null);
      assertUnitsEqual([...parser.push(init.bytes), ...parser.push(media[0].bytes)], [init, media[0]]);
    }
  });
});

describe('multi-track fixtures pick the audio track', () => {
  test('test.webm: track 2 (Vorbis) is chosen and only its blocks are counted', () => {
    const bytes = load('test.webm');
    const [init, ...media] = parseAll('test.webm');
    assert.equal(init.info.trackId, 2);
    assert.equal(init.info.codec, 'vorbis');
    const clusters = ebmlTopLevel(bytes).filter((i) => i.id === EBML_CLUSTER);
    assert.equal(clusters.length, media.length);
    // First cluster: 64 blocks in total, 40 of them audio.
    assert.equal(countClusterBlocks(bytes, clusters[0], 1) + countClusterBlocks(bytes, clusters[0], 2), 64);
    assert.equal(media[0].info.blocks, 40);
    media.forEach((m, i) => assert.equal(m.info.blocks, countClusterBlocks(bytes, clusters[i], 2), `cluster ${i}`));
    assert.equal(media.reduce((n, m) => n + m.info.blocks, 0), 282);
  });
  test('test.mp4: track 2 (AAC, timescale 22050) is chosen over the 90000-timescale video track', () => {
    const [init, ...media] = parseAll('test.mp4');
    assert.equal(init.info.trackId, 2);
    assert.equal(init.info.timescale, 22050);
    // First moof: the video traf has sample_count 24, the audio traf 19.
    assert.equal(media[0].info.blocks, 19);
    assert.deepEqual(media.map((m) => m.info.blocks), [19, 17, 17, 18, 17, 17, 17, 18, 1]);
    // tfdt of fragment i equals the summed sample count before it × trex default_sample_duration (1024).
    let samples = 0;
    for (const m of media) { assert.equal(m.info.start, (samples * 1024) / 22050); samples += m.info.blocks; }
  });
  test('test-two-audiotracks-opus.mp4: first audio track, Opus pre-skip exposed as codecDelaySeconds', () => {
    const { parser, units } = parse(load('test-two-audiotracks-opus.mp4'));
    assert.equal(units.length, 1);
    assert.equal(units[0].kind, 'init');
    assert.equal(units[0].info.trackId, 1);
    assert.equal(units[0].info.codec, 'opus');
    assert.equal(units[0].info.codecDelaySeconds, 312 / 48000);
    assert.deepEqual(parser.flush(), []);
  });
});

describe('flush and streams without an init', () => {
  test('WebM: an init segment alone is emitted by flush(), and clusters still parse afterwards', () => {
    const [init, ...media] = parseAll('test-a-128k-44100Hz-1ch.webm');
    const parser = new ByteStreamParser();
    assert.deepEqual(parser.push(init.bytes), [], 'the init unit ends only where the first Cluster starts');
    assertUnitsEqual(parser.flush(), [init]);
    assertUnitsEqual(parser.push(media[0].bytes), [media[0]]);
  });
  test('MP4: the init unit is emitted as soon as moov is complete', () => {
    const [init] = parseAll('test-a-128k-44100Hz-1ch.mp4');
    const parser = new ByteStreamParser();
    assertUnitsEqual(parser.push(init.bytes), [init]);
    assert.deepEqual(parser.flush(), []);
  });
  test('MP4: a size-0 mdat (extends to end of stream) is finalized by flush() with complete=false', () => {
    const [init, first] = parseAll('test-a-128k-44100Hz-1ch.mp4');
    const unit = first.bytes.slice();
    assert.equal(String.fromCharCode(...unit.subarray(132, 136)), 'mdat', 'mdat follows the 128-byte moof');
    unit.fill(0, 128, 132); // size = 0
    const parser = new ByteStreamParser();
    assertUnitsEqual(parser.push(concat([init.bytes, unit])), [init]);
    const flushed = parser.flush();
    assert.equal(flushed.length, 1);
    assert.deepEqual(flushed[0].bytes, unit);
    assert.deepEqual(flushed[0].info, { ...first.info, complete: false });
  });
  test('flush() on an empty or exhausted parser returns nothing', () => {
    const parser = new ByteStreamParser();
    assert.deepEqual(parser.flush(), []);
    assert.equal(parser.container, null);
    assert.equal(parser.init, null);
  });
  test('WebM stream starting at a Cluster: media units follow the first track seen, no init unit', () => {
    const media = mediaOf(parseAll('test.webm'));
    const parser = new ByteStreamParser();
    const units = parser.push(concat([media[0].bytes, media[1].bytes]));
    assert.equal(parser.init, null);
    assert.deepEqual(units.map((u) => u.kind), ['media', 'media']);
    assert.equal(units[0].info.blocks, 40, 'the first block of the cluster belongs to the audio track');
    assert.equal(units[0].info.start, 0);
  });
  test('MP4 stream starting at a moof: units are emitted with raw tick timing', () => {
    const media = mediaOf(parseAll('test-a-128k-44100Hz-1ch.mp4'));
    const parser = new ByteStreamParser();
    const units = parser.push(concat([media[0].bytes, media[1].bytes]));
    assert.equal(units.length, 2);
    assert.equal(units[1].info.start, 10240, 'tfdt of the second fragment, in ticks (no timescale known)');
    assert.equal(units[1].info.blocks, 10);
  });
});

describe('errors', () => {
  test('unsupported container option', () => {
    assert.throws(() => new ByteStreamParser({ container: 'ogg' }), TypeError);
  });
  test('non-byte arguments raise TypeError', () => {
    const parser = new ByteStreamParser();
    assert.throws(() => parser.push('bytes'), TypeError);
    assert.throws(() => parser.push(null), TypeError);
    assert.throws(() => detectContainer(42), TypeError);
  });
  test('unrecognised bytes never throw: the parser waits for a plausible unit start', () => {
    const parser = new ByteStreamParser();
    assert.deepEqual(parser.push(new Uint8Array([0x55, 0x55, 0x55, 0x55])), []);
    assert.deepEqual(parser.push(new Uint8Array([0x55, 0x55, 0x55, 0x55])), []);
    assert.equal(parser.container, null);
    assertUnitsEqual([...parser.push(load('test-a-128k-44100Hz-1ch.mp4')), ...parser.flush()], parseAll('test-a-128k-44100Hz-1ch.mp4'));
  });
});

describe('resync after garbage and mid-stream starts', () => {
  for (const name of NAMES) {
    test(`${name}: 500 random bytes ahead of the file are skipped`, () => {
      const file = load(name);
      const expected = parseAll(name);
      assertUnitsEqual(parse(concat([garbage(500, 11), file])).units, expected);
      assertUnitsEqual(parse(file, [garbage(500, 12), file]).units, expected); // garbage and file in separate pushes
    });
  }
  for (const name of MULTI_UNIT) {
    test(`${name}: a stream cut 1500 bytes in starts mid-unit and recovers at the next unit`, () => {
      const file = load(name);
      const aligned = parseAll(name);
      const media = mediaOf(aligned);
      const offsets = unitOffsets(file, media);
      const expected = media.filter((_, i) => offsets[i] >= 1500); // units that start after the cut
      assert.ok(expected.length >= 1 && expected.length <= media.length);
      const { parser, units } = parse(file.subarray(1500));
      assert.equal(parser.init, null, 'no init segment was seen');
      assert.equal(units.length, expected.length);
      units.forEach((u, i) => {
        assert.equal(u.kind, 'media');
        assert.deepEqual(u.bytes, expected[i].bytes, `unit ${i} bytes`);
        assert.ok(u.info.blocks > 0 && u.info.end >= u.info.start);
      });
      // WebM: the default timescale (1000) and "first track seen" match this fixture, so the timing is identical too.
      // MP4 without a moov has no timescale (raw tfdt ticks), no trex default durations and no track choice
      // (first traf), so only the bytes are compared here.
      if (FIXTURES[name].container === 'webm') assertUnitsEqual(units, expected);
      // When the init is known from before (init pushed, then reset()), the timing is identical too.
      const primed = new ByteStreamParser();
      primed.push(aligned[0].bytes);
      primed.reset();
      assertUnitsEqual([...primed.push(file.subarray(1500)), ...primed.flush()], expected);
    });
  }
  for (const name of MULTI_UNIT) {
    for (const at of [60, 300, 0.8]) { // absolute byte counts, or a fraction of the unit
      test(`${name}: a unit truncated at ${at} and followed by complete units yields only the complete ones`, () => {
        const [init, ...media] = parseAll(name);
        const cut = at < 1 ? Math.floor(media[1].bytes.length * at) : at;
        assert.ok(cut > 0 && cut < media[1].bytes.length);
        const stream = concat([init.bytes, media[0].bytes, media[1].bytes.subarray(0, cut), media[2].bytes, media[3].bytes]);
        assertUnitsEqual(parse(stream).units, [init, media[0], media[2], media[3]]);
        // Byte-by-byte delivery: WebM clusters are validated structurally, so this holds regardless of push
        // boundaries. A truncated MP4 mdat is only recognisable from the bytes that follow it, which are
        // not there yet when a push ends exactly at the (bogus) mdat end, so it is not exercised here.
        if (FIXTURES[name].container === 'webm') assertUnitsEqual(parse(stream, split(stream, 1)).units, [init, media[0], media[2], media[3]]);
      });
    }
  }
  for (const name of MULTI_UNIT) {
    test(`${name}: after reset() a push starting mid-unit recovers at the next unit`, () => {
      const [init, ...media] = parseAll(name);
      const parser = new ByteStreamParser();
      assertUnitsEqual([...parser.push(init.bytes), ...parser.push(media[0].bytes)], [init, media[0]]);
      parser.reset();
      assert.deepEqual(parser.push(media[1].bytes.subarray(200)), [], 'the tail of a unit yields nothing');
      assertUnitsEqual(parser.push(media[2].bytes), [media[2]]);
      assert.deepEqual(parser.flush(), []);
    });
  }
  for (const name of NAMES) {
    test(`${name}: one byte at a time through a garbage prefix`, () => {
      const stream = concat([garbage(300, 5), load(name)]);
      assertUnitsEqual(parse(stream, split(stream, 1)).units, parseAll(name));
    });
  }
  test('push() never throws on seeded garbage prefixes and still yields the aligned units', () => {
    for (const name of NAMES) {
      const expected = parseAll(name);
      for (const seed of [1, 2, 3, 4, 5]) {
        const stream = concat([garbage(1 + seed * 97, seed), load(name)]);
        let units;
        assert.doesNotThrow(() => { units = parse(stream, randomSplit(stream, seed)).units; });
        assertUnitsEqual(units, expected);
      }
    }
  });
  test('pure garbage yields nothing and leaves the parser usable', () => {
    for (const container of [undefined, 'webm', 'mp4']) {
      const parser = new ByteStreamParser(container && { container });
      for (const seed of [21, 22, 23]) assert.deepEqual(parser.push(garbage(4096, seed)), []);
      assert.deepEqual(parser.flush(), []);
      const name = container === 'webm' ? 'test-a-128k-44100Hz-1ch.webm' : 'test-a-128k-44100Hz-1ch.mp4';
      assertUnitsEqual([...parser.push(load(name)), ...parser.flush()], parseAll(name));
    }
  });
  test('garbage after a complete stream changes nothing', () => {
    for (const name of ['test-a-128k-44100Hz-1ch.webm', 'test-a-128k-44100Hz-1ch.mp4', 'test-boxes-audio.mp4']) {
      assertUnitsEqual(parse(concat([load(name), garbage(777, 9)])).units, parseAll(name));
    }
  });
  test('an absurd element size (> 64 MiB) is treated as garbage', () => {
    const [init, ...media] = parseAll('test-a-128k-44100Hz-1ch.webm');
    const fakeCluster = Uint8Array.of(0x1f, 0x43, 0xb6, 0x75, 0x01, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00); // Cluster, size 2^36
    const parser = new ByteStreamParser();
    assert.deepEqual(parser.push(init.bytes), []);
    assertUnitsEqual(parser.push(concat([fakeCluster, media[0].bytes])), [init, media[0]]);
    const [initM, ...mediaM] = parseAll('test-a-128k-44100Hz-1ch.mp4');
    const fakeMoof = Uint8Array.of(0x10, 0x00, 0x00, 0x00, 0x6d, 0x6f, 0x6f, 0x66); // moof, size 256 MiB
    assertUnitsEqual(parse(concat([initM.bytes, fakeMoof, mediaM[0].bytes])).units, [initM, mediaM[0]]);
  });
  test('unknown top-level ids / box types are treated as garbage', () => {
    const [init, ...media] = parseAll('test-a-128k-44100Hz-1ch.webm');
    const strayElement = Uint8Array.of(0x80, 0x81, 0x00); // id 0x80 is not a Segment child
    assertUnitsEqual(parse(concat([init.bytes, media[0].bytes, strayElement, media[1].bytes])).units, [init, media[0], media[1]]);
    const [initM, ...mediaM] = parseAll('test-a-128k-44100Hz-1ch.mp4');
    const strayBox = Uint8Array.of(0, 0, 0, 12, 0x7a, 0x7a, 0x7a, 0x7a, 1, 2, 3, 4); // 'zzzz'
    assertUnitsEqual(parse(concat([initM.bytes, mediaM[0].bytes, strayBox, mediaM[1].bytes])).units, [initM, mediaM[0], mediaM[1]]);
  });
  test('nothing from before a sync point is emitted: garbage between init and first Cluster drops the init', () => {
    const [init, ...media] = parseAll('test-a-128k-44100Hz-1ch.webm');
    const { parser, units } = parse(concat([init.bytes, new Uint8Array(64), media[0].bytes])); // 0x00 is an invalid vint
    assert.equal(parser.init, null);
    assertUnitsEqual(units, [media[0]]);
  });
});
