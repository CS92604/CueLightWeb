// Choosing the text area: a still of the shared screen, and a box dragged over it.
import { dragToRegion } from '../screen/region.js';

/**
 * @param {{dialog:HTMLDialogElement, canvas:HTMLCanvasElement, stage:HTMLElement, box:HTMLElement, ok:HTMLButtonElement, cancel:HTMLButtonElement}} els
 * @param {HTMLCanvasElement} still  a picture of the whole shared screen
 * @returns {Promise<object|null>} the chosen region, in the picture's own pixels, or null
 */
export function pickRegion(els, still) {
  const { dialog, canvas, stage, box, ok, cancel } = els;
  canvas.width = still.width; canvas.height = still.height;
  canvas.getContext('2d').drawImage(still, 0, 0);
  box.hidden = true;
  ok.disabled = true;
  let region = null;
  let start = null;

  return new Promise((resolve) => {
    const point = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const scale = () => { const r = canvas.getBoundingClientRect(); return { x: canvas.width / r.width, y: canvas.height / r.height }; };
    const draw = (a, b) => {
      const left = Math.min(a.x, b.x), top = Math.min(a.y, b.y);
      Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${Math.abs(a.x - b.x)}px`, height: `${Math.abs(a.y - b.y)}px` });
      box.hidden = false;
    };
    const down = (e) => { start = point(e); stage.setPointerCapture(e.pointerId); region = null; ok.disabled = true; draw(start, start); };
    const move = (e) => { if (!start) return; const p = point(e); draw(start, p); region = dragToRegion(start, p, scale(), { width: canvas.width, height: canvas.height }); ok.disabled = !region; };
    const up = (e) => { if (!start) return; move(e); start = null; };
    const finish = (value) => {
      stage.removeEventListener('pointerdown', down); stage.removeEventListener('pointermove', move); stage.removeEventListener('pointerup', up);
      ok.onclick = null; cancel.onclick = null; dialog.removeEventListener('close', onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onClose = () => finish(null);
    stage.addEventListener('pointerdown', down); stage.addEventListener('pointermove', move); stage.addEventListener('pointerup', up);
    ok.onclick = () => finish(region);
    cancel.onclick = () => finish(null);
    dialog.addEventListener('close', onClose);
    dialog.showModal();
  });
}
