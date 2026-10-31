// Port of Region.cs (the drag-to-rectangle part) for pictures of the shared screen, in the video's own pixels.

/**
 * Turn a drag on a still picture into a rectangle in the picture's own pixels.
 * p0 and p1 are where the drag started and ended, in CSS pixels on the picture; `scale` is picture pixels per CSS pixel.
 * Returns null for drags smaller than minSize (stray clicks). The result is clipped to the picture.
 */
export function dragToRegion(p0, p1, scale, size, minSize = 16) {
  const x0 = Math.min(p0.x, p1.x), x1 = Math.max(p0.x, p1.x);
  const y0 = Math.min(p0.y, p1.y), y1 = Math.max(p0.y, p1.y);
  let left = Math.round(x0 * scale.x), top = Math.round(y0 * scale.y);
  let right = Math.round(x1 * scale.x), bottom = Math.round(y1 * scale.y);
  if (size) { left = Math.max(0, left); top = Math.max(0, top); right = Math.min(size.width, right); bottom = Math.min(size.height, bottom); }
  const r = { kind: 'region', left, top, width: right - left, height: bottom - top };
  return r.width >= minSize && r.height >= minSize ? r : null;
}

export const regionLabel = (r) => `${r.width} × ${r.height}`;
