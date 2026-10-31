import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Segmenter, StreamResampler } from '../src/js/core/segmenter.js';

const RATE = 16000;
const tone = (s, amp = 0.2, freq = 220) => Float32Array.from({ length: Math.trunc(RATE * s) }, (_, i) => amp * Math.sin(2 * Math.PI * freq * i / RATE));
const silence = (s) => new Float32Array(Math.trunc(RATE * s));
function feedInChunks(seg, ...parts) {
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  const out = [];
  for (let i = 0; i < all.length; i += 1600) out.push(...seg.feed(all.subarray(i, Math.min(i + 1600, all.length))));
  return out;
}
const secs = (a) => a.length / RATE;

test('two utterances are split on silence', () => {
  const utts = feedInChunks(new Segmenter(), silence(1), tone(1.0), silence(1.2), tone(0.8), silence(1.2));
  assert.equal(utts.length, 2);
  assert.ok(secs(utts[0]) >= 1.0 && secs(utts[0]) <= 2.0);
  assert.ok(secs(utts[1]) >= 0.8 && secs(utts[1]) <= 1.8);
});

test('a short blip is discarded', () => {
  assert.deepEqual(feedInChunks(new Segmenter(), silence(1), tone(0.1), silence(1.5)), []);
});

test('background hiss is not speech', () => {
  let seed = 1; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const hiss = Float32Array.from({ length: RATE * 5 }, () => 0.003 * (rnd() * 2 - 1));
  assert.deepEqual(feedInChunks(new Segmenter(), hiss), []);
});

test('long speech is capped', () => {
  const utts = feedInChunks(new Segmenter({ maxUtteranceS: 5 }), tone(12.0), silence(1.0));
  assert.ok(utts.length >= 2);
  for (const u of utts) assert.ok(secs(u) <= 5.1);
});

test('flush returns pending speech, once', () => {
  const seg = new Segmenter();
  feedInChunks(seg, silence(0.5), tone(1.0));
  const tail = seg.flush();
  assert.ok(tail && secs(tail) > 0.9);
  assert.equal(seg.flush(), null);
});

test('isSpeaking and the speaking event follow the voice; snapshotSpeech gives the audio so far', () => {
  const seg = new Segmenter();
  const changes = [];
  seg.onSpeakingChanged = (s) => changes.push(s);
  assert.equal(seg.snapshotSpeech(), null);
  feedInChunks(seg, silence(0.5), tone(1.0));
  assert.equal(seg.isSpeaking, true);
  assert.ok(seg.voicedFrames > 25);
  const snap = seg.snapshotSpeech();
  assert.ok(secs(snap) > 0.9 && secs(snap) < 1.4);
  assert.equal(secs(seg.snapshotSpeech(0.5)) <= 0.51, true);
  feedInChunks(seg, silence(1.0));
  assert.equal(seg.isSpeaking, false);
  assert.deepEqual(changes, [true, false]);
  assert.equal(seg.trailingSilenceFrames, 0);
});

test('chunks of any size give the same utterances (odd chunk sizes carry over)', () => {
  const all = new Float32Array([...silence(1), ...tone(1.0), ...silence(1.2), ...tone(0.8), ...silence(1.2)]);
  const run = (size) => { const seg = new Segmenter(); const out = []; for (let i = 0; i < all.length; i += size) out.push(...seg.feed(all.subarray(i, i + size))); return out; };
  const a = run(1600); const b = run(333);
  assert.equal(b.length, a.length);
  assert.deepEqual(b.map((u) => u.length), a.map((u) => u.length));
});

const sine = (rate, channels, seconds, freq) => {
  const n = Math.trunc(rate * seconds); const d = new Float32Array(n * channels);
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) d[i * channels + c] = 0.5 * Math.sin(2 * Math.PI * freq * i / rate);
  return d;
};
const max = (a) => a.reduce((m, v) => Math.max(m, v), -Infinity);

for (const [rate, ch] of [[48000, 2], [44100, 2], [16000, 1], [32000, 1]])
  test(`resampler: output length matches the target rate (${rate} Hz, ${ch} ch)`, () => {
    const out = new StreamResampler(rate, ch).process(sine(rate, ch, 2.0, 440));
    assert.ok(out.length >= 31990 && out.length <= 32000, String(out.length));
  });

test('resampler: chunked input gives the same result as one piece', () => {
  const input = sine(44100, 2, 1.0, 300);
  const whole = new StreamResampler(44100, 2).process(input);
  const r = new StreamResampler(44100, 2);
  const parts = [];
  for (let i = 0; i < input.length; i += 1764) parts.push(...r.process(input.subarray(i, Math.min(i + 1764, input.length))));
  assert.ok(parts.length >= whole.length - 1 && parts.length <= whole.length);
  for (let i = 0; i < parts.length; i++) assert.ok(Math.abs(parts[i] - whole[i]) < 1e-4);
});

test('resampler: a tone keeps its amplitude, and content above the new Nyquist is attenuated', () => {
  assert.ok(max(new StreamResampler(48000, 2).process(sine(48000, 2, 1.0, 200))) > 0.45);
  const low = max(new StreamResampler(48000, 1).process(sine(48000, 1, 1.0, 1000)));
  const high = max(new StreamResampler(48000, 1).process(sine(48000, 1, 1.0, 20000)));
  assert.ok(high < low * 0.5, `high=${high} low=${low}`);
});
