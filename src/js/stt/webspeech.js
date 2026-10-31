// Optional: the browser's built-in speech recognition. It is NOT on-device: Chrome and Edge send the audio to Google's or
// Microsoft's servers, Safari to Apple's. It is off unless the user turns it on, and it only listens to the microphone.
import { hasBrowserSpeech } from '../device.js';

export const WEB_SPEECH_WARNING = 'Sends your audio to Google or Apple to be turned into words. Off keeps it on this device.';

export class BrowserSpeech {
  #rec = null; #running = false; #restarts = 0;

  /** @param {{engine:import('../engine.js').Engine, who:string, lang?:string, onError?:(m:string)=>void, g?:object}} o */
  constructor({ engine, who, lang = globalThis.navigator?.language ?? 'en-US', onError = () => {}, g = globalThis }) {
    this.engine = engine; this.who = who; this.lang = lang; this.onError = onError; this.g = g;
  }

  static supported(g = globalThis) { return hasBrowserSpeech(g); }

  start() {
    if (this.#running) return;
    const Ctor = this.g.SpeechRecognition || this.g.webkitSpeechRecognition;
    if (!Ctor) { this.onError('This browser has no built-in speech recognition.'); return; }
    this.#running = true;
    const rec = this.#rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.lang;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0]?.transcript ?? '';
        if (r.isFinal) { this.engine.addTurn(this.who, text); this.engine.setLive(this.who, null); }
        else interim += text;
      }
      if (interim) { this.engine.setSpeaking(this.who, true); this.engine.setLive(this.who, interim); }
      else this.engine.setSpeaking(this.who, false);
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return; // normal: it simply heard nothing
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { this.#running = false; this.onError('The browser\'s speech recognition isn\'t allowed here. Allow the microphone, or turn this setting off to use on-device recognition.'); return; }
      if (e.error === 'network') { this.onError('The browser\'s speech recognition couldn\'t reach its service. Check your connection, or turn this setting off to use on-device recognition.'); return; }
      this.onError(`The browser's speech recognition stopped (${e.error}).`);
    };
    rec.onend = () => { // browsers end a session after some quiet; keep it going while listening
      this.engine.setSpeaking(this.who, false);
      if (this.#running && this.#restarts++ < 1000) { try { rec.start(); } catch { /* already starting */ } }
    };
    try { rec.start(); } catch (err) { this.#running = false; this.onError(String(err?.message ?? err)); }
  }

  stop() {
    this.#running = false;
    try { this.#rec?.stop(); } catch { /* not started */ }
    this.#rec = null;
    this.engine.setSpeaking(this.who, false);
    this.engine.setLive(this.who, null);
  }
}
