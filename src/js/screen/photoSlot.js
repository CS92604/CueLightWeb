// A single slot for the photo that goes with the next reply. A new photo replaces the old one; nothing old is ever kept
// or sent again, and the picture is dropped from memory once it has been used.

/** The size an image is scaled to so that its long edge is at most `max` (never enlarged). */
export function fitWithin(width, height, max = 1568) {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const scale = max / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export class PhotoSlot {
  #photo = null;
  /** Called when the photo is dropped after use (not when it is replaced). */
  onReleased = null;

  get has() { return this.#photo !== null; }

  /** @param {{mediaType:string,data:string}} photo the newest photo; whatever was held before is let go */
  set(photo) { this.#photo = photo ? { mediaType: photo.mediaType, data: photo.data } : null; }

  /** The photo, for the one request that sends it. */
  peek() { return this.#photo; }

  /** Drop it from memory. */
  release() {
    const had = this.#photo !== null;
    this.#photo = null;
    if (had) this.onReleased?.();
  }

  clear() { this.#photo = null; }
}
