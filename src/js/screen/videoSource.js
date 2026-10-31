// Pictures of a rectangle of the shared screen, read from the (hidden) video the share is playing into.
import { GrayFrame } from '../core/changeDetector.js';
import { drawScaled, encodeCanvas } from './imaging.js';

export class VideoRegionSource {
  #sampler = null;
  constructor(video) { this.video = video; }

  get size() { return { width: this.video.videoWidth, height: this.video.videoHeight }; }

  #check(region) {
    const { width, height } = this.size;
    if (!width || !height) throw new Error('the shared picture isn\'t ready');
    const left = Math.min(Math.max(0, region.left), width - 1);
    const top = Math.min(Math.max(0, region.top), height - 1);
    return { left, top, width: Math.min(region.width, width - left), height: Math.min(region.height, height - top) };
  }

  /** A small grayscale picture for change detection. */
  frameGray(region) {
    const crop = this.#check(region);
    this.#sampler ??= document.createElement('canvas');
    const w = Math.min(crop.width, 640);
    const h = Math.max(1, Math.round(crop.height * (w / crop.width)));
    this.#sampler.width = w; this.#sampler.height = h;
    const ctx = this.#sampler.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.video, crop.left, crop.top, crop.width, crop.height, 0, 0, w, h);
    return GrayFrame.fromRgba(ctx.getImageData(0, 0, w, h).data, w, h);
  }

  /** The region as it is right now, as a picture to send (long edge at most 1568). */
  async capture(region) {
    const { mediaType, data } = await encodeCanvas(drawScaled(this.video, this.#check(region)));
    return { mediaType, data };
  }

  /** The region as a canvas, for reading its words on this device. Small text is enlarged first: it reads better. */
  async grab(region) {
    const crop = this.#check(region);
    const canvas = drawScaled(this.video, crop, 2400, crop.height < 300 ? 2 : 1);
    return { width: canvas.width, height: canvas.height, canvas };
  }

  /** A still of the whole shared picture, for choosing the region on. */
  still() {
    const { width, height } = this.size;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d', { alpha: false }).drawImage(this.video, 0, 0, width, height);
    return canvas;
  }
}
