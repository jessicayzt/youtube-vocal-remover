// Module worker: runs the MDX-Net separation model with ONNX Runtime Web (WebGPU when
// available, multi-threaded WebAssembly otherwise) over the shared mixture store and writes
// the instrumental into the shared instrumental store, block by block, as chunks finalise.
import * as ort from '../../vendor/ort/ort.min.mjs';
import { STFT } from '../dsp/stft.js';
import { MdxGrid, MdxAccumulator } from '../dsp/mdx.js';

ort.env.wasm.wasmPaths = new URL('../../vendor/ort/', import.meta.url).href;
// leave cores for the page: saturating the CPU makes YouTube's player stall and complain
ort.env.wasm.numThreads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
ort.env.wasm.proxy = false;

// Once the processed audio runs this far ahead of the listener, the job goes easy on the GPU/CPU
// while the video is playing: every chunk is followed by a pause as long as its own processing
// took (half duty), so the video's own decoding and compositing are not starved. Not playing,
// or not yet this far ahead: full speed.
const PACE_AHEAD_SECONDS = 30;
const PACE_IDLE_RATIO = 1;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sessions = new Map(); // modelId -> { session, backend, spec }
let registry = null;
let job = null;
const post = (m) => self.postMessage(m);

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init': registry = m.registry; break;
    case 'start': startJob(m); break;
    case 'priority': if (job && job.id === m.jobId) { if (m.block != null) job.priorityBlock = m.block; job.playing = !!m.playing; job.wake(); } break;
    case 'mix-progress': if (job && job.id === m.jobId) job.wake(); break;
    case 'cancel': if (job && job.id === m.jobId) { job.cancelled = true; job.wake(); } break;
    default: break;
  }
};

async function hasWebGPU() {
  try {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch (e) { return false; }
}

async function getSession(modelId) {
  if (sessions.has(modelId)) return sessions.get(modelId);
  const spec = registry.models[modelId];
  if (!spec) throw new Error('unknown model ' + modelId);
  const url = new URL('../../models/' + spec.file, import.meta.url).href;
  let session = null, backend = 'wasm';
  if (await hasWebGPU()) {
    try {
      session = await ort.InferenceSession.create(url, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
      backend = 'webgpu';
    } catch (e) {
      post({ type: 'log', message: 'WebGPU session failed, falling back to WebAssembly: ' + (e && e.message || e) });
    }
  }
  if (!session) session = await ort.InferenceSession.create(url, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const entry = { session, backend, spec, inputName: session.inputNames[0], outputName: session.outputNames[0] };
  sessions.set(modelId, entry);
  return entry;
}

function startJob(m) {
  const prev = job;
  const j = {
    id: m.jobId, cancelled: false, priorityBlock: m.priorityBlock ?? null, playing: !!m.playing, waiters: [],
    wake() { for (const w of this.waiters.splice(0)) w(); },
    wait() { return new Promise((resolve) => this.waiters.push(resolve)); },
  };
  job = j;
  j.done = (async () => {
    if (prev) { prev.cancelled = true; prev.wake(); try { await prev.done; } catch (e) { /* ignore */ } }
    if (j.cancelled) { post({ type: 'cancelled', jobId: j.id }); return; }
    try { await runJob(j, m); }
    catch (e) { post({ type: 'error', jobId: j.id, message: String(e && e.message || e) }); }
    finally { if (job === j) job = null; }
  })();
}

async function runJob(j, m) {
  post({ type: 'loading', jobId: j.id });
  const { spec, session, backend, inputName, outputName } = await getSession(m.modelId);
  if (j.cancelled) { post({ type: 'cancelled', jobId: j.id }); return; }
  post({ type: 'backend', jobId: j.id, backend, threads: backend === 'wasm' ? ort.env.wasm.numThreads : null });

  const grid = new MdxGrid({ nFft: spec.nFft, hop: spec.hop, dimT: spec.dimT, overlap: m.overlap, totalSamples: m.totalSamples, blockSize: m.blockSize });
  const stft = new STFT({ nFft: spec.nFft, hop: spec.hop, dimF: spec.dimF });
  const mixL = new Int16Array(m.mixL), mixR = new Int16Array(m.mixR);
  const instL = new Int16Array(m.instL), instR = new Int16Array(m.instR);
  const mixReady = new Uint8Array(m.mixReady), instReady = new Uint8Array(m.instReady);
  const scale = m.scale, inv = 1 / scale, bs = m.blockSize, total = m.totalSamples;

  const acc = new MdxAccumulator(grid, {
    compensate: spec.compensate,
    onBlockFinal: (b, l, r) => {
      const at = b * bs;
      for (let i = 0; i < l.length; i++) {
        const x = at + i;
        let a = l[i] * scale, c = r[i] * scale;
        instL[x] = a > 32767 ? 32767 : a < -32768 ? -32768 : Math.round(a);
        instR[x] = c > 32767 ? 32767 : c < -32768 ? -32768 : Math.round(c);
      }
      instReady[b] = 1;
    },
  });
  // chunks whose blocks are all already final (cache or an earlier run) need no work
  for (let k = 0; k < grid.numChunks; k++) {
    const rng = grid.blocksOfChunk(k);
    let all = true;
    if (rng) for (let b = rng[0]; b <= rng[1]; b++) if (!instReady[b]) { all = false; break; }
    if (all) { acc.processed[k] = 1; acc.processedCount++; }
  }
  for (let b = 0; b < grid.numBlocks; b++) if (instReady[b]) { acc.finalBlocks[b] = 1; acc.finalCount++; }

  const mixReadyForChunk = (k) => {
    const rng = grid.blocksOfChunk(k);
    if (!rng) return true;
    for (let b = rng[0]; b <= rng[1]; b++) if (!mixReady[b]) return false;
    return true;
  };
  const tryFrom = (from) => {
    let k = acc.nextUnprocessed(from);
    while (k >= 0) { if (mixReadyForChunk(k)) return k; k = acc.nextUnprocessed(k + 1); }
    return -1;
  };
  const pickChunk = () => {
    // 1. the chunks under (and just after) the listener's position, so what is playing gets done first
    if (j.priorityBlock != null) {
      const pb = Math.max(0, Math.min(grid.numBlocks - 1, j.priorityBlock | 0));
      const [kmin, kmax] = grid.chunksCoveringBlock(pb);
      for (let k = kmin; k <= Math.min(grid.numChunks - 1, kmax + 1); k++) if (!acc.processed[k] && mixReadyForChunk(k)) return k;
    }
    // 2. otherwise strictly from the start of the video
    const k = tryFrom(0);
    if (k >= 0) return k;
    return acc.nextUnprocessed(0) >= 0 ? -2 : -1; // -2: wait for more decoded audio
  };

  // seconds of final audio from the listener's position onwards (capped: only "far enough" matters)
  const aheadSeconds = () => {
    if (j.priorityBlock == null) return Infinity;
    const cap = Math.ceil((PACE_AHEAD_SECONDS * 44100) / bs) + 1;
    let b = Math.max(0, Math.min(grid.numBlocks - 1, j.priorityBlock | 0)), n = 0;
    while (b < grid.numBlocks && n < cap && acc.finalBlocks[b]) { b++; n++; }
    return b >= grid.numBlocks ? Infinity : (n * bs) / 44100;
  };

  const T = spec.dimT, dimF = spec.dimF;
  const specBuf = new Float32Array(4 * dimF * T);
  const specNeg = m.denoise ? new Float32Array(4 * dimF * T) : null;
  const cl = new Float32Array(grid.chunkSize), cr = new Float32Array(grid.chunkSize);
  const dims = [1, 4, dimF, T];
  let speed = null, lastProgress = 0;
  const progress = (force) => {
    const now = performance.now();
    if (!force && now - lastProgress < 250) return;
    lastProgress = now;
    post({ type: 'progress', jobId: j.id, processedChunks: acc.processedCount, numChunks: grid.numChunks, finalBlocks: acc.finalCount, numBlocks: grid.numBlocks, speed });
  };
  progress(true);

  while (!j.cancelled) {
    const k = pickChunk();
    if (k === -1) break;
    if (k === -2) { post({ type: 'waiting', jobId: j.id }); await j.wait(); continue; }
    const t0 = performance.now();
    const cs = grid.chunkStart(k);
    for (let i = 0; i < grid.chunkSize; i++) {
      const x = cs + i;
      if (x < 0 || x >= total) { cl[i] = 0; cr[i] = 0; } else { cl[i] = mixL[x] * inv; cr[i] = mixR[x] * inv; }
    }
    stft.forward([cl, cr], specBuf, 3);
    const r1 = await session.run({ [inputName]: new ort.Tensor('float32', specBuf, dims) });
    let outData = r1[outputName].data;
    if (specNeg) {
      for (let i = 0; i < specBuf.length; i++) specNeg[i] = -specBuf[i];
      const r2 = await session.run({ [inputName]: new ort.Tensor('float32', specNeg, dims) });
      const d2 = r2[outputName].data;
      const merged = new Float32Array(outData.length);
      for (let i = 0; i < merged.length; i++) merged[i] = 0.5 * outData[i] - 0.5 * d2[i];
      outData = merged;
    }
    const oL = new Float32Array(grid.chunkSize), oR = new Float32Array(grid.chunkSize);
    stft.inverse(outData, T, [oL, oR]);
    acc.addChunkOutput(k, oL, oR);
    const dt = (performance.now() - t0) / 1000;
    const inst = (grid.step / 44100) / Math.max(dt, 1e-3);
    speed = speed == null ? inst : speed * 0.7 + inst * 0.3;
    progress(false);
    if (j.playing && !j.cancelled && aheadSeconds() >= PACE_AHEAD_SECONDS) await sleep(Math.min(2000, dt * 1000 * PACE_IDLE_RATIO));
  }
  progress(true);
  post({ type: j.cancelled ? 'cancelled' : 'done', jobId: j.id, complete: acc.finalCount === grid.numBlocks });
}
