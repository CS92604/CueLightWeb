// Port of Segmenter.cs: an energy-based voice activity detector that cuts a mono 16 kHz stream into utterances, and the
// streaming resampler that brings the browser's audio down to 16 kHz.

/** Cuts a mono 16 kHz stream into utterances. Feed it chunks of any size; finished utterances come back as Float32Arrays. */
export class Segmenter {
  #frame; #frameMs; #silenceFrames; #minSpeechFrames; #maxFrames; #minRms; #noiseFactor; #prerollFrames;
  #preroll = [];
  #pending = new Float32Array(0);
  #active = [];
  #noise = 0;
  #speech = 0;
  #silence = 0;
  #wasSpeaking = false;

  /** Called with true/false when isSpeaking changes. Runs inside feed()/flush(). */
  onSpeakingChanged = null;

  constructor({ sampleRate = 16000, frameMs = 30, silenceMs = 700, minSpeechMs = 300, maxUtteranceS = 25,
    prerollMs = 240, minRms = 0.008, noiseFactor = 3 } = {}) {
    this.#frame = Math.trunc(sampleRate * frameMs / 1000);
    this.#frameMs = frameMs;
    this.#silenceFrames = Math.max(1, Math.trunc(silenceMs / frameMs));
    this.#minSpeechFrames = Math.max(1, Math.trunc(minSpeechMs / frameMs));
    this.#maxFrames = Math.trunc(maxUtteranceS * 1000 / frameMs);
    this.#prerollFrames = Math.max(1, Math.trunc(prerollMs / frameMs));
    this.#minRms = minRms;
    this.#noiseFactor = noiseFactor;
  }

  /** True once enough speech has been heard to be worth transcribing (a click or a cough shorter than that never
   *  counts), until the pause that ends it. A short pause between words doesn't end it. */
  get isSpeaking() { return this.#active.length > 0 && this.#speech >= this.#minSpeechFrames; }

  /** How many 30 ms stretches of actual voice the speech in progress has had so far (pauses don't count). */
  get voicedFrames() { return this.#active.length > 0 ? this.#speech : 0; }

  /** How many 30 ms stretches of quiet there have been since the last voice (0 while nobody is speaking). */
  get trailingSilenceFrames() { return this.#active.length > 0 ? this.#silence : 0; }

  /** The audio of the speech in progress (everything since it began, at most the latest maxSeconds), for a live
   *  preview. Null when nobody is speaking. */
  snapshotSpeech(maxSeconds = 25) {
    if (!this.isSpeaking) return null;
    const keep = Math.max(1, Math.trunc(maxSeconds * 1000 / this.#frameMs));
    const skip = Math.max(0, this.#active.length - keep);
    const result = new Float32Array((this.#active.length - skip) * this.#frame);
    let pos = 0;
    for (let i = skip; i < this.#active.length; i++) { result.set(this.#active[i], pos); pos += this.#frame; }
    return result;
  }

  #notifySpeaking() {
    const now = this.isSpeaking;
    if (now === this.#wasSpeaking) return;
    this.#wasSpeaking = now;
    this.onSpeakingChanged?.(now);
  }

  /** @param {Float32Array} samples @returns {Float32Array[]} finished utterances */
  feed(samples) {
    const output = [];
    let buf = samples;
    if (this.#pending.length > 0) {
      buf = new Float32Array(this.#pending.length + samples.length);
      buf.set(this.#pending, 0);
      buf.set(samples, this.#pending.length);
    }
    const frames = Math.trunc(buf.length / this.#frame);
    for (let i = 0; i < frames; i++) {
      const frame = buf.slice(i * this.#frame, (i + 1) * this.#frame); // a copy: frames are kept
      const utt = this.#step(frame);
      if (utt) output.push(utt);
    }
    this.#pending = buf.slice(frames * this.#frame);
    return output;
  }

  /** Whatever speech is buffered (call at shutdown). */
  flush() {
    let utt = null;
    if (this.#active.length > 0 && this.#speech >= this.#minSpeechFrames) utt = concat(this.#active);
    this.#reset();
    this.#notifySpeaking();
    return utt;
  }

  #reset() {
    this.#active = [];
    this.#speech = this.#silence = 0;
  }

  #step(frame) {
    const utterance = this.#stepCore(frame);
    this.#notifySpeaking();
    return utterance;
  }

  #stepCore(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    const threshold = Math.max(this.#minRms, this.#noise * this.#noiseFactor);
    const speaking = rms > threshold;

    if (this.#active.length === 0) {
      if (speaking) {
        this.#active.push(...this.#preroll);
        this.#preroll = [];
        this.#active.push(frame);
        this.#speech = 1;
        this.#silence = 0;
      } else {
        // Track the noise floor only while nobody is talking.
        this.#noise = this.#noise === 0 ? rms : 0.95 * this.#noise + 0.05 * rms;
        this.#preroll.push(frame);
        while (this.#preroll.length > this.#prerollFrames) this.#preroll.shift();
      }
      return null;
    }

    this.#active.push(frame);
    if (speaking) { this.#speech++; this.#silence = 0; } else this.#silence++;
    if (this.#silence >= this.#silenceFrames || this.#active.length >= this.#maxFrames) {
      const utt = this.#speech >= this.#minSpeechFrames ? concat(this.#active) : null;
      this.#reset();
      return utt;
    }
    return null;
  }
}

function concat(frames) {
  let n = 0;
  for (const f of frames) n += f.length;
  const result = new Float32Array(n);
  let pos = 0;
  for (const f of frames) { result.set(f, pos); pos += f.length; }
  return result;
}

/** Streaming downmix + resample of interleaved audio to mono 16 kHz (area averaging). */
export class StreamResampler {
  #channels; #ratio; #buffer = []; #pos = 0;

  constructor(inputRate, channels = 1, outputRate = 16000) {
    this.#channels = Math.max(1, channels);
    this.#ratio = inputRate / outputRate; // input samples per output sample
  }

  /** @param {Float32Array} interleaved @returns {Float32Array} */
  process(interleaved) {
    const ch = this.#channels;
    for (let i = 0; i + ch <= interleaved.length; i += ch) {
      let sum = 0;
      for (let c = 0; c < ch; c++) sum += interleaved[i + c];
      this.#buffer.push(sum / ch);
    }

    const output = [];
    while (this.#pos + this.#ratio <= this.#buffer.length) {
      // Average the input interval [pos, pos + ratio), weighting partial samples at the edges.
      const start = this.#pos;
      const end = this.#pos + this.#ratio;
      let acc = 0;
      for (let i = Math.trunc(start); i < Math.ceil(end) && i < this.#buffer.length; i++) {
        const w = Math.min(i + 1, end) - Math.max(i, start);
        acc += this.#buffer[i] * w;
      }
      output.push(acc / this.#ratio);
      this.#pos += this.#ratio;
    }

    const consumed = Math.trunc(this.#pos);
    if (consumed > 0) {
      this.#buffer.splice(0, Math.min(consumed, this.#buffer.length));
      this.#pos -= consumed;
    }
    return Float32Array.from(output);
  }
}
