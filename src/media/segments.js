/**
 * segments.js — re-frames an MSE audio byte stream into container units.
 *
 * YouTube feeds SourceBuffer.appendBuffer() with WebM (Opus / Vorbis) or fragmented MP4
 * (AAC, Opus) bytes whose append boundaries are arbitrary: one append may hold several
 * container units or only part of one. ByteStreamParser buffers the stream and emits
 *   - init  units: WebM  EBML header + Segment header + Info/Tracks/...   MP4  ftyp .. moov
 *   - media units: WebM  one Cluster                                       MP4  moof + its mdat(s)
 * together with the timing needed to place decoded audio on the container timeline.
 *
 * The hook may attach in the middle of a stream, so garbage in front of (or between) units is
 * expected: instead of throwing, the parser validates every unit before emitting it and, on any
 * parse failure, scans forward for the next plausible unit start (see "resync" below).
 *
 * Pure ES module (no DOM, no Node APIs) so the same file runs in the page hook and under node --test.
 */

// ---------------------------------------------------------------------------- constants

// EBML / Matroska element ids (names as in the Matroska spec).
const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_SEEKHEAD = 0x114d9b74;
const ID_INFO = 0x1549a966;
const ID_TIMECODESCALE = 0x2ad7b1;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACKENTRY = 0xae;
const ID_TRACKNUMBER = 0xd7;
const ID_TRACKTYPE = 0x83;
const ID_CODECID = 0x86;
const ID_CODECDELAY = 0x56aa;
const ID_AUDIO = 0xe1;
const ID_SAMPLINGFREQUENCY = 0xb5;
const ID_CHANNELS = 0x9f;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE = 0xe7;
const ID_SIMPLEBLOCK = 0xa3;
const ID_BLOCKGROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_BLOCKDURATION = 0x9b;
const ID_CUES = 0x1c53bb6b;
const ID_TAGS = 0x1254c367;
const ID_CHAPTERS = 0x1043a770;
const ID_ATTACHMENTS = 0x1941a469;
const ID_VOID = 0xec;
const ID_CRC32 = 0xbf;

// Elements that appear at the top level of a WebM MSE byte stream (the EBML header, Segment,
// and Segment children). Meeting one of them is what ends an unknown-size Cluster.
const WEBM_TOP_LEVEL_IDS = new Set([
  ID_EBML, ID_SEGMENT, ID_SEEKHEAD, ID_INFO, ID_TRACKS, ID_CLUSTER, ID_CUES, ID_TAGS, ID_CHAPTERS, ID_ATTACHMENTS,
]);
// Elements allowed inside a Cluster; anything else there means the byte stream is garbage.
const CLUSTER_CHILD_IDS = new Set([ID_TIMECODE, 0x5854 /* SilentTracks */, 0xa7 /* Position */, 0xab /* PrevSize */,
  ID_SIMPLEBLOCK, ID_BLOCKGROUP, 0xaf /* EncryptedBlock */, ID_VOID, ID_CRC32]);
const EBML_MAGIC = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3);
const CLUSTER_MAGIC = Uint8Array.of(0x1f, 0x43, 0xb6, 0x75);
const TRACKTYPE_AUDIO = 2;
const DEFAULT_TIMECODE_SCALE = 1_000_000; // ns per tick → 1 ms ticks
const UNKNOWN_SIZE_8 = Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);

// ISO BMFF box types a stream can be re-entered at (a moof or an init segment and the boxes that precede one).
const MP4_SYNC_TYPES = ['moof', 'ftyp', 'moov', 'styp', 'sidx', 'emsg', 'prft'];
const MP4_SYNC_TYPE_SET = new Set(MP4_SYNC_TYPES);
// Top-level box types accepted by detectContainer().
const MP4_TOP_LEVEL_TYPES = new Set([...MP4_SYNC_TYPES, 'free', 'skip', 'mdat', 'uuid']);
// Top-level box types tolerated while parsing; an unknown type is treated as garbage.
const MP4_KNOWN_TYPES = new Set([...MP4_TOP_LEVEL_TYPES, 'mfra', 'meta', 'pdin', 'ssix', 'udta']);
// No real unit is this large; a bigger size means we are reading garbage.
const MAX_ELEMENT_SIZE = 64 * 1024 * 1024;
// Audio sample entry types (stsd) → InitInfo.codec. Formats we do not name still count as audio.
const MP4_AUDIO_CODECS = {
  mp4a: 'aac', Opus: 'opus', 'ac-3': 'unknown', 'ec-3': 'unknown', fLaC: 'unknown', alac: 'unknown',
  '.mp3': 'unknown', 'mp3 ': 'unknown', enca: 'unknown',
};
// AudioSpecificConfig channelConfiguration → channel count (0 = defined by a PCE, keep stsd value).
const AAC_CHANNELS = [null, 1, 2, 3, 4, 5, 6, 8];
const OPUS_RATE = 48000;

// tfhd flags
const TFHD_BASE_DATA_OFFSET = 0x000001;
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x000002;
const TFHD_DEFAULT_SAMPLE_DURATION = 0x000008;
const TFHD_DEFAULT_SAMPLE_SIZE = 0x000010;
// trun flags
const TRUN_DATA_OFFSET = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_SAMPLE_DURATION = 0x000100;
const TRUN_SAMPLE_SIZE = 0x000200;
const TRUN_SAMPLE_FLAGS = 0x000400;
const TRUN_SAMPLE_CTO = 0x000800;

// ---------------------------------------------------------------------------- byte helpers

function toU8(x) {
  if (x instanceof Uint8Array) return x;
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (x instanceof ArrayBuffer || Object.prototype.toString.call(x) === '[object ArrayBuffer]') return new Uint8Array(x); // also cross-realm
  throw new TypeError('expected a Uint8Array, ArrayBufferView or ArrayBuffer');
}
const u16 = (b, p) => (b[p] << 8) | b[p + 1];
const u32 = (b, p) => ((b[p] << 24) >>> 0) + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]);
const u64 = (b, p) => u32(b, p) * 0x100000000 + u32(b, p + 4); // exact below 2^53
const fourcc = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

/** Copies `parts` into one new Uint8Array (always a fresh buffer). */
function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Growable FIFO of bytes with amortised O(1) appends; used for the not-yet-framed tail of the stream. */
class ByteQueue {
  constructor() { this._buf = new Uint8Array(0); this._start = 0; this._end = 0; }
  get length() { return this._end - this._start; }
  push(bytes) {
    const len = this.length, need = len + bytes.length;
    if (this._end + bytes.length > this._buf.length) {
      if (need * 2 <= this._buf.length) this._buf.copyWithin(0, this._start, this._end); // compact in place
      else { const nb = new Uint8Array(Math.max(need * 2, 4096)); nb.set(this._buf.subarray(this._start, this._end)); this._buf = nb; }
      this._start = 0; this._end = len;
    }
    this._buf.set(bytes, this._end);
    this._end += bytes.length;
  }
  /** Zero-copy view of the buffered bytes; valid until the next push/take. */
  peek() { return this._buf.subarray(this._start, this._end); }
  /** Removes and returns a copy of the first n bytes. */
  take(n) {
    const out = this._buf.slice(this._start, this._start + n);
    this._start += n;
    if (this._start === this._end) this._start = this._end = 0;
    return out;
  }
  takeAll() { return this.take(this.length); }
  clear() { this._start = this._end = 0; }
}

// ---------------------------------------------------------------------------- EBML

/**
 * Reads an EBML variable-length integer. Ids keep their length-marker bit (that is how ids are
 * quoted in the spec); sizes drop it and report the all-ones "unknown size" value.
 * Returns null when the vint is not fully buffered yet and false when it is malformed.
 */
function readVint(b, pos, end, isId) {
  if (pos >= end) return null;
  const first = b[pos];
  if (first === 0) return false; // length marker beyond 8 bytes
  let len = 1;
  for (let mask = 0x80; !(first & mask); mask >>= 1) len++;
  if (isId && len > 4) return false;
  if (pos + len > end) return null;
  const marker = 0x80 >> (len - 1);
  let value = isId ? first : first & (marker - 1);
  let allOnes = (first & (marker - 1)) === marker - 1;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[pos + i];
    if (b[pos + i] !== 0xff) allOnes = false;
  }
  return { len, value, unknown: !isId && allOnes };
}

/** Element header at pos → { id, idLen, size, sizeLen, unknown, headerLen, dataStart }; null if incomplete, false if malformed. */
function readElementHeader(b, pos, end) {
  const id = readVint(b, pos, end, true);
  if (!id) return id;
  const size = readVint(b, pos + id.len, end, false);
  if (!size) return size;
  const headerLen = id.len + size.len;
  return { id: id.value, idLen: id.len, size: size.value, sizeLen: size.len, unknown: size.unknown, headerLen, dataStart: pos + headerLen };
}

/** Walks the elements in b[start, end) calling fn(id, dataStart, dataEnd); stops at a truncated element. */
function forEachElement(b, start, end, fn) {
  let pos = start;
  while (pos < end) {
    const h = readElementHeader(b, pos, end);
    if (!h) return;
    const dataEnd = h.unknown ? end : Math.min(end, h.dataStart + h.size);
    fn(h.id, h.dataStart, dataEnd);
    pos = dataEnd;
  }
}

function readUint(b, s, e) { let v = 0; for (let i = s; i < e; i++) v = v * 256 + b[i]; return v; }
function readFloat(b, s, e) {
  const n = e - s;
  if (n !== 4 && n !== 8) return null;
  const dv = new DataView(b.buffer, b.byteOffset + s, n);
  return n === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
}
function readAscii(b, s, e) { let str = ''; for (let i = s; i < e && b[i]; i++) str += String.fromCharCode(b[i]); return str; }

function webmCodec(codecId) {
  if (codecId === 'A_OPUS') return 'opus';
  if (codecId === 'A_VORBIS') return 'vorbis';
  if (codecId.startsWith('A_AAC')) return 'aac';
  return 'unknown';
}

/** TrackEntry → { number, type, codecId, codecDelay (ns), hasAudio, sampleRate, channels }. */
function parseTrackEntry(b, s, e) {
  const t = { number: null, type: null, codecId: '', codecDelay: 0, hasAudio: false, sampleRate: null, channels: null };
  forEachElement(b, s, e, (id, cs, ce) => {
    if (id === ID_TRACKNUMBER) t.number = readUint(b, cs, ce);
    else if (id === ID_TRACKTYPE) t.type = readUint(b, cs, ce);
    else if (id === ID_CODECID) t.codecId = readAscii(b, cs, ce);
    else if (id === ID_CODECDELAY) t.codecDelay = readUint(b, cs, ce);
    else if (id === ID_AUDIO) {
      t.hasAudio = true;
      forEachElement(b, cs, ce, (aid, as, ae) => {
        if (aid === ID_SAMPLINGFREQUENCY) t.sampleRate = readFloat(b, as, ae);
        else if (aid === ID_CHANNELS) t.channels = readUint(b, as, ae);
      });
    }
  });
  return t;
}

/**
 * Parses a WebM init segment (everything before the first Cluster) into an InitInfo.
 * Returns null when there is no Tracks element, i.e. the bytes were stray top-level elements
 * (Cues, Tags, Void ...) rather than an initialization segment.
 */
function parseWebmInit(bytes) {
  let timecodeScale = DEFAULT_TIMECODE_SCALE;
  let sawTracks = false;
  const tracks = [];
  const visit = (id, s, e) => {
    if (id === ID_SEGMENT) forEachElement(bytes, s, e, visit); // Segment children are the real top level
    else if (id === ID_INFO) {
      forEachElement(bytes, s, e, (cid, cs, ce) => { if (cid === ID_TIMECODESCALE) timecodeScale = readUint(bytes, cs, ce) || timecodeScale; });
    } else if (id === ID_TRACKS) {
      sawTracks = true;
      forEachElement(bytes, s, e, (cid, cs, ce) => { if (cid === ID_TRACKENTRY) tracks.push(parseTrackEntry(bytes, cs, ce)); });
    }
  };
  forEachElement(bytes, 0, bytes.length, visit);
  if (!sawTracks) return null;
  const audio = tracks.find((t) => t.type === TRACKTYPE_AUDIO)
    ?? tracks.find((t) => t.hasAudio || t.codecId.startsWith('A_'))
    ?? null;
  return {
    container: 'webm',
    codec: audio ? webmCodec(audio.codecId) : 'unknown',
    sampleRate: audio?.sampleRate ?? null,
    channels: audio?.channels ?? null,
    timescale: 1e9 / timecodeScale,
    trackId: audio?.number ?? null,
    codecDelaySeconds: (audio?.codecDelay ?? 0) / 1e9,
    defaultSampleDuration: null,
  };
}

/**
 * Timing of one Cluster (bytes = the whole element, header included) → { start, end, blocks }.
 * Block time = (Cluster.Timecode + Block relative timecode) / timescale. The last block lasts
 * its BlockDuration if it has one, else the median spacing of this cluster's blocks, else 20 ms.
 * Only blocks of `trackId` count; with no init yet the first track seen is followed.
 */
function parseWebmCluster(bytes, trackId, timescale) {
  const h = readElementHeader(bytes, 0, bytes.length);
  const dataStart = h ? h.dataStart : 0;
  const dataEnd = h && !h.unknown ? Math.min(bytes.length, h.dataStart + h.size) : bytes.length;
  let clusterTimecode = 0;
  const times = []; // ticks, chosen track only
  let lastDuration = null; // BlockDuration of the last counted block, ticks

  const onBlock = (s, e, duration) => {
    const track = readVint(bytes, s, e, false); // Block header: track number vint
    if (!track || s + track.len + 3 > e) return;
    if (trackId === null) trackId = track.value;
    if (track.value !== trackId) return;
    const relative = (u16(bytes, s + track.len) << 16) >> 16; // int16 relative timecode (lacing flags follow; a laced block counts once)
    times.push(clusterTimecode + relative);
    lastDuration = duration;
  };
  forEachElement(bytes, dataStart, dataEnd, (id, s, e) => {
    if (id === ID_TIMECODE) clusterTimecode = readUint(bytes, s, e);
    else if (id === ID_SIMPLEBLOCK) onBlock(s, e, null);
    else if (id === ID_BLOCKGROUP) {
      let block = null, duration = null;
      forEachElement(bytes, s, e, (cid, cs, ce) => {
        if (cid === ID_BLOCK) block = [cs, ce];
        else if (cid === ID_BLOCKDURATION) duration = readUint(bytes, cs, ce);
      });
      if (block) onBlock(block[0], block[1], duration);
    }
  });

  if (!times.length) {
    const t = clusterTimecode / timescale;
    return { start: t, end: t, blocks: 0, trackId };
  }
  const sorted = times.slice().sort((a, b) => a - b);
  let durationTicks;
  if (lastDuration !== null) durationTicks = lastDuration;
  else if (sorted.length > 1) {
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
    gaps.sort((a, b) => a - b);
    const mid = gaps.length >> 1;
    durationTicks = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  } else durationTicks = 0.02 * timescale;
  return {
    start: sorted[0] / timescale,
    end: (sorted[sorted.length - 1] + durationTicks) / timescale,
    blocks: times.length,
    trackId,
  };
}

/**
 * A complete known-size Cluster must tile exactly into valid child elements and carry a Timecode.
 * A cluster whose bytes were truncated (so its declared size swallows the start of the next unit)
 * fails this, which is how truncation is detected before anything is emitted.
 */
function validWebmCluster(b, dataStart, end) {
  let sawTimecode = false;
  for (let pos = dataStart; pos < end;) {
    const c = readElementHeader(b, pos, end);
    if (!c || !CLUSTER_CHILD_IDS.has(c.id) || c.unknown || c.dataStart + c.size > end) return false;
    if (c.id === ID_TIMECODE) sawTimecode = true;
    pos = c.dataStart + c.size;
  }
  return sawTimecode;
}

// ---------------------------------------------------------------------------- ISO BMFF

/** Walks the boxes in b[start, end) calling fn(type, dataStart, boxEnd); stops at a truncated box. */
function forEachBox(b, start, end, fn) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = u32(b, pos);
    const type = fourcc(b, pos + 4);
    let hdr = 8;
    if (size === 1) { // largesize
      if (pos + 16 > end) return;
      size = u64(b, pos + 8);
      hdr = 16;
    } else if (size === 0) size = end - pos; // "to the end"
    if (size < hdr || pos + size > end) return;
    fn(type, pos + hdr, pos + size);
    pos += size;
  }
}

/** esds → channel count from the AudioSpecificConfig channelConfiguration, or null. */
function parseEsdsChannels(b, s, e) {
  const readDescriptor = (p) => { // tag + expandable size (1..4 bytes)
    const tag = b[p];
    let size = 0, q = p + 1;
    for (let i = 0; i < 4; i++) { const byte = b[q++]; size = (size << 7) | (byte & 0x7f); if (!(byte & 0x80)) break; }
    return { tag, size, start: q };
  };
  let p = s + 4; // version + flags
  let d = readDescriptor(p);
  if (d.tag !== 0x03) return null; // ES_Descriptor
  p = d.start + 2; // ES_ID
  const flags = b[p++];
  if (flags & 0x80) p += 2; // dependsOn_ES_ID
  if (flags & 0x40) p += 1 + b[p]; // URLstring
  if (flags & 0x20) p += 2; // OCR_ES_Id
  d = readDescriptor(p);
  if (d.tag !== 0x04) return null; // DecoderConfigDescriptor
  d = readDescriptor(d.start + 13); // skip objectTypeIndication .. avgBitrate
  if (d.tag !== 0x05 || d.size < 2 || d.start + d.size > e) return null; // DecoderSpecificInfo
  let bit = d.start * 8;
  const bits = (n) => { let v = 0; for (; n > 0; n--, bit++) v = v * 2 + ((b[bit >> 3] >> (7 - (bit & 7))) & 1); return v; };
  let audioObjectType = bits(5);
  if (audioObjectType === 31) audioObjectType = 32 + bits(6);
  if (bits(4) === 15) bits(24); // samplingFrequencyIndex (+ explicit frequency)
  const channelConfiguration = bits(4);
  return AAC_CHANNELS[channelConfiguration] ?? null;
}

/** stsd → fills codec / sampleRate / channels / codecDelaySeconds / isAudioEntry on the track. */
function parseStsd(b, s, e, t) {
  if (u32(b, s + 4) < 1) return; // entry_count
  const p = s + 8; // first SampleEntry
  const size = u32(b, p), type = fourcc(b, p + 4);
  if (size < 36 || p + size > e || !(type in MP4_AUDIO_CODECS)) return;
  t.isAudioEntry = true;
  // AudioSampleEntry: 6 reserved + data_reference_index, version, revision, vendor, channelcount, samplesize, ...
  const version = u16(b, p + 16);
  t.channels = u16(b, p + 24) || null;
  t.sampleRate = u32(b, p + 32) / 65536 || null; // 16.16 fixed point
  let format = type;
  const children = p + 36 + (version === 1 ? 16 : version === 2 ? 36 : 0); // QuickTime v1/v2 extensions
  forEachBox(b, children, p + size, (ct, cs, ce) => {
    if (ct === 'esds') t.channels = parseEsdsChannels(b, cs, ce) ?? t.channels;
    else if (ct === 'dOps') { // OpusSpecificBox: Version, OutputChannelCount, PreSkip, InputSampleRate, ...
      t.channels = b[cs + 1] || t.channels;
      t.codecDelaySeconds = u16(b, cs + 2) / OPUS_RATE;
    } else if (ct === 'sinf') { // encrypted entry: the original format sits in sinf/frma
      forEachBox(b, cs, ce, (st, ss) => { if (st === 'frma') format = fourcc(b, ss); });
    }
  });
  t.codec = MP4_AUDIO_CODECS[format] ?? 'unknown';
}

/** trak → track description. */
function parseTrak(b, s, e) {
  const t = {
    trackId: null, timescale: null, handler: null, codec: 'unknown', sampleRate: null, channels: null,
    codecDelaySeconds: 0, isAudioEntry: false, trex: null,
  };
  forEachBox(b, s, e, (type, ds, de) => {
    if (type === 'tkhd') t.trackId = b[ds] === 1 ? u32(b, ds + 20) : u32(b, ds + 12); // track_ID after creation/modification time
    else if (type === 'mdia') {
      forEachBox(b, ds, de, (mt, ms, me) => {
        if (mt === 'mdhd') t.timescale = b[ms] === 1 ? u32(b, ms + 20) : u32(b, ms + 12);
        else if (mt === 'hdlr') t.handler = fourcc(b, ms + 8); // handler_type
        else if (mt === 'minf') {
          forEachBox(b, ms, me, (it, is, ie) => {
            if (it !== 'stbl') return;
            forEachBox(b, is, ie, (bt, bs, be) => { if (bt === 'stsd') parseStsd(b, bs, be, t); });
          });
        }
      });
    }
  });
  return t;
}

/** moov → { info: InitInfo, tracks: Map<track_ID, track> }. */
function parseMoov(box) {
  const list = [];
  const trexes = [];
  forEachBox(box, 8, box.length, (type, ds, de) => {
    if (type === 'trak') list.push(parseTrak(box, ds, de));
    else if (type === 'mvex') {
      forEachBox(box, ds, de, (mt, ms) => {
        if (mt === 'trex') trexes.push({ trackId: u32(box, ms + 4), defaultSampleDuration: u32(box, ms + 12), defaultSampleSize: u32(box, ms + 16) });
      });
    }
  });
  const tracks = new Map();
  for (const t of list) if (t.trackId !== null) tracks.set(t.trackId, t);
  for (const x of trexes) {
    const t = tracks.get(x.trackId);
    if (t) t.trex = x;
    else tracks.set(x.trackId, { trackId: x.trackId, timescale: null, trex: x });
  }
  const audio = list.find((t) => t.handler === 'soun') ?? list.find((t) => t.isAudioEntry) ?? list[0] ?? null;
  const info = {
    container: 'mp4',
    codec: audio?.codec ?? 'unknown',
    sampleRate: audio?.sampleRate ?? null,
    channels: audio?.channels ?? null,
    timescale: audio?.timescale ?? 1,
    trackId: audio?.trackId ?? null,
    codecDelaySeconds: audio?.codecDelaySeconds ?? 0,
    defaultSampleDuration: audio?.trex ? audio.trex.defaultSampleDuration : null,
  };
  return { info, tracks };
}

/** traf → { trackId, baseMediaDecodeTime, durationTicks, sampleCount, dataBytes (null if unknown) }. */
function parseTraf(b, s, e, tracks) {
  let trackId = null, defaultDuration = null, defaultSize = null, baseMediaDecodeTime = null;
  const truns = [];
  forEachBox(b, s, e, (type, ds, de) => {
    if (type === 'tfhd') {
      const flags = u32(b, ds) & 0xffffff;
      trackId = u32(b, ds + 4);
      let p = ds + 8;
      if (flags & TFHD_BASE_DATA_OFFSET) p += 8;
      if (flags & TFHD_SAMPLE_DESCRIPTION_INDEX) p += 4;
      if (flags & TFHD_DEFAULT_SAMPLE_DURATION) { defaultDuration = u32(b, p); p += 4; }
      if (flags & TFHD_DEFAULT_SAMPLE_SIZE) defaultSize = u32(b, p);
    } else if (type === 'tfdt') baseMediaDecodeTime = b[ds] === 1 ? u64(b, ds + 4) : u32(b, ds + 4);
    else if (type === 'trun') truns.push([ds, de]);
  });
  const trex = tracks?.get(trackId)?.trex;
  if (defaultDuration === null && trex?.defaultSampleDuration) defaultDuration = trex.defaultSampleDuration;
  if (defaultSize === null && trex?.defaultSampleSize) defaultSize = trex.defaultSampleSize;

  let durationTicks = 0, sampleCount = 0, dataBytes = 0, dataKnown = true;
  for (const [ds, de] of truns) {
    const flags = u32(b, ds) & 0xffffff;
    let count = u32(b, ds + 4); // sample_count
    let p = ds + 8;
    if (flags & TRUN_DATA_OFFSET) p += 4;
    if (flags & TRUN_FIRST_SAMPLE_FLAGS) p += 4;
    const hasDuration = flags & TRUN_SAMPLE_DURATION, hasSize = flags & TRUN_SAMPLE_SIZE;
    const stride = (hasDuration ? 4 : 0) + (hasSize ? 4 : 0) + (flags & TRUN_SAMPLE_FLAGS ? 4 : 0) + (flags & TRUN_SAMPLE_CTO ? 4 : 0);
    if (stride) count = Math.min(count, Math.floor((de - p) / stride)); // tolerate a truncated table
    sampleCount += count;
    if (hasDuration || hasSize) {
      for (let i = 0; i < count; i++, p += stride) {
        if (hasDuration) durationTicks += u32(b, p);
        if (hasSize) dataBytes += u32(b, p + (hasDuration ? 4 : 0));
      }
    }
    if (!hasDuration) durationTicks += count * (defaultDuration ?? 0);
    if (!hasSize) { if (defaultSize === null) dataKnown = false; else dataBytes += count * defaultSize; }
  }
  return { trackId, baseMediaDecodeTime, durationTicks, sampleCount, dataBytes: dataKnown ? dataBytes : null };
}

/**
 * moof → timing of the fragment for the chosen audio track plus the number of mdat payload
 * bytes its trun tables reference (used to tell when the fragment's mdat(s) are all in).
 */
function parseMoof(box, tracks, init, lastEnd) {
  const trafs = [];
  forEachBox(box, 8, box.length, (type, ds, de) => { if (type === 'traf') trafs.push(parseTraf(box, ds, de, tracks)); });
  let bytesNeeded = 0;
  for (const t of trafs) {
    if (t.dataBytes === null) { bytesNeeded = null; break; }
    bytesNeeded += t.dataBytes;
  }
  const chosen = (init && trafs.find((t) => t.trackId === init.trackId)) ?? trafs[0] ?? null;
  if (!chosen) return { start: lastEnd, end: lastEnd, blocks: 0, bytesNeeded };
  const timescale = tracks?.get(chosen.trackId)?.timescale ?? init?.timescale ?? 1; // no init: raw ticks
  const start = chosen.baseMediaDecodeTime !== null ? chosen.baseMediaDecodeTime / timescale : lastEnd;
  return { start, end: start + chosen.durationTicks / timescale, blocks: chosen.sampleCount, bytesNeeded };
}

/** True when boxes exactly tile b[start, end) and fn (optional) approves each: fn(type, dataStart, boxEnd). */
function tileBoxes(b, start, end, fn) {
  for (let pos = start; pos < end;) {
    if (pos + 8 > end) return false;
    let size = u32(b, pos), hdr = 8;
    if (size === 1) {
      if (pos + 16 > end) return false;
      size = u64(b, pos + 8);
      hdr = 16;
    }
    if (size < hdr || pos + size > end) return false;
    if (fn && !fn(fourcc(b, pos + 4), pos + hdr, pos + size)) return false;
    pos += size;
  }
  return true;
}

/** Could a top-level box header start at pos (8 bytes available)? */
function plausibleBoxHeader(b, pos) {
  const size = u32(b, pos), type = fourcc(b, pos + 4);
  return MP4_KNOWN_TYPES.has(type) && (size === 1 || (size >= 8 && size <= MAX_ELEMENT_SIZE) || (size === 0 && type === 'mdat'));
}

/**
 * Structural check of a complete top-level box before it is consumed. moof/moov must tile into
 * boxes (with at least one traf/trak that tiles too). An mdat payload is opaque, so a truncated mdat
 * (whose declared size swallows the start of the next fragment) is recognised only by its signature:
 * the bytes right after it are not a box header while a sync point sits inside its payload. That is
 * checked only when those following bytes are already buffered, so it adds no latency.
 */
function validMp4Box(b, type, hdr, size) {
  if (type === 'moof' || type === 'moov') {
    const want = type === 'moof' ? 'traf' : 'trak';
    let found = false;
    const tiled = tileBoxes(b, hdr, size, (t, ds, de) => {
      if (t !== want) return true;
      found = true;
      return tileBoxes(b, ds, de);
    });
    return tiled && found;
  }
  if (type === 'mdat' && b.length >= size + 8 && !plausibleBoxHeader(b, size)) return scanMp4Sync(b.subarray(hdr, size)).sync < 0;
  return true;
}

// ---------------------------------------------------------------------------- resync
//
// After garbage (a stream picked up mid-unit, bytes after a discontinuity) the parser scans for the
// next plausible unit start and discards everything before it. Each scanner returns offsets
// { sync, partial } (-1 when absent): `sync` is a complete sync pattern, `partial` the earliest tail
// position whose bytes are still consistent with one (kept so a header split across pushes survives).

/** WebM sync points: the EBML header magic, or a Cluster id followed by a valid size vint. */
function scanWebmSync(b) {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    const magic = b[i] === 0x1a ? EBML_MAGIC : b[i] === 0x1f ? CLUSTER_MAGIC : null;
    if (!magic) continue;
    let k = 1;
    while (k < 4 && i + k < n && b[i + k] === magic[k]) k++;
    if (k < 4) {
      if (i + k >= n) return { sync: -1, partial: i };
      continue;
    }
    if (magic === EBML_MAGIC) return { sync: i, partial: -1 };
    const size = readVint(b, i + 4, n, false);
    if (size === null) return { sync: -1, partial: i };
    if (size && (size.unknown || size.value <= MAX_ELEMENT_SIZE)) return { sync: i, partial: -1 };
  }
  return { sync: -1, partial: -1 };
}

/** MP4 sync points: a plausible size (≥ 8, ≤ 64 MiB, or 1 + largesize) followed by a MP4_SYNC_TYPES type. */
function scanMp4Sync(b) {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    if (i + 8 > n) { // tail: keep it if it could still turn into a sync header
      if (mp4HeaderPrefixPlausible(b, i, n)) return { sync: -1, partial: i };
      continue;
    }
    const c = b[i + 4]; // cheap pre-check: first letter of moof/ftyp/moov/styp/sidx/emsg/prft
    if (c !== 0x6d && c !== 0x66 && c !== 0x73 && c !== 0x65 && c !== 0x70) continue;
    if (!MP4_SYNC_TYPE_SET.has(fourcc(b, i + 4))) continue;
    const size = u32(b, i);
    if (size === 1) {
      if (i + 16 > n) return { sync: -1, partial: i };
      const large = u64(b, i + 8);
      if (large >= 16 && large <= MAX_ELEMENT_SIZE) return { sync: i, partial: -1 };
    } else if (size >= 8 && size <= MAX_ELEMENT_SIZE) return { sync: i, partial: -1 };
  }
  return { sync: -1, partial: -1 };
}

/** Fewer than 8 bytes are available from i: are they consistent with the start of a sync header? */
function mp4HeaderPrefixPlausible(b, i, n) {
  const avail = n - i;
  if (avail >= 4) {
    const size = u32(b, i);
    if (size !== 1 && (size < 8 || size > MAX_ELEMENT_SIZE)) return false;
  }
  return MP4_SYNC_TYPES.some((t) => {
    for (let k = 4; k < avail; k++) if (t.charCodeAt(k - 4) !== b[i + k]) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------- public API

/**
 * Sniffs the container of a byte stream from its first bytes.
 * WebM: any top-level EBML element id at offset 0 (EBML header, Segment, Cluster, ...), so a
 * stream picked up mid-way still detects. MP4: bytes 4..8 spell a known top-level box type.
 */
export function detectContainer(bytes) {
  const b = toU8(bytes);
  if (b.length >= 4 && WEBM_TOP_LEVEL_IDS.has(u32(b, 0))) return 'webm';
  if (b.length >= 8 && MP4_TOP_LEVEL_TYPES.has(fourcc(b, 4))) return 'mp4';
  return null;
}

export class ByteStreamParser {
  constructor(opts = {}) {
    const container = opts.container ?? null;
    if (container !== null && container !== 'webm' && container !== 'mp4') throw new TypeError(`unsupported container: ${container}`);
    this._container = container;
    this._queue = new ByteQueue(); // bytes not yet framed into a complete top-level item
    this._init = null;
    this._pending = []; // complete top-level items that may form the next init unit
    this._resync = false; // true while scanning for the next plausible unit start
    // WebM
    this._cluster = null; // open unknown-size Cluster: { parts }
    this._fallbackTrackId = null; // track followed when no init is known: the first one seen
    // MP4
    this._tracks = null; // track_ID → track description from the latest moov
    this._unit = null; // fragment being assembled: { moof, mdats, mdatBytes, bytesNeeded, start, end, blocks }
    this._openMdat = null; // parts of a size-0 mdat, which only flush() can end
    this._lastEnd = 0; // end of the previous fragment, the fallback when tfdt is missing
  }

  get container() { return this._container; }
  get init() { return this._init; }

  /**
   * Appends bytes and returns every unit that became complete. Never throws for malformed input
   * (garbage triggers a resync instead); only a wrong argument type raises a TypeError.
   */
  push(bytes) {
    const b = toU8(bytes);
    const units = [];
    if (b.length) this._queue.push(b);
    if (!this._container && !this._detect()) return units;
    if (this._container === 'webm') this._pushWebm(units);
    else this._pushMp4(units);
    return units;
  }

  /** Emits what only the end of the stream can finalize, then drops all partial state. */
  flush() {
    const units = [];
    if (this._container === 'webm') {
      if (this._cluster) this._closeCluster(units);
      this._emitWebmInit(units); // an init segment not yet followed by a Cluster
    } else if (this._container === 'mp4') {
      if (this._openMdat) {
        if (this._unit) this._unit.mdats.push(concat(this._openMdat.parts));
        this._openMdat = null;
      }
      this._closeUnit(units, false);
    }
    this.reset();
    return units;
  }

  /** Discards buffered partial bytes (MSE abort() semantics); the last init info is kept. */
  reset() {
    this._queue.clear();
    this._pending = [];
    this._resync = false;
    this._cluster = null;
    this._unit = null;
    this._openMdat = null;
  }

  // ---- container detection and resync

  /** Container unknown: sniff the head, or scan past leading garbage for either format's sync point. */
  _detect() {
    const q = this._queue, b = q.peek();
    const sniffed = detectContainer(b);
    if (sniffed) {
      this._container = sniffed;
      return true;
    }
    if (b.length < 8) return false;
    const w = scanWebmSync(b), m = scanMp4Sync(b);
    const first = (x, y) => (x < 0 ? y : y < 0 ? x : Math.min(x, y));
    const sync = first(w.sync, m.sync);
    if (sync >= 0) {
      this._container = sync === w.sync ? 'webm' : 'mp4';
      q.take(sync);
      return true;
    }
    this._keepTail(first(w.partial, m.partial), b.length);
    return false;
  }

  /** Something unparsable was met: drop partial state, step past one byte and look for the next unit start. */
  _corrupt() {
    this._pending = [];
    this._cluster = null;
    this._unit = null;
    this._openMdat = null;
    this._queue.take(1);
    this._resync = true;
  }

  /** In resync mode: true once the queue starts at a sync point; otherwise discards hopeless bytes and waits. */
  _resyncScan() {
    const q = this._queue, b = q.peek();
    const r = this._container === 'webm' ? scanWebmSync(b) : scanMp4Sync(b);
    if (r.sync >= 0) {
      q.take(r.sync);
      this._resync = false;
      return true;
    }
    this._keepTail(r.partial, b.length);
    return false;
  }

  /** Keeps the bytes from a partial sync candidate on, else just the last 8 bytes (a header may straddle pushes). */
  _keepTail(partial, length) {
    if (partial >= 0) this._queue.take(partial);
    else if (length > 8) this._queue.take(length - 8);
  }

  // ---- WebM

  _pushWebm(units) {
    const q = this._queue;
    for (;;) {
      if (this._resync && !this._resyncScan()) break;
      const b = q.peek();
      const h = readElementHeader(b, 0, b.length);
      if (h === null) break; // header not complete yet
      if (h === false) { this._corrupt(); continue; } // malformed vint
      const total = h.headerLen + h.size;

      if (this._cluster) { // inside an unknown-size Cluster
        if (WEBM_TOP_LEVEL_IDS.has(h.id)) { this._closeCluster(units); continue; } // next top-level element ends it
        if (!CLUSTER_CHILD_IDS.has(h.id) || h.unknown || h.size > MAX_ELEMENT_SIZE) { this._corrupt(); continue; }
        if (b.length < total) break;
        this._cluster.parts.push(q.take(total));
        continue;
      }
      if (h.id === ID_CLUSTER) {
        this._emitWebmInit(units); // everything before the first Cluster is the init unit
        if (h.unknown) { this._cluster = { parts: [q.take(h.headerLen)] }; continue; }
        if (h.size > MAX_ELEMENT_SIZE) { this._corrupt(); continue; }
        if (b.length < total) break;
        if (!validWebmCluster(b, h.dataStart, total)) { this._corrupt(); continue; } // truncated or corrupt
        units.push(this._webmMediaUnit(q.take(total), true));
        continue;
      }
      // EBML header, Segment, SeekHead, Info, Tracks, Cues, Tags, Void, CRC-32: candidates for an init unit.
      if (!WEBM_TOP_LEVEL_IDS.has(h.id) && h.id !== ID_VOID && h.id !== ID_CRC32) { this._corrupt(); continue; }
      // The Segment (and any other unknown-size master) contributes only its header; its children follow as top-level items.
      if (h.id === ID_SEGMENT || h.unknown) { this._pending.push(q.take(h.headerLen)); continue; }
      if (h.size > MAX_ELEMENT_SIZE || (h.id === ID_CRC32 && h.size !== 4)) { this._corrupt(); continue; }
      if (b.length < total) break;
      this._pending.push(q.take(total));
    }
  }

  _emitWebmInit(units) {
    if (!this._pending.length) return;
    const bytes = concat(this._pending);
    this._pending = [];
    const info = parseWebmInit(bytes);
    if (!info) return; // stray elements between clusters (Cues, Void, Tags): dropped
    this._init = info;
    units.push({ kind: 'init', bytes, info });
  }

  _closeCluster(units) {
    units.push(this._webmMediaUnit(concat(this._cluster.parts), false));
    this._cluster = null;
  }

  _webmMediaUnit(bytes, complete) {
    const trackId = this._init?.trackId ?? this._fallbackTrackId;
    const { start, end, blocks, trackId: followed } = parseWebmCluster(bytes, trackId, this._init?.timescale ?? 1e9 / DEFAULT_TIMECODE_SCALE);
    if (trackId === null && followed !== null) this._fallbackTrackId = followed; // no init: keep following the first track seen
    return { kind: 'media', bytes, info: { start, end, blocks, complete } };
  }

  // ---- MP4

  _pushMp4(units) {
    const q = this._queue;
    for (;;) {
      if (this._resync && !this._resyncScan()) break;
      if (this._openMdat) { // size-0 mdat: everything until flush() belongs to it
        if (q.length) this._openMdat.parts.push(q.takeAll());
        break;
      }
      const b = q.peek();
      if (b.length < 8) break;
      let size = u32(b, 0);
      const type = fourcc(b, 4);
      let hdr = 8;
      if (!MP4_KNOWN_TYPES.has(type)) { this._corrupt(); continue; } // not a box we know at the top level
      if (size === 1) { // largesize
        if (b.length < 16) break;
        size = u64(b, 8);
        hdr = 16;
      }
      if (size === 0) {
        if (type !== 'mdat') { this._corrupt(); continue; }
        this._openMdat = { parts: [q.takeAll()] };
        break;
      }
      if (size < hdr || size > MAX_ELEMENT_SIZE) { this._corrupt(); continue; }
      if (b.length < size) break;
      if (!validMp4Box(b, type, hdr, size)) { this._corrupt(); continue; }
      this._handleBox(type, hdr, q.take(size), units);
    }
  }

  _handleBox(type, hdrLen, box, units) {
    switch (type) {
      case 'moov': { // completes an init unit: ftyp/free/... collected so far + moov
        this._closeUnit(units, true);
        this._pending.push(box);
        const bytes = concat(this._pending);
        this._pending = [];
        const { info, tracks } = parseMoov(box);
        this._init = info;
        this._tracks = tracks;
        units.push({ kind: 'init', bytes, info });
        break;
      }
      case 'moof': {
        this._closeUnit(units, true);
        this._pending = []; // styp/sidx/emsg/prft/free ahead of a moof are not part of any unit
        const timing = parseMoof(box, this._tracks, this._init, this._lastEnd);
        this._unit = { moof: box, mdats: [], mdatBytes: 0, ...timing };
        break;
      }
      case 'mdat': {
        const unit = this._unit;
        if (!unit) break; // mdat without a moof: nothing to attach it to
        unit.mdats.push(box);
        unit.mdatBytes += box.length - hdrLen;
        // Done once the mdat payload covers every byte the trun tables reference (or we cannot tell).
        if (unit.bytesNeeded === null || unit.mdatBytes >= unit.bytesNeeded) this._closeUnit(units, true);
        break;
      }
      default: // ftyp, free, skip, styp, sidx, emsg, prft, mfra, uuid, ...
        this._closeUnit(units, true); // any other top-level box ends a pending fragment
        this._pending.push(box); // kept only if a moov follows
    }
  }

  _closeUnit(units, complete) {
    const unit = this._unit;
    if (!unit) return;
    this._unit = null;
    if (!unit.mdats.length) return; // a moof without media data is dropped
    this._lastEnd = unit.end;
    units.push({
      kind: 'media',
      bytes: concat([unit.moof, ...unit.mdats]),
      info: { start: unit.start, end: unit.end, blocks: unit.blocks, complete },
    });
  }
}

/**
 * Joins one init unit and media units into a single decodable file (for decodeAudioData).
 * WebM: a Segment with a known size would not cover appended Clusters, so it is rewritten to the
 * 8-byte unknown size (01 FF FF FF FF FF FF FF); a Segment that is already unknown-size is kept
 * byte for byte. MP4: plain concatenation.
 */
export function buildFile(initBytes, mediaBytesList, container) {
  const init = toU8(initBytes);
  const media = Array.from(mediaBytesList, (m) => toU8(m?.bytes ?? m));
  const kind = container ?? detectContainer(init);
  return concat([kind === 'webm' ? withUnknownSegmentSize(init) : init, ...media]);
}

function withUnknownSegmentSize(init) {
  let pos = 0;
  while (pos < init.length) {
    const h = readElementHeader(init, pos, init.length);
    if (!h) break;
    if (h.id === ID_SEGMENT) {
      if (h.unknown) return init;
      return concat([init.subarray(0, pos + h.idLen), UNKNOWN_SIZE_8, init.subarray(h.dataStart)]);
    }
    pos = h.dataStart + (h.unknown ? 0 : h.size); // skip the EBML header (or anything else ahead of the Segment)
  }
  return init;
}
