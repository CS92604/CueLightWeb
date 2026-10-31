import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioPipeline, FALLING_BEHIND } from '../src/js/audio/pipeline.js';
import { AudioIngest } from '../src/js/audio/ingest.js';
import { cleanTranscript } from '../src/js/stt/clean.js';
import { PhotoSlot, fitWithin } from '../src/js/screen/photoSlot.js';
import { isPhoneMode, forcedMode, canShareTabAudio, browserFamily } from '../src/js/device.js';
import { Speaker } from '../src/js/core/conversation.js';
import { deferred, sleep } from './helpers.js';

const aud = (n = 16000, v = 0.1) => new Float32Array(n).fill(v);
class FakeEngine {
  turns = []; live = []; errors = []; speaking = [];
  addTurn(w, t) { this.turns.push([w, t]); }
  setLive(w, t) { this.live.push([w, t]); }
  raiseError(m) { this.errors.push(m); }
  setSpeaking(w, on) { this.speaking.push([w, on]); }
}
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await sleep(5); } };

test('transcript cleaner removes annotations and invented phrases, and keeps real words', () => {
  assert.equal(cleanTranscript('[BLANK_AUDIO]'), '');
  assert.equal(cleanTranscript(' (music) ♪♪ '), '');
  assert.equal(cleanTranscript('Hello [ Silence ] there (laughs) friend'), 'Hello there friend');
  assert.equal(cleanTranscript('Thanks for watching!'), '');
  assert.equal(cleanTranscript('Please like and subscribe to my channel. See you'), 'See you');
  assert.equal(cleanTranscript('Subtitles by the Amara.org community'), '');
  assert.equal(cleanTranscript('...'), '');
  assert.equal(cleanTranscript('  What   about\nthis? '), 'What about this?');
  assert.equal(cleanTranscript(null), '');
});

test('finished utterances become turns for the right person, in order, and clear the live words', async () => {
  const engine = new FakeEngine();
  const seen = [];
  const transcriber = Promise.resolve({ transcribe: async (a) => { seen.push(a.length); return `said ${a.length}`; } });
  const p = new AudioPipeline({ engine, transcriber }); p.start();
  p.speaking(Speaker.Them, true); p.speaking(Speaker.Them, false);
  p.utterance(Speaker.Them, aud(100)); p.utterance(Speaker.Me, aud(200));
  await until(() => engine.turns.length === 2);
  assert.deepEqual(engine.turns, [[Speaker.Them, 'said 100'], [Speaker.Me, 'said 200']]);
  assert.deepEqual(engine.live.at(-1), [Speaker.Me, null]);
  p.dispose();
});

test('noise annotations from the speech model are not turns', async () => {
  const engine = new FakeEngine();
  const p = new AudioPipeline({ engine, transcriber: Promise.resolve({ transcribe: async () => '[BLANK_AUDIO]' }) }); p.start();
  p.utterance(Speaker.Them, aud());
  await sleep(60);
  assert.deepEqual(engine.turns, []);
  p.dispose();
});

test('the live words come from previews of the speech so far; only the newest snapshot is used', async () => {
  const engine = new FakeEngine();
  const previews = [];
  const gate = deferred();
  let first = true;
  const transcriber = Promise.resolve({
    transcribe: async () => 'final',
    preview: async (a) => { previews.push(a.length); if (first) { first = false; await gate.promise; } return `preview ${a.length}`; },
  });
  const p = new AudioPipeline({ engine, transcriber, previewMinGapMs: 0 }); p.start();
  p.speaking(Speaker.Them, true);
  p.partial(Speaker.Them, aud(1000));
  await until(() => previews.length === 1);
  p.partial(Speaker.Them, aud(2000)); p.partial(Speaker.Them, aud(3000)); p.partial(Speaker.Them, aud(4000)); // while the first runs
  gate.resolve();
  await until(() => engine.live.some(([, t]) => t === 'preview 4000'));
  assert.deepEqual(previews, [1000, 4000]); // 2000 and 3000 were never run
  p.dispose();
});

test('a finished sentence goes before any preview, and the preview it cut short is not shown', async () => {
  const engine = new FakeEngine();
  const order = [];
  const gate = deferred();
  const transcriber = Promise.resolve({
    transcribe: async (a) => { order.push(`final ${a.length}`); return 'done'; },
    preview: async (a) => { order.push(`preview ${a.length}`); await gate.promise; return `words ${a.length}`; },
  });
  const p = new AudioPipeline({ engine, transcriber, previewMinGapMs: 0 }); p.start();
  p.speaking(Speaker.Them, true);
  p.partial(Speaker.Them, aud(1000));
  await until(() => order.length === 1);
  p.utterance(Speaker.Them, aud(500)); // the sentence ends while a preview runs
  p.partial(Speaker.Them, aud(1500));
  gate.resolve();
  await until(() => engine.turns.length === 1);
  await until(() => order.length === 3);
  assert.deepEqual(order, ['preview 1000', 'final 500', 'preview 1500']); // the sentence before the newer preview
  await sleep(30);
  assert.ok(!engine.live.some(([, t]) => t === 'words 1000')); // the cut-short preview is never shown
  p.dispose();
});

test('a preview for someone who has stopped speaking is not shown', async () => {
  const engine = new FakeEngine();
  const gate = deferred();
  const p = new AudioPipeline({ engine, previewMinGapMs: 0, transcriber: Promise.resolve({ transcribe: async () => 'x', preview: async () => { await gate.promise; return 'late'; } }) }); p.start();
  p.speaking(Speaker.Them, true);
  p.partial(Speaker.Them, aud(1000));
  await sleep(20);
  p.speaking(Speaker.Them, false);
  gate.resolve();
  await sleep(60);
  assert.ok(!engine.live.some(([, t]) => t === 'late'));
  p.dispose();
});

test('the preview only looks at the newest few seconds, so it stays quick on a slow device', async () => {
  const sizes = [];
  const p = new AudioPipeline({ engine: new FakeEngine(), previewMinGapMs: 0, previewMaxSeconds: 2, transcriber: Promise.resolve({ transcribe: async () => '', preview: async (a) => { sizes.push(a.length); return 'x'; } }) }); p.start();
  p.speaking(Speaker.Them, true);
  p.partial(Speaker.Them, aud(16000 * 10));
  await until(() => sizes.length === 1);
  assert.equal(sizes[0], 32000);
  p.dispose();
});

test('when speech arrives faster than it can be transcribed the oldest is skipped, and the user is told once a minute', async () => {
  const engine = new FakeEngine();
  const gate = deferred();
  const heard = [];
  let t = 0;
  const p = new AudioPipeline({ engine, now: () => t, transcriber: Promise.resolve({ transcribe: async (a) => { heard.push(a.length); await gate.promise; return 'x'; } }) }); p.start();
  p.utterance(Speaker.Them, aud(1)); await until(() => heard.length === 1);
  for (let i = 2; i <= 14; i++) p.utterance(Speaker.Them, aud(i));
  assert.deepEqual(engine.errors, [FALLING_BEHIND]); // several dropped, one notice
  t = 61_000;
  p.utterance(Speaker.Them, aud(99));
  assert.equal(engine.errors.length, 2);
  gate.resolve();
  await until(() => heard.length === 9);
  assert.ok(!heard.includes(2)); // the oldest waiting ones were the ones dropped
  p.dispose();
});

test('a speech model that fails to load, or a transcription that fails, is reported', async () => {
  const e1 = new FakeEngine();
  const p1 = new AudioPipeline({ engine: e1, transcriber: Promise.reject(new Error('no network')) }); p1.start();
  await until(() => e1.errors.length === 1);
  assert.match(e1.errors[0], /Couldn't load the speech model: no network/);
  const e2 = new FakeEngine();
  const p2 = new AudioPipeline({ engine: e2, transcriber: Promise.resolve({ transcribe: async () => { throw new Error('boom'); } }) }); p2.start();
  p2.utterance(Speaker.Them, aud());
  await until(() => e2.errors.length === 1);
  assert.match(e2.errors[0], /Transcription failed: boom/);
  p1.dispose(); p2.dispose();
});

test('ingest: speech is cut at a pause, previews are scheduled by voiced frames, and a quiet device is fed silence', () => {
  const utts = []; const partials = []; const speaking = [];
  let now = 0;
  const ing = new AudioIngest({ sampleRate: 16000, onUtterance: (u) => utts.push(u), onPartial: (p) => partials.push(p), onSpeaking: (s) => speaking.push(s), clock: () => now });
  const tone = (s) => Float32Array.from({ length: Math.trunc(16000 * s) }, (_, i) => 0.2 * Math.sin(2 * Math.PI * 220 * i / 16000));
  ing.feed(new Float32Array(8000));
  for (let i = 0; i < 20; i++) ing.feed(tone(0.1)); // 2 s of voice in 100 ms chunks
  assert.equal(ing.isSpeaking, true);
  assert.ok(partials.length >= 3, `${partials.length} previews`);
  assert.ok(partials.at(-1).length > partials[0].length);
  assert.equal(utts.length, 0);
  now += 1; // the device stops delivering data (loopback goes quiet): ticks inject silence
  for (let i = 0; i < 12; i++) ing.tick();
  assert.equal(utts.length, 1);
  assert.deepEqual(speaking, [true, false]);
  ing.feed(tone(0.5)); ing.flush();
  assert.equal(utts.length, 2);
});

test('the photo slot: the newest replaces the old, release drops it, nothing old comes back', () => {
  const slot = new PhotoSlot();
  const released = [];
  slot.onReleased = () => released.push(1);
  assert.equal(slot.has, false);
  slot.set({ mediaType: 'image/jpeg', data: 'AAA' });
  slot.set({ mediaType: 'image/png', data: 'BBB' });
  assert.deepEqual(slot.peek(), { mediaType: 'image/png', data: 'BBB' });
  assert.deepEqual(released, []); // replacing is not "used"
  slot.release();
  assert.equal(slot.peek(), null);
  assert.equal(slot.has, false);
  assert.deepEqual(released, [1]);
  slot.release();
  assert.deepEqual(released, [1]); // nothing to release
});

test('photos are scaled so the long edge is at most 1568, never enlarged', () => {
  assert.deepEqual(fitWithin(4000, 3000), { width: 1568, height: 1176 });
  assert.deepEqual(fitWithin(3000, 4000), { width: 1176, height: 1568 });
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(1568, 100), { width: 1568, height: 100 });
  assert.deepEqual(fitWithin(10000, 1), { width: 1568, height: 1 });
});

test('phone mode: phones and tablets listen through the microphone only; computers can share', () => {
  const nav = (ua, extra = {}) => ({ userAgent: ua, mediaDevices: { getDisplayMedia() {} }, ...extra });
  assert.equal(isPhoneMode({ nav: nav('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Safari/604.1'), search: '', coarse: true }), true);
  assert.equal(isPhoneMode({ nav: nav('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari/537.36'), search: '', coarse: true }), true);
  assert.equal(isPhoneMode({ nav: nav('Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari', { platform: 'MacIntel', maxTouchPoints: 5 }), search: '', coarse: true }), true); // iPadOS
  assert.equal(isPhoneMode({ nav: nav('Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/120 Safari/537.36'), search: '', coarse: false }), false);
  assert.equal(isPhoneMode({ nav: { userAgent: 'Mozilla/5.0 (X11; Linux) Firefox/120', mediaDevices: {} }, search: '', coarse: true }), true); // touch-first and cannot share
  assert.equal(isPhoneMode({ nav: nav('Chrome'), search: '?mode=phone', coarse: false }), true);
  assert.equal(isPhoneMode({ nav: nav('iPhone Mobile'), search: '?mode=desktop', coarse: true }), false);
  assert.equal(forcedMode('?mode=weird'), null);
  assert.equal(canShareTabAudio('Mozilla/5.0 Chrome/120 Safari/537.36'), true);
  assert.equal(canShareTabAudio('Mozilla/5.0 Chrome/120 Safari/537.36 Edg/120'), true);
  assert.equal(canShareTabAudio('Mozilla/5.0 Firefox/120'), false);
  assert.equal(canShareTabAudio('Mozilla/5.0 (Macintosh) Version/17 Safari/605'), false);
  assert.equal(browserFamily('Mozilla/5.0 (iPhone) CriOS/120'), 'chrome');
});
