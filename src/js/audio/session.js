// Listening: the tab or screen that is shared (its sound goes to "Them") and the microphone. On a phone there is only the
// microphone, with every sound filter off so that a far-end voice from a speakerphone, or from a second device, is not
// treated as noise. A screen Wake Lock keeps the phone awake, and when the page is hidden or the microphone is cut a
// "paused" notice is shown and listening carries on when the user comes back.
import { Speaker } from '../core/conversation.js';

export const MIC_CONSTRAINTS_PHONE = Object.freeze({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 });
// Beside a shared tab on a computer, the microphone is the user's own voice, so the usual filters stay on.
export const MIC_CONSTRAINTS_DESKTOP = Object.freeze({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 });
export const DISPLAY_AUDIO_CONSTRAINTS = Object.freeze({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });

export const NOTICE = Object.freeze({
  hidden: 'Paused: this page went to the background. Phones stop the microphone for pages you can\'t see. Come back to this page and listening carries on.',
  micCut: 'Paused: the microphone was cut (another app or a call may be using it). Listening carries on when it comes back, or tap Resume.',
  noAudio: 'No sound was shared. In the picker choose a tab and tick “Share tab audio” (Chrome or Edge). A window never includes sound, and a whole screen includes it on Windows only.',
  noMicPermission: 'This page can\'t use the microphone. Allow it in your browser\'s site settings and try again.',
  noMic: 'No microphone was found on this device.',
  noShare: 'This browser can\'t share a screen or tab.',
});

export class ListeningSession {
  #ctx = null; #workletReady = null; #silent = null; #tickTimer = null;
  #display = null; // { stream, video, nodes }
  #mic = null; // { stream, node, ingest }
  #wake = null; #paused = false; #notice = null; #phone;

  /**
   * @param {object} o
   * @param {import('./pipeline.js').AudioPipeline} o.pipeline
   * @param {(notice:string|null)=>void} o.onNotice  a message to show, or null to clear it
   * @param {()=>void} o.onChange  what is being listened to has changed
   * @param {boolean} o.phone  phone mode: microphone only, filters off
   * @param {string} [o.workletUrl]
   * @param {(who:string)=>boolean} [o.useBrowserSpeechFor] sources that use the browser's own speech recognition instead
   */
  constructor({ pipeline, onNotice, onChange, phone, workletUrl = new URL('./worklet.js', import.meta.url).href, doc = globalThis.document, nav = globalThis.navigator }) {
    this.pipeline = pipeline;
    this.onNotice = onNotice;
    this.onChange = onChange;
    this.#phone = phone;
    this.workletUrl = workletUrl;
    this.doc = doc;
    this.nav = nav;
    this.doc?.addEventListener('visibilitychange', () => this.#visibility());
  }

  get hasDisplay() { return this.#display !== null; }
  get hasMic() { return this.#mic !== null; }
  get displayVideo() { return this.#display?.video ?? null; }
  get displayHasAudio() { return Boolean(this.#display?.hasAudio); }
  get paused() { return this.#paused; }
  /** Who the microphone is: on a phone, or with nothing shared, it hears the other side; beside a shared tab it is the user. */
  get micSpeaker() { return this.#phone || !this.hasDisplay ? Speaker.Them : Speaker.Me; }

  async #audioContext() {
    if (!this.#ctx) {
      this.#ctx = new AudioContext({ latencyHint: 'interactive' });
      this.#silent = this.#ctx.createGain();
      this.#silent.gain.value = 0; // nothing is played back: the node only has to be pulled for audio to flow
      this.#silent.connect(this.#ctx.destination);
      this.#workletReady = this.#ctx.audioWorklet.addModule(this.workletUrl);
      this.#tickTimer = setInterval(() => { this.#display?.ingest?.tick(); this.#mic?.ingest?.tick(); }, 100);
    }
    if (this.#ctx.state === 'suspended') await this.#ctx.resume().catch(() => {});
    await this.#workletReady;
    return this.#ctx;
  }

  async #connect(stream, who) {
    const ctx = await this.#audioContext();
    const ingest = this.pipeline.addSource(who, { sampleRate: ctx.sampleRate, channels: 1 });
    const source = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const node = new AudioWorkletNode(ctx, 'cuelight-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    node.port.onmessage = (e) => { if (!this.#paused) ingest.feed(e.data); };
    source.connect(node);
    node.connect(this.#silent);
    return { ingest, source, node };
  }

  // -- the shared tab or screen -------------------------------------------------------------------------------------

  /** Ask the user to pick a tab or screen. Its sound (if shared) goes to "Them"; its picture is for the text area. */
  async startDisplay() {
    if (this.#phone || !this.nav?.mediaDevices?.getDisplayMedia) throw new Error(NOTICE.noShare);
    this.stopDisplay();
    const stream = await this.nav.mediaDevices.getDisplayMedia({ video: true, audio: DISPLAY_AUDIO_CONSTRAINTS });
    const video = this.doc.createElement('video');
    video.className = 'sampler';
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream(stream.getVideoTracks());
    this.doc.body.append(video);
    await video.play().catch(() => {});
    const hasAudio = stream.getAudioTracks().length > 0;
    const entry = { stream, video, hasAudio, ingest: null, nodes: null };
    if (hasAudio) {
      const wired = await this.#connect(stream, Speaker.Them);
      entry.ingest = wired.ingest;
      entry.nodes = wired;
    }
    this.#display = entry;
    stream.getVideoTracks()[0]?.addEventListener('ended', () => { if (this.#display === entry) this.stopDisplay(); });
    this.#notice = hasAudio ? null : NOTICE.noAudio;
    this.onNotice(this.#notice);
    await this.#wakeLock();
    this.onChange();
    return { hasAudio };
  }

  stopDisplay() {
    const d = this.#display;
    if (!d) return;
    this.#display = null;
    d.ingest?.flush();
    d.nodes?.source.disconnect();
    d.nodes?.node.disconnect();
    for (const t of d.stream.getTracks()) t.stop();
    d.video.srcObject = null;
    d.video.remove();
    if (this.#notice === NOTICE.noAudio) this.onNotice(null);
    this.#releaseWakeLockIfIdle();
    this.onChange();
  }

  // -- the microphone -----------------------------------------------------------------------------------------------

  /** @param {{viaBrowserSpeech?:boolean}} [o] with viaBrowserSpeech the browser's own recognizer opens the microphone, so
   *  this only keeps the screen awake and no audio is sent to the on-device speech model */
  async startMic({ viaBrowserSpeech = false } = {}) {
    if (this.#mic) return;
    if (viaBrowserSpeech) {
      const none = { getTracks: () => [], getAudioTracks: () => [] };
      this.#mic = { stream: none, ingest: { flush() {}, tick() {} }, source: { disconnect() {} }, node: { disconnect() {} }, who: this.micSpeaker, external: true };
      this.#setNotice(null);
      await this.#wakeLock();
      this.onChange();
      return;
    }
    if (!this.nav?.mediaDevices?.getUserMedia) throw new Error('This browser can\'t use the microphone.');
    let stream;
    try {
      stream = await this.nav.mediaDevices.getUserMedia({ audio: this.#phone ? MIC_CONSTRAINTS_PHONE : MIC_CONSTRAINTS_DESKTOP });
    } catch (err) {
      if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') throw new Error(NOTICE.noMic);
      throw new Error(NOTICE.noMicPermission);
    }
    const who = this.micSpeaker;
    const wired = await this.#connect(stream, who);
    const entry = { stream, ...wired, who };
    this.#mic = entry;
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('mute', () => { if (this.#mic === entry) this.#setNotice(NOTICE.micCut); });
      track.addEventListener('unmute', () => { if (this.#mic === entry) this.#setNotice(null); });
      track.addEventListener('ended', () => { if (this.#mic === entry) { this.#dropMic(); this.#setNotice(NOTICE.micCut); this.onChange(); } });
    }
    this.#setNotice(null);
    await this.#wakeLock();
    this.onChange();
  }

  #dropMic() {
    const m = this.#mic;
    if (!m) return;
    this.#mic = null;
    m.ingest.flush();
    m.source.disconnect();
    m.node.disconnect();
    for (const t of m.stream.getTracks()) t.stop();
  }

  stopMic() {
    if (!this.#mic) return;
    this.#dropMic();
    this.#releaseWakeLockIfIdle();
    this.onChange();
  }

  // -- pausing -----------------------------------------------------------------------------------------------------

  /** Recording off: the microphone is released (the indicator goes out) and nothing is fed to the speech model. */
  pause() {
    this.#paused = true;
    this.#display?.ingest?.flush();
    this.#mic?.ingest.flush();
    this.#dropMic();
    this.#releaseWakeLockIfIdle();
    this.onChange();
  }

  async resume({ wantMic, viaBrowserSpeech = false }) {
    this.#paused = false;
    if (wantMic && !this.#mic) await this.startMic({ viaBrowserSpeech });
    else await this.#wakeLock();
    this.onChange();
  }

  stopAll() {
    this.stopDisplay();
    this.stopMic();
    this.#paused = false;
    this.#setNotice(null);
  }

  // -- keeping the phone awake and noticing interruptions ---------------------------------------------------------

  #setNotice(notice) {
    this.#notice = notice;
    this.onNotice(notice);
  }

  async #wakeLock() {
    if (!this.nav?.wakeLock?.request || this.#wake || this.doc?.visibilityState === 'hidden') return;
    try {
      const sentinel = await this.nav.wakeLock.request('screen');
      this.#wake = sentinel;
      sentinel.addEventListener('release', () => { if (this.#wake === sentinel) this.#wake = null; });
    } catch { /* not allowed right now (low battery, background): listening still works */ }
  }

  #releaseWakeLockIfIdle() {
    if (this.hasMic || this.hasDisplay) return;
    const w = this.#wake;
    this.#wake = null;
    w?.release().catch(() => {});
  }

  async #visibility() {
    if (!this.hasMic && !this.hasDisplay && !this.#notice) return;
    if (this.doc.visibilityState === 'hidden') {
      if (this.hasMic) this.#setNotice(NOTICE.hidden);
      return;
    }
    // Back on the page: the Wake Lock is released whenever the page is hidden, so ask for it again.
    this.#wake = null;
    await this.#wakeLock();
    if (this.#notice === NOTICE.hidden || this.#notice === NOTICE.micCut) {
      const live = this.#mic?.stream.getAudioTracks().some((t) => t.readyState === 'live' && !t.muted);
      if (live || this.hasDisplay) this.#setNotice(null);
      else if (!this.#paused) {
        try { await this.startMic({ viaBrowserSpeech: Boolean(this.#mic?.external) }); } catch { this.#setNotice(NOTICE.micCut); }
      }
    }
  }

  get notice() { return this.#notice; }

  dispose() {
    this.stopAll();
    clearInterval(this.#tickTimer);
    this.#ctx?.close().catch(() => {});
    this.#ctx = null;
  }
}
