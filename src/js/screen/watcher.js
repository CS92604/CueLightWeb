// Port of ScreenWatcher (Services.cs): samples a region on a timer and calls onChange when it has changed and settled.
//
// Sampling can fail for a while without anything being wrong: the shared window is minimised, or the tab is switched. So a
// failed sample is retried on the next tick. Only after several in a row is it reported once, and when sampling works
// again onRecovered says so. Blank (all black) frames, which a hidden or protected surface produces instead of an error,
// are skipped.
import { ChangeDetector } from '../core/changeDetector.js';

export class RegionWatcher {
  #detector = new ChangeDetector(); #timer = null; #failures = 0; #reported = false; #t0 = performance.now();

  /**
   * @param {object} o
   * @param {()=>import('../core/changeDetector.js').GrayFrame} o.sample  throws when the picture can't be read
   * @param {()=>void} o.onChange
   * @param {(message:string)=>void} o.onError
   * @param {()=>void} [o.onRecovered]
   */
  constructor({ sample, onChange, onError, onRecovered = () => {}, intervalMs = 500, failuresBeforeError = 6, clock = () => performance.now() / 1000 }) {
    this.sample = sample; this.onChange = onChange; this.onError = onError; this.onRecovered = onRecovered;
    this.intervalMs = intervalMs; this.failuresBeforeError = Math.max(1, failuresBeforeError); this.clock = clock;
  }

  get pending() { return this.#detector.pending; }

  start() { this.#timer ??= setInterval(() => this.tick(), this.intervalMs); }

  tick() {
    let frame = null;
    try {
      frame = this.sample();
      if (frame?.isBlack) frame = null; // hidden or protected content: nothing to compare
    } catch (err) {
      if (++this.#failures === this.failuresBeforeError) {
        this.#reported = true;
        this.onError(`Can't read the text area right now (${err?.message ?? err}). Still trying.`);
      }
      return;
    }
    if (this.#failures > 0) {
      this.#failures = 0;
      if (this.#reported) { this.#reported = false; this.onRecovered(); }
    }
    if (frame && this.#detector.update(frame, this.clock())) this.onChange();
  }

  dispose() { clearInterval(this.#timer); this.#timer = null; }
}
