// Port of ChangeDetector.cs: decides when the watched region has meaningfully changed and then settled.

/** A small grayscale picture of the watched area, used only for change detection. */
export class GrayFrame {
  constructor(width, height, data) { this.width = width; this.height = height; this.data = data; }

  /** Every pixel is (near) black, as when the shared window is minimised or the content is protected. */
  get isBlack() { return this.data.every((v) => v < 1); }

  /** Area-averaged downsample of RGBA pixels (canvas ImageData) so thin text strokes survive. */
  static fromRgba(rgba, width, height, targetWidth = 160) {
    const step = Math.max(1, Math.trunc(width / targetWidth));
    const w = Math.trunc(width / step);
    const h = Math.trunc(height / step);
    if (w === 0 || h === 0) return new GrayFrame(1, 1, new Float32Array(1));
    const data = new Float32Array(w * h);
    const norm = 1 / (step * step);
    for (let by = 0; by < h; by++) {
      for (let bx = 0; bx < w; bx++) {
        let sum = 0;
        for (let dy = 0; dy < step; dy++) {
          const row = ((by * step + dy) * width + bx * step) * 4;
          for (let dx = 0; dx < step; dx++) {
            const i = row + dx * 4;
            sum += rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114;
          }
        }
        data[by * w + bx] = sum * norm;
      }
    }
    return new GrayFrame(w, h, data);
  }
}

/**
 * Feed it a frame every sample; update() returns true once per change, after the content has stopped moving for settleS
 * (so a message still being typed isn't read half-finished). Blinking cursors and similarly tiny differences are
 * ignored; continuous change (video) fires at most every minIntervalS.
 */
export class ChangeDetector {
  #pixelDelta; #changedFraction; #settleS; #maxWaitS; #minIntervalS;
  #baseline = null; #prev = null; #firstChange = null; #lastMotion = 0; #lastFire = -1e9;

  constructor({ pixelDelta = 24, changedFraction = 0.002, settleS = 1.0, maxWaitS = 8.0, minIntervalS = 3.0 } = {}) {
    this.#pixelDelta = pixelDelta;
    this.#changedFraction = changedFraction;
    this.#settleS = settleS;
    this.#maxWaitS = maxWaitS;
    this.#minIntervalS = minIntervalS;
  }

  /** True while the region differs from the last reported state but hasn't settled. */
  get pending() { return this.#firstChange !== null; }

  reset() { this.#baseline = this.#prev = null; this.#firstChange = null; }

  #differs(a, b) {
    if (a.width !== b.width || a.height !== b.height) return true;
    let changed = 0;
    for (let i = 0; i < a.data.length; i++) if (Math.abs(a.data[i] - b.data[i]) > this.#pixelDelta) changed++;
    return changed / a.data.length > this.#changedFraction;
  }

  /** @param {GrayFrame} frame @param {number} now seconds */
  update(frame, now) {
    if (this.#baseline === null || this.#baseline.width !== frame.width || this.#baseline.height !== frame.height) {
      this.#baseline = this.#prev = frame;
      this.#firstChange = null;
      return false;
    }

    const moved = this.#differs(frame, this.#prev);
    this.#prev = frame;
    if (!this.#differs(frame, this.#baseline)) {
      this.#firstChange = null; // back to what we last reported (or never really changed)
      return false;
    }

    if (this.#firstChange === null) {
      this.#firstChange = now;
      this.#lastMotion = now;
    } else if (moved) {
      this.#lastMotion = now;
    }

    const settled = now - this.#lastMotion >= this.#settleS;
    const tooLong = now - this.#firstChange >= this.#maxWaitS;
    if ((settled || tooLong) && now - this.#lastFire >= this.#minIntervalS) {
      this.#baseline = frame;
      this.#firstChange = null;
      this.#lastFire = now;
      return true;
    }
    return false;
  }
}
