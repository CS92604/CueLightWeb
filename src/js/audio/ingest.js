// Port of AudioIngest (Audio.cs): raw device audio in, utterances out. Downmix + resample to 16 kHz, then voice-activity
// split, and a schedule of "preview" snapshots of the speech so far (so the words can show before the sentence is over).
import { Segmenter, StreamResampler } from '../core/segmenter.js';

// Voiced 30 ms frames of new speech needed before the next preview, and how much quiet after speech counts as the start
// of a pause (a last look, so the final words show before the finished transcript is ready).
const FIRST_PARTIAL_FRAMES = 10;
const PARTIAL_FRAMES = 7;
const PAUSE_LOOK_FRAMES = 5;

export class AudioIngest {
  #resampler; #segmenter; #clock; #lastData; #voicedAtLastPartial = 0; #framesForNextPartial = FIRST_PARTIAL_FRAMES;

  /** @param {{sampleRate:number, channels?:number, onUtterance:(a:Float32Array)=>void, onPartial?:(a:Float32Array)=>void,
   *   onSpeaking?:(on:boolean)=>void, clock?:()=>number, segmenter?:object}} o  clock returns seconds */
  constructor({ sampleRate, channels = 1, onUtterance, onPartial = () => {}, onSpeaking = () => {}, clock = () => performance.now() / 1000, segmenter = {} }) {
    this.#segmenter = new Segmenter(segmenter);
    this.#segmenter.onSpeakingChanged = onSpeaking;
    this.#resampler = new StreamResampler(sampleRate, channels);
    this.onUtterance = onUtterance;
    this.onPartial = onPartial;
    this.#clock = clock;
    this.#lastData = clock();
  }

  get isSpeaking() { return this.#segmenter.isSpeaking; }

  /** @param {Float32Array} interleaved */
  feed(interleaved) {
    this.#lastData = this.#clock();
    this.#push(this.#resampler.process(interleaved));
  }

  /** Call every ~100 ms. If the device has gone quiet, feed silence so speech can end. */
  tick() {
    if (this.#clock() - this.#lastData < 0.25) return;
    this.#push(new Float32Array(1600)); // 100 ms of silence at 16 kHz
  }

  /** Whatever speech is buffered (call at shutdown or when recording stops). */
  flush() {
    const tail = this.#segmenter.flush();
    if (tail) this.onUtterance(tail);
  }

  #push(mono16k) {
    for (const utt of this.#segmenter.feed(mono16k)) this.onUtterance(utt);

    if (!this.#segmenter.isSpeaking) {
      this.#voicedAtLastPartial = 0;
      this.#framesForNextPartial = FIRST_PARTIAL_FRAMES;
      return;
    }
    // Counting frames of real voice (not time) means a trailing pause never triggers another preview of the same words.
    const voiced = this.#segmenter.voicedFrames;
    if (voiced < this.#voicedAtLastPartial) this.#voicedAtLastPartial = 0; // a new sentence began inside this chunk
    const fresh = voiced - this.#voicedAtLastPartial;
    const pauseBegan = fresh > 0 && this.#segmenter.trailingSilenceFrames >= PAUSE_LOOK_FRAMES;
    if (fresh < this.#framesForNextPartial && !pauseBegan) return;
    this.#voicedAtLastPartial = voiced;
    this.#framesForNextPartial = PARTIAL_FRAMES;
    const speech = this.#segmenter.snapshotSpeech();
    if (speech) this.onPartial(speech);
  }
}
