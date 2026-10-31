// A photo for the TYPE reply: from the camera or the library (<input type="file" accept="image/*">). It is decoded, turned
// upright as its orientation says, scaled so the long edge is at most ~1568 px, and drawn again on a canvas, then encoded
// as PNG or JPEG. Only the pixels get through: camera details and location (EXIF) are gone.
import { drawScaled, encodeCanvas } from './imaging.js';

export const MAX_PHOTO_BYTES = 40 * 1024 * 1024;

/** Decodes a picture file, turned upright as its orientation says. Older browsers don't know the options of
 *  createImageBitmap, so there are two fallbacks: without options, and through an <img> element. */
async function decode(file) {
  try { return { source: await createImageBitmap(file, { imageOrientation: 'from-image' }), done(s) { s.close?.(); } }; } catch { /* try the next way */ }
  try { return { source: await createImageBitmap(file), done(s) { s.close?.(); } }; } catch { /* try the next way */ }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch (err) { URL.revokeObjectURL(url); throw err; }
  return { source: img, done() { URL.revokeObjectURL(url); } };
}

export async function preparePhoto(file) {
  if (!file) throw new Error('No picture was chosen.');
  if (file.type && !file.type.startsWith('image/')) throw new Error('That file isn\'t a picture.');
  if (file.size > MAX_PHOTO_BYTES) throw new Error('That picture is too large. Try a smaller one.');
  let decoded;
  try {
    decoded = await decode(file);
  } catch {
    throw new Error('This browser couldn\'t open that picture (some phones save HEIC, which only Safari reads). Take the photo again as a JPEG, or use another browser.');
  }
  const { source } = decoded;
  try {
    const width = source.naturalWidth ?? source.width;
    const height = source.naturalHeight ?? source.height;
    return await encodeCanvas(drawScaled(source, { left: 0, top: 0, width, height }));
  } finally {
    decoded.done(source);
  }
}
