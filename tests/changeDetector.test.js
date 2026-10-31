import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChangeDetector, GrayFrame } from '../src/js/core/changeDetector.js';

// A 60x160 "screen" with some dark blocks; `blocks` adds more.
function frame(blocks = 0) {
  const d = new Float32Array(60 * 160).fill(240);
  for (let i = 0; i < blocks; i++)
    for (let y = 10 + 8 * i; y < 14 + 8 * i && y < 60; y++) for (let x = 10; x < 100; x++) d[y * 160 + x] = 20;
  return new GrayFrame(160, 60, d);
}
// A block that jumps somewhere new every sample (like video).
function moving(i) {
  const d = new Float32Array(60 * 160).fill(240);
  const row = 2 + (i * 7) % 45;
  for (let y = row; y < row + 6; y++) for (let x = 20; x < 140; x++) d[y * 160 + x] = 20;
  return new GrayFrame(160, 60, d);
}
const run = (det, frames) => frames.filter(([t, f]) => det.update(f, t)).map(([t]) => t);

test('no change never fires', () => {
  assert.deepEqual(run(new ChangeDetector(), Array.from({ length: 40 }, (_, i) => [i * 0.5, frame(2)])), []);
});

test('fires once after the change settles', () => {
  const det = new ChangeDetector({ settleS: 1.0 });
  const fired = run(det, [[0, frame(1)], [0.5, frame(1)], [1.0, frame(2)], [1.5, frame(2)], [2.0, frame(2)], [2.5, frame(2)], [3.0, frame(2)]]);
  assert.deepEqual(fired, [2.0]); // appeared at 1.0, stayed still for 1s after it
});

test('does not fire while still changing', () => {
  const det = new ChangeDetector({ settleS: 1.0, maxWaitS: 100 });
  const seq = [[0, frame(1)]];
  for (let i = 1; i < 6; i++) seq.push([0.5 * i, frame(1 + i)]);
  assert.deepEqual(run(det, seq), []);
  assert.notEqual(run(det, Array.from({ length: 5 }, (_, i) => [3.0 + 0.5 * i, frame(6)])).length, 0);
});

test('a blinking cursor is ignored', () => {
  const base = frame(2);
  const blink = new GrayFrame(160, 60, base.data.slice());
  for (let y = 40; y < 48; y++) for (let x = 105; x < 107; x++) blink.data[y * 160 + x] = 20;
  assert.deepEqual(run(new ChangeDetector(), Array.from({ length: 40 }, (_, i) => [i * 0.5, i % 2 === 1 ? blink : base])), []);
});

test('returning to the baseline cancels a pending change', () => {
  const det = new ChangeDetector({ settleS: 1.0 });
  assert.deepEqual(run(det, [[0, frame(1)], [0.5, frame(3)], [1.0, frame(1)], [1.5, frame(1)], [3.0, frame(1)]]), []);
});

test('continuous motion fires at max wait, then is rate limited', () => {
  const det = new ChangeDetector({ settleS: 1.0, maxWaitS: 4.0, minIntervalS: 3.0 });
  const fired = run(det, Array.from({ length: 40 }, (_, i) => [0.5 * i, moving(i)]));
  assert.ok(fired.length >= 2 && fired.length <= 6, String(fired.length));
  for (let i = 1; i < fired.length; i++) assert.ok(fired[i] - fired[i - 1] >= 3.0);
});

test('pending is true only between the change and the report', () => {
  const det = new ChangeDetector({ settleS: 1.0 });
  det.update(frame(1), 0.0);
  assert.equal(det.pending, false);
  det.update(frame(3), 0.5);
  assert.equal(det.pending, true);
  det.update(frame(3), 1.0);
  assert.equal(det.pending, true);
  assert.equal(det.update(frame(3), 1.5), true);
  assert.equal(det.pending, false);
});

test('a size change restarts the baseline', () => {
  const det = new ChangeDetector();
  det.update(frame(1), 0);
  assert.equal(det.update(new GrayFrame(80, 30, new Float32Array(80 * 30)), 1), false);
  assert.equal(det.pending, false);
});

test('downsampling keeps thin dark text visible, and an all-black frame is flagged', () => {
  const w = 800, h = 300;
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 100; y < 102; y++) for (let x = 100; x < 500; x++) { const i = (y * w + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = 0; }
  const small = GrayFrame.fromRgba(rgba, w, h);
  assert.ok(small.width <= 160);
  assert.ok(Math.min(...small.data) < 200);
  assert.equal(small.isBlack, false);
  assert.equal(GrayFrame.fromRgba(new Uint8ClampedArray(40 * 40 * 4), 40, 40).isBlack, true);
});
