// On-device speech recognition: Whisper, run in a Web Worker with transformers.js. The page only ever sends audio to the
// worker. The model files come from huggingface.co on first use and are cached by the library in this browser.
import { SpeechAccuracy } from '../core/settings.js';

/** onnx-community ids. NOT verified from the build environment (it could not reach huggingface.co): check them first. */
export const WHISPER_MODELS = Object.freeze({
  [SpeechAccuracy.Fast]: 'onnx-community/whisper-tiny.en',
  [SpeechAccuracy.Balanced]: 'onnx-community/whisper-base.en',
  [SpeechAccuracy.Accurate]: 'onnx-community/whisper-small.en',
});

export function modelFor(accuracy) { return WHISPER_MODELS[accuracy] ?? WHISPER_MODELS[SpeechAccuracy.Balanced]; }

export class WhisperTranscriber {
  #worker = null; #nextId = 1; #pending = new Map(); #ready = null; #device = 'wasm';

  /**
   * @param {object} o
   * @param {string} o.accuracy  Fast | Balanced | Accurate
   * @param {boolean} o.webGpu   try WebGPU first
   * @param {(p:{percent:number|null, text:string})=>void} [o.onProgress]
   * @param {(device:string)=>void} [o.onReady]
   * @param {()=>Worker} [o.createWorker]
   */
  constructor({ accuracy, webGpu, onProgress = () => {}, onReady = () => {}, createWorker = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }) }) {
    this.model = modelFor(accuracy);
    this.webGpu = webGpu;
    this.onProgress = onProgress;
    this.onReady = onReady;
    this.createWorker = createWorker;
  }

  get device() { return this.#device; }

  /** Starts the worker and the model download; resolves when the model is ready to transcribe. */
  load() {
    if (this.#ready) return this.#ready;
    this.#ready = new Promise((resolve, reject) => {
      const worker = this.#worker = this.createWorker();
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') this.onProgress({ percent: m.percent, text: m.text });
        else if (m.type === 'ready') { this.#device = m.device; this.onReady(m.device); resolve(this); }
        else if (m.type === 'result') { this.#pending.get(m.id)?.resolve(m.text); this.#pending.delete(m.id); }
        else if (m.type === 'error') {
          const err = new Error(m.message);
          if (m.id === undefined) reject(err); else { this.#pending.get(m.id)?.reject(err); this.#pending.delete(m.id); }
        }
      };
      worker.onerror = (e) => { const err = new Error(e.message || 'The speech worker stopped'); reject(err); for (const p of this.#pending.values()) p.reject(err); this.#pending.clear(); };
      worker.postMessage({ type: 'load', model: this.model, webGpu: this.webGpu, base: new URL('../../vendor/ort/', import.meta.url).href });
    });
    return this.#ready;
  }

  /** @param {Float32Array} audio 16 kHz mono */
  async transcribe(audio, signal) {
    await this.load();
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const copy = audio.slice(); // the caller may keep using its array
      this.#worker.postMessage({ type: 'run', id, audio: copy }, [copy.buffer]);
    });
  }

  /** The live words use the same model; only the newest few seconds of speech are sent (see AudioPipeline). */
  preview(audio, signal) { return this.transcribe(audio, signal); }

  dispose() {
    this.#worker?.terminate();
    this.#worker = null;
    for (const p of this.#pending.values()) p.reject(new Error('Stopped'));
    this.#pending.clear();
  }
}
