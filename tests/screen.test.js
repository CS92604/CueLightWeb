import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dragToRegion, regionLabel } from '../src/js/screen/region.js';
import { RegionWatcher } from '../src/js/screen/watcher.js';
import { makeCapture } from '../src/js/screen/capture.js';
import { PhotoSlot } from '../src/js/screen/photoSlot.js';
import { GrayFrame } from '../src/js/core/changeDetector.js';
import { sleep } from './helpers.js';

test('a drag maps to the picture\'s pixels in any direction, and is clipped to the picture', () => {
  assert.deepEqual(dragToRegion({ x: 30, y: 40 }, { x: 10, y: 10 }, { x: 2, y: 2 }, { width: 1000, height: 800 }), { kind: 'region', left: 20, top: 20, width: 40, height: 60 });
  assert.deepEqual(dragToRegion({ x: -50, y: -5 }, { x: 5000, y: 5000 }, { x: 1, y: 1 }, { width: 1000, height: 800 }), { kind: 'region', left: 0, top: 0, width: 1000, height: 800 });
  assert.equal(regionLabel({ width: 420, height: 160 }), '420 × 160');
});

test('a tiny drag (a stray click) is rejected', () => {
  assert.equal(dragToRegion({ x: 5, y: 5 }, { x: 10, y: 9 }, { x: 1, y: 1 }, { width: 100, height: 100 }), null);
});

const frame = (v) => new GrayFrame(10, 10, new Float32Array(100).fill(v));

test('the region watcher reports a failure once after several in a row, says when it recovers, and skips blank frames', () => {
  const errors = []; let recovered = 0; let mode = 'fail'; let changes = 0;
  let now = 0;
  const w = new RegionWatcher({
    sample: () => { if (mode === 'fail') throw new Error('tab switched'); if (mode === 'black') return frame(0); return frame(mode === 'a' ? 200 : 40); },
    onChange: () => changes++, onError: (m) => errors.push(m), onRecovered: () => recovered++, failuresBeforeError: 3, clock: () => now,
  });
  for (let i = 0; i < 10; i++) w.tick();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Can't read the text area right now \(tab switched\)\. Still trying\./);
  mode = 'black'; w.tick();
  assert.equal(recovered, 1);
  mode = 'a'; now = 0; w.tick();
  mode = 'b'; now = 1; w.tick();
  assert.equal(w.pending, true);
  now = 2.5; w.tick();
  now = 3; w.tick();
  assert.equal(changes, 1);
  assert.equal(w.pending, false);
});

test('the region watcher polls on a timer until disposed', async () => {
  let n = 0;
  const w = new RegionWatcher({ sample: () => { n++; return frame(100); }, onChange() {}, onError() {}, intervalMs: 10 });
  w.start(); w.start();
  await sleep(75);
  w.dispose();
  const at = n;
  assert.ok(at >= 4 && at <= 9, String(at));
  await sleep(50);
  assert.equal(n, at);
});

test('capture: a photo comes from the slot and is dropped after use; a region comes from the shared video', async () => {
  const photo = new PhotoSlot();
  photo.set({ mediaType: 'image/jpeg', data: 'QQ==' });
  let video = null;
  const cap = makeCapture({ video: () => video, photo });
  assert.deepEqual(await cap.capture({ kind: 'photo' }), { mediaType: 'image/jpeg', data: 'QQ==' });
  cap.release({ kind: 'photo' });
  assert.equal(photo.has, false);
  assert.equal(await cap.capture({ kind: 'photo' }), null);
  await assert.rejects(cap.capture({ kind: 'region', left: 0, top: 0, width: 50, height: 50 }), /nothing is being shared/);
  video = { capture: async (r) => ({ mediaType: 'image/png', data: `region ${r.width}` }) };
  assert.deepEqual(await cap.capture({ kind: 'region', left: 0, top: 0, width: 50, height: 50 }), { mediaType: 'image/png', data: 'region 50' });
  photo.set({ mediaType: 'image/png', data: 'x' });
  cap.release({ kind: 'region' }); // releasing a region never touches the photo
  assert.equal(photo.has, true);
});
