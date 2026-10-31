// The Whisper worker: loads a model with transformers.js and transcribes 16 kHz mono audio sent from the page.
// Libraries are vendored (see scripts/build.mjs): nothing is loaded from a CDN. Model files come from huggingface.co.
import { pipeline, env } from '../../vendor/transformers.min.js';

env.allowLocalModels = false; // there are no models on this site; they come from the Hub and are cached by the library
env.allowRemoteModels = true;

let asr = null;

// Which of the onnxruntime builds works with which backend was checked in Chromium: the "asyncify" build runs WebGPU and
// WASM, the "jsep" build does NOT run WebGPU with this version of the library. The plain build is smaller, for the CPU.
const RUNTIME = { webgpu: 'ort-wasm-simd-threaded.asyncify', wasm: 'ort-wasm-simd-threaded' };

function useRuntime(base, device) {
  const prefix = RUNTIME[device];
  env.backends.onnx.wasm.wasmPaths = { mjs: `${base}${prefix}.mjs`, wasm: `${base}${prefix}.wasm` };
  env.backends.onnx.wasm.numThreads = 1; // threads need cross-origin isolation, which a static host can't give
}

async function hasWebGpu() {
  try { return Boolean(self.navigator?.gpu && await self.navigator.gpu.requestAdapter()); } catch { return false; }
}

const post = (m) => self.postMessage(m);

function progressReporter() {
  const files = new Map();
  return (p) => {
    if (p.status === 'progress' && p.total) files.set(p.file, { loaded: p.loaded, total: p.total });
    else if (p.status === 'done') { const f = files.get(p.file); if (f) f.loaded = f.total; }
    let loaded = 0; let total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    if (total > 0) post({ type: 'progress', percent: Math.round((loaded / total) * 100), text: `Downloading the speech model… ${Math.round((loaded / total) * 100)}%` });
    else if (p.status === 'initiate' || p.status === 'download') post({ type: 'progress', percent: null, text: 'Downloading the speech model…' });
  };
}

async function load({ model, webGpu, base }) {
  const attempts = [];
  if (webGpu && await hasWebGpu()) {
    attempts.push({ device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } });
    attempts.push({ device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'fp32' } });
  }
  attempts.push({ device: 'wasm', dtype: 'q8' });
  attempts.push({ device: 'wasm', dtype: 'fp32' });

  let lastError = null;
  for (const a of attempts) {
    try {
      useRuntime(base, a.device);
      post({ type: 'progress', percent: null, text: 'Loading the speech model…' });
      asr = await pipeline('automatic-speech-recognition', model, { device: a.device, dtype: a.dtype, progress_callback: progressReporter() });
      await asr(new Float32Array(16000)); // a second of silence: gets the model warm so the first sentence isn't slow
      post({ type: 'ready', device: a.device });
      return;
    } catch (err) {
      lastError = err;
      asr = null;
    }
  }
  throw lastError ?? new Error('The speech model could not be loaded');
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') await load(m);
    else if (m.type === 'run') {
      const out = await asr(m.audio, { chunk_length_s: 30, return_timestamps: false });
      post({ type: 'result', id: m.id, text: Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text });
    }
  } catch (err) {
    post({ type: 'error', id: m.id, message: String(err?.message ?? err) });
  }
};
