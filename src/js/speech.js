// Owns the on-device speech model: created when needed, replaced when the accuracy setting changes.
import { WhisperTranscriber } from './stt/whisper.js';

export class SpeechService {
  #current = null; #key = ''; #failed = null;

  /** @param {{getSettings:()=>object, webGpu:boolean, onProgress:(p:object)=>void, onReady:(device:string)=>void, onFailed:(err:Error)=>void, create?:Function}} o */
  constructor({ getSettings, webGpu, onProgress, onReady, onFailed, create = (o) => new WhisperTranscriber(o) }) {
    Object.assign(this, { getSettings, webGpu, onProgress, onReady, onFailed, create });
    /** The object the audio pipeline calls; it always uses the model the settings name right now. */
    this.transcriber = {
      transcribe: (audio, signal) => this.#model().transcribe(audio, signal),
      preview: (audio, signal) => this.#model().preview(audio, signal),
    };
  }

  #model() {
    const accuracy = this.getSettings().speechAccuracy;
    const key = `${accuracy}|${this.webGpu}`;
    if (this.#current && key !== this.#key) { this.#current.dispose(); this.#current = null; }
    if (!this.#current) {
      this.#key = key;
      this.#failed = null;
      this.#current = this.create({ accuracy, webGpu: this.webGpu, onProgress: this.onProgress, onReady: this.onReady });
    }
    return this.#current;
  }

  /** Start loading the model now (so the first sentence isn't slow). Resolves true when it is ready. */
  async warmUp({ retry = false } = {}) {
    if (retry && this.#failed) { this.#current?.dispose(); this.#current = null; }
    try { await this.#model().load(); this.#failed = null; return true; }
    catch (err) { this.#failed = err; this.onFailed(err); return false; }
  }

  get failed() { return this.#failed; }

  dispose() { this.#current?.dispose(); this.#current = null; }
}
