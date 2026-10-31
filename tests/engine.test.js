import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, EngineEventKind as K } from '../src/js/engine.js';
import { Speaker } from '../src/js/core/conversation.js';
import { Trigger } from '../src/js/core/prompting.js';
import { tokenUsage } from '../src/js/core/usage.js';
import { Provider } from '../src/js/core/providers.js';
import { useProvider, defaultSettings } from '../src/js/core/settings.js';
import { FakeSuggester, FakeCapture, FakeWatcher, Recorder, deferred, sleep, FAKE_IMAGE } from './helpers.js';

const AREA = { left: 10, top: 20, width: 300, height: 200 };
const engines = [];
afterEach(() => { while (engines.length) engines.pop().dispose(); });

function make({ tweak = {}, sug = new FakeSuggester(), capture = new FakeCapture(), withRegion = false, textReader = null, settings = null } = {}) {
  FakeWatcher.instances.length = 0;
  const eng = new Engine({
    options: { debounceMs: 50, ...tweak }, suggester: sug, capture, textReader,
    watcherFactory: (region, onChange) => { const w = new FakeWatcher(onChange); FakeWatcher.instances.push(w); return w; },
  });
  if (settings) eng.settings = settings;
  const rec = new Recorder();
  eng.on(rec.add);
  eng.start();
  engines.push(eng);
  if (withRegion) eng.setRegion(AREA);
  return { eng, sug, rec, capture };
}
const nothing = () => Object.assign(new FakeSuggester(), { chunks: ['(nothing to respond to yet)'] });
const chunksOf = (rec) => rec.events.filter((e) => e.kind === K.Chunk).map((e) => e.text).join('');

test('speech triggers a SAY request without an image', async () => {
  const { eng, sug, rec } = make({ withRegion: true });
  eng.addTurn(Speaker.Them, 'Can you tell me about your last project?');
  await rec.waitFor(K.SuggestEnd);
  assert.equal(sug.calls.length, 1);
  assert.equal(sug.calls[0].trigger, Trigger.Speech);
  assert.equal(sug.calls[0].regionImage, null);
  assert.ok(sug.calls[0].transcript.includes('Them: Can you tell me about your last project?'));
  assert.equal(chunksOf(rec), 'SAY\n• one\n• two');
});

test('a long pause after "nothing to reply to" asks again once, with the pause noted', async () => {
  const { eng, sug, rec } = make({ tweak: { pauseFollowUpMs: 150 }, sug: nothing(), withRegion: true });
  eng.addTurn(Speaker.Them, 'The dog that played Toto in the Wizard of Oz was credited as');
  await rec.waitFor(K.SuggestEnd, 2);
  assert.equal(sug.calls.length, 2);
  assert.equal(sug.calls[0].trigger, Trigger.Speech);
  assert.equal(sug.calls[1].trigger, Trigger.Pause);
  assert.equal(sug.calls[1].regionImage, null); // a pause is about what was said, not the screen
  assert.ok(sug.calls[1].transcript.includes('credited as'));
  await sleep(500);
  assert.equal(sug.calls.length, 2); // and only once
});

test('no second look if there was something to reply to, or more was said meanwhile, or someone is speaking, or recording is off', async () => {
  const a = make({ tweak: { pauseFollowUpMs: 100 } });
  a.eng.addTurn(Speaker.Them, 'Can you tell me about your last project?');
  await a.rec.waitFor(K.SuggestEnd);
  await sleep(350);
  assert.equal(a.sug.calls.length, 1);

  const b = make({ tweak: { pauseFollowUpMs: 200 }, sug: nothing() });
  b.eng.addTurn(Speaker.Them, 'The dog that played Toto in the Wizard of Oz was credited as');
  await b.rec.waitFor(K.SuggestEnd);
  b.eng.conversation.add(Speaker.Them, 'as Toto'); b.eng.addTurn(Speaker.Me, 'hmm, let me think'); // more was said
  await sleep(500);
  assert.equal(b.sug.calls.length, 1);

  const c = make({ tweak: { pauseFollowUpMs: 200 }, sug: nothing() });
  c.eng.addTurn(Speaker.Them, 'The dog that played Toto in the Wizard of Oz was credited as');
  await c.rec.waitFor(K.SuggestEnd);
  c.eng.setSpeaking(Speaker.Them, true); // someone is speaking right now
  await sleep(450);
  assert.equal(c.sug.calls.length, 1);

  const d = make({ tweak: { pauseFollowUpMs: 200 }, sug: nothing() });
  d.eng.addTurn(Speaker.Them, 'The dog that played Toto in the Wizard of Oz was credited as');
  await d.rec.waitFor(K.SuggestEnd);
  d.eng.setPaused(true);
  await sleep(450);
  assert.equal(d.sug.calls.length, 1);
});

test('what each request used is added up and announced; clearing the chat does not reset it', async () => {
  const sug = Object.assign(new FakeSuggester(), { report: tokenUsage('claude-sonnet-5-5', 100, 500, 4000, 300) });
  const { eng, rec } = make({ sug });
  eng.addTurn(Speaker.Them, 'Can you tell me about your last project?');
  await rec.waitFor(K.Usage);
  const u = eng.usage.snapshot();
  assert.equal(u.requests, 1);
  assert.deepEqual([u.input, u.cacheWrite, u.cacheRead, u.output], [100, 500, 4000, 300]);
  assert.ok(Math.abs(u.cost - 0.00485) < 1e-12);
  assert.equal(u.unpriced, false);
  eng.clearConversation();
  assert.equal(eng.usage.snapshot().requests, 1);
});

test('requests carry only the recent part of a long call', async () => {
  const { eng, sug, rec } = make({ tweak: { transcriptChars: 3000, transcriptKeepChars: 2000 } });
  for (let i = 0; i < 100; i++) eng.conversation.add(i % 2 === 0 ? Speaker.Me : Speaker.Them, `Turn ${i}: ` + 'x'.repeat(90));
  eng.addTurn(Speaker.Them, 'Can you tell me about your last project?');
  await rec.waitFor(K.SuggestEnd);
  assert.equal(sug.calls.length, 1);
  const t = sug.calls[0].transcript;
  assert.ok(t.length <= 3000, `${t.length} characters`);
  assert.ok(t.startsWith('[earlier conversation omitted]'));
  assert.ok(t.endsWith('Can you tell me about your last project?'));
});

test('my own speech and short backchannels do not trigger', async () => {
  const { eng, sug, rec } = make();
  eng.addTurn(Speaker.Me, 'I built a scheduling service at my last job.');
  eng.addTurn(Speaker.Them, 'mm-hmm');
  await sleep(300);
  assert.equal(sug.calls.length, 0);
  assert.equal(rec.count(K.Turn), 2);
});

test('rapid utterances are coalesced into one request', async () => {
  const { eng, sug, rec } = make({ tweak: { debounceMs: 200 } });
  eng.addTurn(Speaker.Them, 'So tell me about yourself and your background.');
  eng.addTurn(Speaker.Them, 'And why you want this particular role here.');
  await rec.waitFor(K.SuggestEnd);
  await sleep(400);
  assert.equal(sug.calls.length, 1);
  assert.ok(sug.calls[0].transcript.includes('background. And why you want'));
});

test('a screen change triggers a TYPE request with the region image', async () => {
  const { eng, sug, rec } = make({ withRegion: true });
  assert.equal(FakeWatcher.instances.at(-1).started, true);
  eng.onScreenChanged();
  await rec.waitFor(K.SuggestEnd);
  assert.equal(sug.calls[0].trigger, Trigger.Text);
  assert.deepEqual(sug.calls[0].regionImage, FAKE_IMAGE);
});

test('speech and a screen change together ask for both', async () => {
  const { eng, sug, rec } = make({ tweak: { debounceMs: 200 }, withRegion: true });
  eng.addTurn(Speaker.Them, 'Did you get my message about the schedule?');
  eng.onScreenChanged();
  await rec.waitFor(K.SuggestEnd);
  await sleep(400);
  assert.equal(sug.calls.length, 1);
  assert.equal(sug.calls[0].trigger, Trigger.Speech | Trigger.Text);
  assert.ok(sug.calls[0].regionImage);
});

test('an interrupted text request is not forgotten when speech arrives', async () => {
  const sug = Object.assign(new FakeSuggester(), { gate: deferred() });
  const { eng, rec } = make({ tweak: { debounceMs: 0 }, sug, withRegion: true });
  eng.onScreenChanged(); // run 1: TEXT, blocks after its first chunk
  await sug.firstChunkSent.promise;
  eng.addTurn(Speaker.Them, 'Hey, are you still there with us on the call?'); // supersedes run 1
  sug.gate.resolve();
  await rec.waitFor(K.SuggestEnd);
  assert.equal(sug.calls[0].trigger, Trigger.Text);
  assert.equal(sug.calls[1].trigger, Trigger.Speech | Trigger.Text);
});

test('clearing the conversation drops what an interrupted run owed', async () => {
  const sug = Object.assign(new FakeSuggester(), { gate: deferred() });
  const { eng, rec } = make({ tweak: { debounceMs: 0 }, sug, withRegion: true });
  eng.onScreenChanged();
  await sug.firstChunkSent.promise;
  eng.clearConversation();
  sug.gate.resolve();
  await sleep(300);
  eng.request(Trigger.Speech); // a fresh request must not inherit the old TEXT trigger
  await rec.waitFor(K.SuggestEnd);
  assert.equal(sug.calls.at(-1).trigger, Trigger.Speech);
});

test('with Auto-suggest off triggers are ignored, but a manual request works', async () => {
  const { eng, sug, rec } = make({ tweak: { autoSuggest: false, debounceMs: 0 }, withRegion: true });
  eng.addTurn(Speaker.Them, 'What are your salary expectations for this role?');
  eng.onScreenChanged();
  await sleep(200);
  assert.equal(sug.calls.length, 0);
  eng.request(Trigger.None, 'keep it polite and short');
  await rec.waitFor(K.SuggestEnd);
  assert.equal(sug.calls[0].trigger, Trigger.Manual);
  assert.equal(sug.calls[0].hint, 'keep it polite and short');
});

test('clearing the region stops watching', () => {
  const { eng } = make({ withRegion: true });
  const w = FakeWatcher.instances.at(-1);
  eng.setRegion(null);
  assert.equal(w.disposed, true);
  assert.equal(eng.isWatching, false);
});

test('a failed capture degrades gracefully: the request goes without a picture', async () => {
  const capture = Object.assign(new FakeCapture(), { fail: true });
  const { eng, sug, rec } = make({ capture, withRegion: true });
  eng.onScreenChanged();
  await rec.waitFor(K.SuggestEnd);
  assert.equal(sug.calls[0].regionImage, null);
  assert.ok(rec.events.some((e) => e.kind === K.Status && /Couldn't capture the text area \(no display\)/.test(e.text)));
});

test('a spoken request waits for a settling screen change and merges with it', async () => {
  const { eng, sug, rec } = make({ tweak: { debounceMs: 50, mergeHoldMs: 3000 }, withRegion: true });
  const w = FakeWatcher.instances.at(-1);
  w.pending = true; // the chat text is mid-change
  eng.addTurn(Speaker.Them, 'Hey, did you see the message I just sent you?');
  await sleep(400);
  assert.equal(sug.calls.length, 0); // held, not sent as speech-only
  w.pending = false;
  eng.onScreenChanged(); // the text settled
  await rec.waitFor(K.SuggestEnd);
  await sleep(200);
  assert.equal(sug.calls.length, 1);
  assert.equal(sug.calls[0].trigger, Trigger.Speech | Trigger.Text);
});

test('the hold is bounded if the screen never settles', async () => {
  const { eng, sug, rec } = make({ tweak: { debounceMs: 50, mergeHoldMs: 500 }, withRegion: true });
  FakeWatcher.instances.at(-1).pending = true; // e.g. a video playing in the watched area
  eng.addTurn(Speaker.Them, 'Hey, did you see the message I just sent you?');
  await rec.waitFor(K.SuggestEnd, 1, 3000);
  assert.equal(sug.calls[0].trigger, Trigger.Speech);
});

test('errors are reported, not thrown, and the engine keeps serving', async () => {
  const sug = Object.assign(new FakeSuggester(), { throwError: new Error('kaput') });
  const { eng, rec } = make({ tweak: { autoSuggest: false }, sug });
  eng.request();
  await rec.waitFor(K.Error);
  assert.ok(rec.events.some((e) => e.kind === K.Error && e.text === 'kaput'));
  await rec.waitFor(K.SuggestEnd);
  sug.throwError = null;
  eng.request();
  await rec.waitFor(K.SuggestEnd, 2);
  assert.equal(sug.calls.length, 2);
});

test('settings are applied to the next request', async () => {
  const { eng, sug, rec } = make({ tweak: { autoSuggest: false } });
  eng.settings = { ...defaultSettings(), tone: 'Direct', options: 9 };
  eng.request();
  await rec.waitFor(K.SuggestEnd);
  assert.equal(sug.calls[0].settings.tone, 'Direct');
  assert.equal(sug.calls[0].settings.options, 3); // normalized
});

// -- Panic -------------------------------------------------------------------------------------------------------

test('panic reads the text area now, even with Auto-suggest off', async () => {
  const { eng, sug, rec } = make({ tweak: { autoSuggest: false, debounceMs: 30_000 }, withRegion: true });
  assert.equal(eng.panic(), true);
  await rec.waitFor(K.SuggestEnd, 1, 2000);
  assert.equal(sug.calls.length, 1);
  assert.ok(sug.calls[0].trigger & Trigger.Forced);
  assert.ok(sug.calls[0].regionImage);
  assert.ok(rec.events.some((e) => e.kind === K.SuggestStart && e.text === 'Reading the text area…'));
});

test('panic does not wait for a changing screen to settle', async () => {
  const { eng, sug, rec } = make({ tweak: { mergeHoldMs: 5000 }, withRegion: true });
  FakeWatcher.instances.at(-1).pending = true;
  eng.panic();
  await rec.waitFor(K.SuggestEnd, 1, 1500);
  assert.equal(sug.calls.length, 1);
});

test('panic without a text area (or photo) says so and sends nothing', async () => {
  const { eng, sug, rec } = make();
  assert.equal(eng.panic(), false);
  await sleep(150);
  assert.equal(sug.calls.length, 0);
  assert.ok(rec.events.some((e) => e.kind === K.Status && /photo/.test(e.text)));
});

test('panic takes over a reply in progress and keeps what it owed', async () => {
  const sug = Object.assign(new FakeSuggester(), { gate: deferred() });
  const { eng, rec } = make({ tweak: { debounceMs: 0 }, sug, withRegion: true });
  eng.addTurn(Speaker.Them, 'Hey, are you still there with us on the call?');
  await sug.firstChunkSent.promise;
  eng.panic();
  sug.gate.resolve();
  await rec.waitFor(K.SuggestEnd);
  await sleep(200);
  assert.equal(sug.calls.length, 2);
  assert.equal(sug.calls[1].trigger, Trigger.Speech | Trigger.Manual | Trigger.Forced);
  assert.ok(sug.calls[1].regionImage);
});

// -- Regenerate --------------------------------------------------------------------------------------------------

test('regenerate redoes the last request and passes the thrown-away reply', async () => {
  const { eng, sug, rec } = make({ withRegion: true });
  eng.addTurn(Speaker.Them, 'Can you tell me about your last project?');
  await rec.waitFor(K.SuggestEnd, 1);
  eng.regenerate();
  await rec.waitFor(K.SuggestEnd, 2);
  assert.equal(sug.calls.length, 2);
  assert.equal(sug.calls[0].rejected, null);
  assert.equal(sug.calls[1].trigger, Trigger.Speech);
  assert.equal(sug.calls[1].regionImage, null); // a spoken-only request stays spoken-only
  assert.deepEqual(sug.calls[1].rejected, ['SAY\n• one\n• two']);
  assert.ok(rec.events.some((e) => e.kind === K.SuggestStart && e.text === 'Trying another take…'));
});

test('regenerating again remembers every reply up to a cap of three', async () => {
  const { eng, sug, rec } = make({ tweak: { autoSuggest: false }, withRegion: true });
  eng.request();
  await rec.waitFor(K.SuggestEnd, 1);
  for (let i = 2; i <= 6; i++) { eng.regenerate(); await rec.waitFor(K.SuggestEnd, i); }
  assert.deepEqual(sug.calls.map((c) => c.rejected?.length ?? 0), [0, 1, 2, 3, 3, 3]);
});

test('regenerate keeps the hint until given a new one', async () => {
  const { eng, sug, rec } = make({ tweak: { autoSuggest: false } });
  eng.request(Trigger.None, 'shorter');
  await rec.waitFor(K.SuggestEnd, 1);
  eng.regenerate();
  await rec.waitFor(K.SuggestEnd, 2);
  eng.regenerate('friendlier');
  await rec.waitFor(K.SuggestEnd, 3);
  assert.deepEqual(sug.calls.map((c) => c.hint), ['shorter', 'shorter', 'friendlier']);
});

test('regenerate uses the current transcript and settings', async () => {
  const { eng, sug, rec } = make({ tweak: { autoSuggest: false } });
  eng.addTurn(Speaker.Them, 'Can you tell me about your last project?');
  eng.request();
  await rec.waitFor(K.SuggestEnd, 1);
  eng.addTurn(Speaker.Me, 'Sure, it was a booking system.');
  eng.settings = { ...defaultSettings(), tone: 'Direct' };
  eng.regenerate();
  await rec.waitFor(K.SuggestEnd, 2);
  assert.ok(sug.calls[1].transcript.includes('booking system'));
  assert.equal(sug.calls[1].settings.tone, 'Direct');
});

test('a new moment forgets the thrown-away replies', async () => {
  const { eng, sug, rec } = make({ tweak: { autoSuggest: false } });
  eng.request();
  await rec.waitFor(K.SuggestEnd, 1);
  eng.regenerate();
  await rec.waitFor(K.SuggestEnd, 2);
  eng.request();
  await rec.waitFor(K.SuggestEnd, 3);
  assert.equal(sug.calls[1].rejected.length, 1);
  assert.equal(sug.calls[2].rejected, null);
});

test('regenerating midway restarts once and throws away the partial reply', async () => {
  const sug = Object.assign(new FakeSuggester(), { gate: deferred() });
  const { eng, rec } = make({ tweak: { debounceMs: 0 }, sug });
  eng.addTurn(Speaker.Them, 'Can you tell me about your last project?');
  await sug.firstChunkSent.promise;
  eng.regenerate();
  sug.gate.resolve();
  await rec.waitFor(K.SuggestEnd);
  await sleep(300);
  assert.equal(sug.calls.length, 2); // no duplicate from the cancelled run's debt
  assert.deepEqual(sug.calls[1].rejected, ['SAY\n• one']);
});

test('regenerate with nothing to redo is a plain manual request; a "(nothing…)" reply is not held against the next try', async () => {
  const a = make({ tweak: { autoSuggest: false } });
  a.eng.regenerate();
  await a.rec.waitFor(K.SuggestEnd);
  assert.equal(a.sug.calls[0].trigger, Trigger.Manual);
  assert.equal(a.sug.calls[0].rejected, null);

  const b = make({ tweak: { autoSuggest: false }, sug: nothing() });
  b.eng.request();
  await b.rec.waitFor(K.SuggestEnd, 1);
  b.eng.regenerate();
  await b.rec.waitFor(K.SuggestEnd, 2);
  assert.equal(b.sug.calls[1].rejected, null);
});

test('clearing the conversation forgets what there was to regenerate', async () => {
  const { eng, sug, rec } = make({ tweak: { autoSuggest: false }, withRegion: true });
  eng.request(Trigger.Speech);
  await rec.waitFor(K.SuggestEnd, 1);
  eng.clearConversation();
  eng.regenerate();
  await rec.waitFor(K.SuggestEnd, 2);
  assert.equal(sug.calls[1].trigger, Trigger.Manual);
  assert.equal(sug.calls[1].rejected, null);
});

// -- Recording off / Type off ------------------------------------------------------------------------------------

test('while paused nothing triggers and nothing is sent; a late transcript still lands in the chat', async () => {
  const { eng, sug, rec } = make({ withRegion: true });
  eng.setPaused(true);
  eng.addTurn(Speaker.Them, 'Can you tell me about your last project?');
  eng.onScreenChanged(); eng.request(); eng.request(Trigger.Speech, 'x');
  assert.equal(eng.panic(), false);
  eng.regenerate();
  await sleep(300);
  assert.equal(sug.calls.length, 0);
  assert.ok(eng.conversation.render(1000).includes('last project'));
  assert.ok(rec.events.some((e) => e.kind === K.Status && /Recording is off/.test(e.text)));
});

test('pausing stops the watcher and resuming starts a fresh one on the same region', () => {
  const { eng } = make({ withRegion: true });
  const first = FakeWatcher.instances.at(-1);
  eng.setPaused(true);
  assert.equal(first.disposed, true);
  eng.setPaused(false);
  const second = FakeWatcher.instances.at(-1);
  assert.notEqual(second, first);
  assert.equal(second.started, true);
});

test('pausing cancels a reply in flight, and resuming does not resurrect it', async () => {
  const sug = Object.assign(new FakeSuggester(), { gate: deferred() });
  const { eng, rec } = make({ tweak: { debounceMs: 0 }, sug });
  eng.addTurn(Speaker.Them, 'Can you tell me about your last project?');
  await sug.firstChunkSent.promise;
  eng.setPaused(true);
  sug.gate.resolve();
  await sleep(100);
  eng.setPaused(false);
  await sleep(300);
  assert.equal(sug.calls.length, 1);
  assert.equal(rec.count(K.SuggestEnd), 0);
});

test('pausing drops what was waiting to be sent, and requests work again after resuming', async () => {
  const { eng, sug, rec } = make({ tweak: { debounceMs: 200 } });
  eng.addTurn(Speaker.Them, 'Can you tell me about your last project?');
  eng.setPaused(true);
  await sleep(400);
  assert.equal(sug.calls.length, 0);
  eng.setPaused(false);
  eng.request();
  await rec.waitFor(K.SuggestEnd);
  assert.equal(sug.calls.length, 1);
  assert.equal(sug.calls[0].trigger, Trigger.Manual);
});

test('with Type off the region is not watched or sent; picked later it is remembered but not watched', async () => {
  const { eng, sug, rec } = make({ withRegion: true });
  const w = FakeWatcher.instances.at(-1);
  eng.setTextEnabled(false);
  assert.equal(w.disposed, true);
  eng.setRegion(AREA);
  assert.equal(eng.isWatching, false);
  eng.onScreenChanged();
  assert.equal(eng.panic(), false);
  eng.request(Trigger.Speech);
  await rec.waitFor(K.SuggestEnd);
  assert.equal(sug.calls.length, 1);
  assert.equal(sug.calls[0].regionImage, null);
  eng.setTextEnabled(true);
  assert.equal(eng.panic(), true);
  await rec.waitFor(K.SuggestEnd, 2);
  assert.ok(sug.calls[1].regionImage);
});

test('turning Type off drops a pending text trigger but keeps speech', async () => {
  const { eng, sug, rec } = make({ tweak: { debounceMs: 200 }, withRegion: true });
  eng.onScreenChanged();
  eng.addTurn(Speaker.Them, 'Did you get my message about the schedule?');
  eng.setTextEnabled(false);
  await rec.waitFor(K.SuggestEnd);
  assert.equal(sug.calls[0].trigger, Trigger.Speech);
});

test('turning Type off cancels a lone pending text trigger', async () => {
  const { eng, sug } = make({ tweak: { debounceMs: 150 }, withRegion: true });
  eng.onScreenChanged();
  eng.setTextEnabled(false);
  await sleep(400);
  assert.equal(sug.calls.length, 0);
});

// -- web-specific: pictures --------------------------------------------------------------------------------------

test('a photo is dropped from memory once the request that used it has finished (never kept, never resent)', async () => {
  const capture = new FakeCapture();
  const { eng, sug, rec } = make({ capture, withRegion: true });
  eng.request(Trigger.Text | Trigger.Manual, null, 0, true);
  await rec.waitFor(K.SuggestEnd);
  assert.equal(sug.calls[0].regionImage !== null, true);
  assert.equal(capture.released, 1);
});

test('a superseded request does not release the photo (the next one still needs it)', async () => {
  const sug = Object.assign(new FakeSuggester(), { gate: deferred() });
  const capture = new FakeCapture();
  const { eng, rec } = make({ tweak: { debounceMs: 0 }, sug, capture, withRegion: true });
  eng.onScreenChanged();
  await sug.firstChunkSent.promise;
  eng.addTurn(Speaker.Them, 'Hey, are you still there with us on the call?');
  assert.equal(capture.released, 0);
  sug.gate.resolve();
  await rec.waitFor(K.SuggestEnd);
  assert.equal(capture.released, 1);
});

test('a text-only model gets the "can\'t read pictures" message instead of a picture it cannot use', async () => {
  const settings = { ...useProvider(defaultSettings(), Provider.Nvidia) };
  const { eng, sug, rec } = make({ settings, withRegion: true });
  eng.onScreenChanged();
  await rec.waitFor(K.Error);
  await sleep(100);
  assert.equal(sug.calls.length, 0);
  assert.ok(rec.events.some((e) => e.kind === K.Error && /meta\/llama-3\.3-70b-instruct.*can't read pictures, so Type can't use it/.test(e.text)));
  // speech still works, without the picture
  eng.addTurn(Speaker.Them, 'Did you get my message about the schedule?');
  await rec.waitFor(K.SuggestEnd);
  assert.equal(sug.calls[0].regionImage, null);
});

test('Fast screen reading sends the words, and skips a repeat of the same words', async () => {
  const reads = ['Alice: are you free at 3?', '  Alice:   are you free at 3? ', 'Alice: are you free at 3? Bob: yes'];
  let n = 0;
  const textReader = { isAvailable: true, read: async () => reads[n++] };
  const settings = { ...defaultSettings(), screenReading: 'Fast' };
  const { eng, sug, rec } = make({ textReader, settings, withRegion: true });
  eng.onScreenChanged(); await rec.waitFor(K.SuggestEnd, 1);
  eng.onScreenChanged(); await sleep(300);
  assert.equal(sug.calls.length, 1); // same words: nothing new to answer
  eng.onScreenChanged(); await rec.waitFor(K.SuggestEnd, 2);
  assert.equal(sug.calls[0].regionText, 'Alice: are you free at 3?');
  assert.equal(sug.calls[0].regionImage, null);
  assert.equal(sug.calls[1].regionText, 'Alice: are you free at 3? Bob: yes');
});

test('live words, who is speaking, and events', () => {
  const { eng, rec } = make();
  eng.setLive(Speaker.Them, '  hello th ');
  assert.equal(eng.liveText(Speaker.Them), 'hello th');
  eng.setLive(Speaker.Them, 'hello th');
  assert.equal(rec.count(K.Live), 1); // unchanged: no event
  eng.setSpeaking(Speaker.Me, true);
  assert.equal(eng.hearingWho, Speaker.Me);
  eng.setSpeaking(Speaker.Them, true);
  assert.equal(eng.hearingWho, Speaker.Them);
  eng.setPaused(true);
  assert.equal(eng.hearingWho, null);
  assert.equal(eng.liveText(Speaker.Them), null);
});
