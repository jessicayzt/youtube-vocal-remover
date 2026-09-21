# Third-party components

| Component | Version | License | Files |
|---|---|---|---|
| ONNX Runtime Web (Microsoft) | 1.30.0 | MIT | `vendor/ort/ort.min.mjs`, `vendor/ort/ort-wasm-simd-threaded.jsep.mjs`, `vendor/ort/ort-wasm-simd-threaded.jsep.wasm` |
| Signalsmith Stretch (Signalsmith Audio) | 1.3.2 (JS/WASM release) | MIT | `vendor/signalsmith/SignalsmithStretch.mjs` (patched: additionally exports the Emscripten module factory as `StretchModuleFactory`) |
| UVR-MDX-NET Inst HQ 3 / Inst HQ 5 models (Anjok07 / Ultimate Vocal Remover project, distributed via TRvlvr/model_repo) | — | MIT (UVR repository license) | `models/*.onnx` |

Test fixtures under `test/fixtures/` come from the web-platform-tests project (BSD 3-Clause).

The separation pipeline (STFT framing, chunk overlap-add, `compensate` factors, lowest-bin zeroing, denoise pass) follows the reference implementation in the Ultimate Vocal Remover GUI so that the ONNX models behave as they do in UVR.
