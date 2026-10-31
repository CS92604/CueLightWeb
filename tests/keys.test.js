import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyStore, SettingsStore, maskKey, memoryStorage } from '../src/js/keys.js';

const make = () => { const local = memoryStorage(); const session = memoryStorage(); return { local, session, store: new KeyStore({ local, session }) }; };

test('by default a key is kept for this tab only (sessionStorage), not on the device', () => {
  const { local, session, store } = make();
  assert.equal(store.remember, false);
  store.set('Claude', '  sk-ant-test-key  ');
  assert.equal(store.get('Claude'), 'sk-ant-test-key');
  assert.equal(session.getItem('cuelight.key.Claude'), 'sk-ant-test-key');
  assert.equal(local.getItem('cuelight.key.Claude'), null);
});

test('"remember on this device" keeps keys in localStorage, one per provider', () => {
  const { local, session, store } = make();
  store.setRemember(true);
  store.set('Claude', 'a'); store.set('OpenAi', 'b');
  assert.equal(local.getItem('cuelight.key.Claude'), 'a');
  assert.equal(local.getItem('cuelight.key.OpenAi'), 'b');
  assert.equal(session.getItem('cuelight.key.Claude'), null);
  assert.deepEqual(store.providersWithKeys(), ['Claude', 'OpenAi']);
});

test('turning the toggle moves existing keys and leaves none behind in the other storage', () => {
  const { local, session, store } = make();
  store.set('Grok', 'xai-1');
  store.setRemember(true);
  assert.equal(local.getItem('cuelight.key.Grok'), 'xai-1');
  assert.equal(session.getItem('cuelight.key.Grok'), null);
  assert.equal(store.get('Grok'), 'xai-1');
  store.setRemember(false);
  assert.equal(local.getItem('cuelight.key.Grok'), null);
  assert.equal(session.getItem('cuelight.key.Grok'), 'xai-1');
  assert.equal(store.get('Grok'), 'xai-1');
});

test('Forget my keys removes every key from both storages and keeps nothing', () => {
  const { local, session, store } = make();
  store.set('Claude', 'a');
  store.setRemember(true);
  store.set('Gemini', 'g');
  session.setItem('cuelight.key.Nvidia', 'stray');
  store.forgetAll();
  for (const s of [local, session]) for (let i = 0; i < s.length; i++) assert.ok(!s.key(i).startsWith('cuelight.key.'), s.key(i));
  assert.deepEqual(store.providersWithKeys(), []);
});

test('an empty key removes the saved one; remove() clears one provider', () => {
  const { store } = make();
  store.set('Claude', 'a'); store.set('Claude', '   ');
  assert.equal(store.has('Claude'), false);
  store.set('Grok', 'x'); store.remove('Grok');
  assert.equal(store.get('Grok'), null);
});

test('browser storage that throws (private window, blocked site data) falls back to memory instead of failing', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const store = new KeyStore({ local: broken, session: broken });
  store.set('Claude', 'k');
  assert.equal(store.get('Claude'), 'k');
  store.forgetAll();
  assert.equal(store.get('Claude'), null);
  const settings = new SettingsStore(broken);
  assert.equal(settings.save({ a: 1 }), true); // memory fallback
  assert.deepEqual(settings.load(), { a: 1 });
});

test('settings round-trip, and a missing or corrupt value means defaults', () => {
  const storage = memoryStorage();
  const s = new SettingsStore(storage);
  assert.equal(s.exists, false);
  assert.equal(s.load(), null);
  s.save({ tone: 'Direct' });
  assert.deepEqual(s.load(), { tone: 'Direct' });
  storage.setItem('cuelight.settings', '{broken');
  assert.equal(s.load(), null);
  storage.setItem('cuelight.settings', '"a string"');
  assert.equal(s.load(), null);
});

test('maskKey shows only the ends', () => {
  assert.equal(maskKey('sk-ant-1234567890abcdef'), 'sk-a…cdef');
  assert.equal(maskKey('short'), '•••••');
  assert.equal(maskKey(null), '');
});
