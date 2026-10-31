// Picture helpers shared by the shared-screen text area and the photo upload. Everything here re-draws the picture on a
// canvas and encodes that, which is what strips EXIF data (camera, location) from a photo: only the pixels survive.
import { fitWithin } from './photoSlot.js';

/** Largest picture, in bytes of base64, kept as PNG; anything bigger is re-encoded as JPEG. */
const PNG_LIMIT = 1_500_000;

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const blobOf = (canvas, type, quality) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be encoded'))), type, quality));

/** @returns {Promise<{mediaType:string,data:string,width:number,height:number}>} PNG (text stays crisp), or JPEG when PNG is big. */
export async function encodeCanvas(canvas) {
  let blob = await blobOf(canvas, 'image/png');
  if (blob.size > PNG_LIMIT) blob = await blobOf(canvas, 'image/jpeg', 0.85);
  return { mediaType: blob.type, data: toBase64(new Uint8Array(await blob.arrayBuffer())), width: canvas.width, height: canvas.height };
}

/** Draw part of a source (video, bitmap or canvas) scaled so the long edge is at most max (`enlarge` first makes it bigger). */
export function drawScaled(source, crop, max = 1568, enlarge = 1) {
  const { width, height } = fitWithin(Math.round(crop.width * enlarge), Math.round(crop.height * enlarge), max);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, crop.left, crop.top, crop.width, crop.height, 0, 0, width, height);
  return canvas;
}
