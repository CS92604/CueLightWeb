// Port of AudioPipeline (Audio.cs): transcribes utterances one at a time and feeds them to the engine.
//
// It also keeps a live preview: while someone is speaking, the speech so far is run through the speech model's quick
// preview pass again and again (whenever the speech model has nothing more important to do) and handed to the engine as
// setLive, so the words show up as they are said. The newest snapshot wins, a finished utterance always goes first, and
// the preview is replaced by the real transcript when that is ready.
import { AudioIngest } from './ingest.js';
import { cleanTranscript } from '../stt/clean.js';

/** Shown when speech arrives faster than this device can transcribe it and the oldest is skipped. */
export const FALLING_BEHIND =
  "Speech recognition can't keep up on this device, so some speech was skipped. Choose Fast under Settings, Speech recognition.";

const QUEUE_LIMIT = 8;
const REST_AFTER_PASS = 0.33;

export class AudioPipeline {
  #engine; #transcriber; #now; #queue = []; #partials = new Map(); #speaking = new Set();
  #previewAbort = null; #allowedAfter = 0; #lastBehindNotice = -Infinity; #stopped = false;
  #signalled = false; #wake = null; #loop = null; #timer = null;

  /**
   * @param {object} o
   * @param {import('../engine.js').Engine} o.engine
   * @param {Promise<{transcribe:(a:Float32Array,s:AbortSignal)=>Promise<string>, preview?:(a:Float32Array,s:AbortSignal)=>Promise<string>}>} o.transcriber
   * @param {()=>number} [o.now] milliseconds
   * @param {number} [o.previewMinGapMs] the least rest between two preview passes
   * @param {number} [o.previewMaxSeconds] only the newest this much speech is previewed (the final transcript has it all)
   */
  constructor({ engine, transcriber, now = () => Date.now(), previewMinGapMs = 40, previewMaxSeconds = 12 }) {
    this.#engine = engine;
    this.#transcriber = transcriber;
    this.#now = now;
    this.previewMinGapMs = previewMinGapMs;
    this.previewMaxSeconds = previewMaxSeconds;
  }

  /** Attach one device for `who`: returns the AudioIngest to feed with that device's audio. */
  addSource(who, { sampleRate, channels = 1, clock, segmenter } = {}) {
    return new AudioIngest({
      sampleRate, channels, clock, segmenter,
      onUtterance: (audio) => this.utterance(who, audio),
      onPartial: (audio) => this.partial(who, audio),
      onSpeaking: (on) => this.speaking(who, on),
    });
  }

  utterance(who, audio) {
    this.#queue.push({ who, audio });
    if (this.#queue.length > QUEUE_LIMIT) { // the queue overflowed: transcription is slower than real time
      this.#queue.shift();
      this.#noteDropped();
    }
    this.#previewAbort?.abort(); // a finished utterance goes before any preview
    this.#poke();
  }

  speaking(who, on) {
    if (on) this.#speaking.add(who);
    else { this.#speaking.delete(who); this.#partials.delete(who); }
    this.#engine.setSpeaking(who, on);
    if (on) this.#engine.setLive(who, null); // new speech: whatever preview was showing is old
  }

  partial(who, audio) {
    if (!this.#speaking.has(who)) return;
    this.#partials.set(who, audio);
    this.#poke();
  }

  #noteDropped() {
    // At most once a minute.
    const now = this.#now();
    if (now - this.#lastBehindNotice < 60_000) return;
    this.#lastBehindNotice = now;
    this.#engine.raiseError(FALLING_BEHIND);
  }

  start() { this.#loop ??= this.#run(); }

  #poke() {
    this.#signalled = true;
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  #wait() {
    if (this.#signalled) { this.#signalled = false; return Promise.resolve(); }
    return new Promise((resolve) => { this.#wake = () => { this.#signalled = false; resolve(); }; });
  }

  async #run() {
    let stt;
    try { stt = await this.#transcriber; }
    catch (err) { if (!this.#stopped) this.#engine.raiseError(`Couldn't load the speech model: ${err?.message ?? err}`); return; }

    while (!this.#stopped) {
      await this.#wait();
      if (this.#stopped) return;
      while (this.#queue.length > 0 && !this.#stopped) {
        const item = this.#queue.shift();
        await this.#transcribe(stt, item.who, item.audio);
      }
      await this.#preview(stt);
    }
  }

  async #transcribe(stt, who, audio) {
    try {
      const text = cleanTranscript(await stt.transcribe(audio, new AbortController().signal));
      if (this.#stopped) return;
      if (text.length > 0) this.#engine.addTurn(who, text);
      // The preview was only ever a stand-in for this: it goes now, unless new speech has begun since.
      if (!this.#speaking.has(who)) this.#engine.setLive(who, null);
    } catch (err) {
      if (!this.#stopped) this.#engine.raiseError(`Transcription failed: ${err?.message ?? err}`);
    }
  }

  /** One live preview pass, if someone is speaking and the speech model has had a rest. */
  async #preview(stt) {
    if (this.#partials.size === 0) return;
    const now = this.#now();
    if (now < this.#allowedAfter) { // too soon after the last pass: keep it, try again then
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => this.#poke(), this.#allowedAfter - now + 5);
      return;
    }
    const [who, full] = this.#partials.entries().next().value;
    this.#partials.delete(who);
    const maxSamples = Math.trunc(this.previewMaxSeconds * 16000);
    const audio = full.length > maxSamples ? full.subarray(full.length - maxSamples) : full;
    const abort = this.#previewAbort = new AbortController();

    const started = this.#now();
    let text;
    try {
      text = cleanTranscript(await (stt.preview ?? stt.transcribe).call(stt, audio, abort.signal));
    } catch { return; } // a preview is a nicety; the real transcription reports real problems
    finally { this.#previewAbort = null; }
    if (abort.signal.aborted || this.#stopped) return; // a finished utterance came in; it goes first

    const rest = (this.#now() - started) * REST_AFTER_PASS;
    this.#allowedAfter = this.#now() + Math.max(rest, this.previewMinGapMs);
    if (text.length > 0 && this.#speaking.has(who)) this.#engine.setLive(who, text);
  }

  dispose() {
    this.#stopped = true;
    this.#previewAbort?.abort();
    clearTimeout(this.#timer);
    this.#poke();
  }
}
