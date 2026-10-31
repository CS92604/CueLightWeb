// What the engine uses to get the picture that goes with a request: a rectangle of the shared screen, or the photo.

/**
 * @param {{video:()=>import('./videoSource.js').VideoRegionSource|null, photo:import('./photoSlot.js').PhotoSlot}} o
 */
export function makeCapture({ video, photo }) {
  return {
    async capture(region) {
      if (region?.kind === 'photo') return photo.peek();
      const v = video();
      if (!v) throw new Error('nothing is being shared');
      return v.capture(region);
    },
    async grab(region) {
      const v = video();
      if (!v || region?.kind === 'photo') throw new Error('nothing to read');
      return v.grab(region);
    },
    /** The picture was used: a photo is dropped from memory (the newest replaces it, and nothing old is ever resent). */
    release(region) { if (region?.kind === 'photo') photo.release(); },
  };
}
