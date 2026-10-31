// Makes the test media: a speech-like WAV for the fake microphone, and a JPEG photo carrying real EXIF data.
import fs from 'node:fs';

/** A looping 48 kHz mono WAV: a second and a half of a wobbling tone (loud enough to count as speech), then quiet. */
export function writeSpeechWav(file, { rate = 48000, voiced = 1.5, quiet = 2.5 } = {}) {
  const n = Math.round(rate * (voiced + quiet));
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const v = t < voiced ? 0.35 * Math.sin(2 * Math.PI * (180 + 40 * Math.sin(2 * Math.PI * 3 * t)) * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) : 0;
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, pcm]));
}

/** An EXIF APP1 segment with orientation 6 (the picture must be turned) and a GPS block with a recognisable latitude. */
export function exifSegment({ orientation = 6 } = {}) {
  const tiff = Buffer.alloc(8 + 2 + 12 * 2 + 4 + 2 + 12 + 4 + 16);
  let o = 0;
  tiff.write('II', o); o += 2; tiff.writeUInt16LE(42, o); o += 2; tiff.writeUInt32LE(8, o); o += 4;
  const ifd0 = o;
  tiff.writeUInt16LE(2, o); o += 2;
  tiff.writeUInt16LE(0x0112, o); tiff.writeUInt16LE(3, o + 2); tiff.writeUInt32LE(1, o + 4); tiff.writeUInt16LE(orientation, o + 8); o += 12; // Orientation
  const gpsPointerAt = o;
  tiff.writeUInt16LE(0x8825, o); tiff.writeUInt16LE(4, o + 2); tiff.writeUInt32LE(1, o + 4); o += 12; // pointer to the GPS IFD
  tiff.writeUInt32LE(0, o); o += 4; // no next IFD
  tiff.writeUInt32LE(o, gpsPointerAt + 8);
  tiff.writeUInt16LE(1, o); o += 2; // GPS IFD: one entry, GPSLatitudeRef = "N"
  tiff.writeUInt16LE(0x0001, o); tiff.writeUInt16LE(2, o + 2); tiff.writeUInt32LE(2, o + 4); tiff.write('N\0', o + 8); o += 12;
  tiff.writeUInt32LE(0, o); o += 4;
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff.subarray(0, o), Buffer.from('GPSLatitude=51.5007;GPSLongitude=-0.1246;Make=SecretPhoneCo', 'ascii')]);
  const seg = Buffer.alloc(4);
  seg.writeUInt16BE(0xffe1, 0); seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([seg, payload]);
}

/** Puts an EXIF segment right after the JPEG's start-of-image marker. */
export function withExif(jpeg, opts) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG');
  return Buffer.concat([jpeg.subarray(0, 2), exifSegment(opts), jpeg.subarray(2)]);
}

/** Width and height of a PNG or JPEG, from its header; null if neither. */
export function imageSize(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return { type: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      const len = bytes.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: 'jpeg', height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}
