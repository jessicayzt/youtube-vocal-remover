// Heavy manual check (not run by `node --test`): push a synthetic stereo signal through the
// real ONNX models with the same STFT/chunking code the extension uses, using the Node build
// of onnxruntime-web. Usage: ORT_NODE_MODULES=<dir with onnxruntime-web> node test/model-e2e.mjs [modelId] [seconds]
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { STFT } from '../src/dsp/stft.js';
import { MdxGrid, MdxAccumulator } from '../src/dsp/mdx.js';

const require = createRequire(import.meta.url);
const ortDir = process.env.ORT_NODE_MODULES || (process.env.TMPDIR + '/vendor/nm/node_modules');
const ort = require(ortDir + '/onnxruntime-web/dist/ort.node.min.js');
const registry = JSON.parse(readFileSync(new URL('../models/models.json', import.meta.url)));
const modelId = process.argv[2] || registry.default;
const seconds = Number(process.argv[3] || 8);
const m = registry.models[modelId];
const sr = 44100, total = Math.round(seconds * sr);

// synthetic mixture: harmonic "voice" with vibrato + bass + noise bursts
const mixL = new Float32Array(total), mixR = new Float32Array(total);
for (let i = 0; i < total; i++) {
  const t = i / sr;
  const f0 = 220 * (1 + 0.01 * Math.sin(2 * Math.PI * 5.5 * t));
  let voice = 0; for (let h = 1; h <= 8; h++) voice += Math.sin(2 * Math.PI * f0 * h * t) / h;
  const bass = Math.sign(Math.sin(2 * Math.PI * 55 * t)) * 0.3;
  const burst = (t % 0.5) < 0.03 ? (Math.random() * 2 - 1) * 0.5 : 0;
  mixL[i] = 0.25 * voice + bass + burst; mixR[i] = 0.2 * voice + bass * 0.9 + burst;
}

const grid = new MdxGrid({ nFft: m.nFft, hop: m.hop, dimT: m.dimT, overlap: 0.25, totalSamples: total });
const stft = new STFT({ nFft: m.nFft, hop: m.hop, dimF: m.dimF });
const outL = new Float32Array(total), outR = new Float32Array(total);
const acc = new MdxAccumulator(grid, { compensate: m.compensate, onBlockFinal: (b, l, r) => { outL.set(l, b * grid.blockSize); outR.set(r, b * grid.blockSize); } });

const t0 = Date.now();
const session = await ort.InferenceSession.create(new URL('../models/' + m.file, import.meta.url).pathname, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
console.log(`[${modelId}] session ready in ${Date.now() - t0} ms; chunks=${grid.numChunks} chunk=${grid.chunkSize} step=${grid.step}`);
const T = grid.dimT;
const spec = new Float32Array(4 * m.dimF * T);
const cl = new Float32Array(grid.chunkSize), cr = new Float32Array(grid.chunkSize);
for (let k = 0; k < grid.numChunks; k++) {
  const cs = grid.chunkStart(k);
  for (let i = 0; i < grid.chunkSize; i++) { const x = cs + i; const inside = x >= 0 && x < total; cl[i] = inside ? mixL[x] : 0; cr[i] = inside ? mixR[x] : 0; }
  const t1 = Date.now();
  const frames = stft.forward([cl, cr], spec, 3);
  if (frames !== T) throw new Error('frame count ' + frames);
  const t2 = Date.now();
  const res = await session.run({ input: new ort.Tensor('float32', spec, [1, 4, m.dimF, T]) });
  const t3 = Date.now();
  const outSpec = res.output.data;
  const oL = new Float32Array(grid.chunkSize), oR = new Float32Array(grid.chunkSize);
  stft.inverse(outSpec, T, [oL, oR]);
  const t4 = Date.now();
  acc.addChunkOutput(k, oL, oR);
  console.log(` chunk ${k}: stft ${t2 - t1} ms, model ${t3 - t2} ms, istft ${t4 - t3} ms, final blocks ${acc.finalCount}/${grid.numBlocks}`);
}
let eIn = 0, eOut = 0, finite = true, peak = 0;
for (let i = 0; i < total; i++) { eIn += mixL[i] ** 2; eOut += outL[i] ** 2; if (!Number.isFinite(outL[i])) finite = false; peak = Math.max(peak, Math.abs(outL[i])); }
console.log(`[${modelId}] done in ${Date.now() - t0} ms; all blocks final=${acc.finalCount === grid.numBlocks}; finite=${finite}; energy out/in=${(eOut / eIn).toFixed(3)}; peak=${peak.toFixed(3)}`);
await session.release();
