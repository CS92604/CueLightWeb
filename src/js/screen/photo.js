// A photo for the TYPE reply: from the camera or the library (<input type="file" accept="image/*">). It is decoded, turned
// upright as its orientation says, scaled so the long edge is at most ~1568 px, and drawn again on a canvas, then encoded
// as PNG or JPEG. Only the pixels get through: camera details and location (EXIF) are gone.
import { drawScaled, encodeCanvas } from './imaging.js';

export const MAX_PHOTO_BYTES = 40 * 1024 * 1024;

export async function preparePhoto(file) {
  if (!file || !/^image\//.test(file.type || 'image/unknown') && file.type) throw new Error('That file isn\'t a picture.');
  if (file.size > MAX_PHOTO_BYTES) throw new Error('That picture is too large. Try a smaller one.');
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This browser couldn\'t open that picture (some phones save HEIC, which only Safari reads). Take the photo again as a JPEG, or use another browser.');
  }
  try {
    const canvas = drawScaled(bitmap, { left: 0, top: 0, width: bitmap.width, height: bitmap.height });
    return await encodeCanvas(canvas);
  } finally {
    bitmap.close?.();
  }
}
