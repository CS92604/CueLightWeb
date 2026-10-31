import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Conversation, Speaker } from '../src/js/core/conversation.js';

test('render labels and merges the same speaker', () => {
  const c = new Conversation();
  c.add(Speaker.Them, 'Hi there.'); c.add(Speaker.Them, 'How are you?'); c.add(Speaker.Me, 'Good, thanks.');
  assert.equal(c.render(1000), 'Them: Hi there. How are you?\nMe: Good, thanks.');
});

test('render drops the oldest whole turns, and always keeps the latest', () => {
  const c = new Conversation();
  c.add(Speaker.Them, 'a'.repeat(50)); c.add(Speaker.Me, 'b'.repeat(50)); c.add(Speaker.Them, 'c'.repeat(50));
  const lines = c.render(80).split('\n');
  assert.equal(lines[0], '[earlier conversation omitted]');
  assert.ok(lines.at(-1).endsWith('c'.repeat(50)));
  assert.ok(!lines.some((l) => l.includes('a'.repeat(50))));
  const one = new Conversation(); one.add(Speaker.Them, 'x'.repeat(500));
  assert.ok(one.render(10).endsWith('x'.repeat(500)));
});

test('blank text is ignored', () => {
  const c = new Conversation(); c.add(Speaker.Them, '   ');
  assert.equal(c.isEmpty, true);
});

test('a long call is limited to the recent part (30,000 max), and starts with the omitted notice', () => {
  const c = new Conversation();
  for (let i = 0; i < 1000; i++) c.add(i % 2 === 0 ? Speaker.Them : Speaker.Me, `Turn number ${i} with a sentence of ordinary speech in it, about this long.`);
  const text = c.window(30_000, 20_000);
  assert.ok(text.length <= 30_000, `${text.length} characters`);
  assert.ok(text.startsWith('[earlier conversation omitted]'));
  assert.ok(!text.includes('Turn number 0 ') && text.includes('Turn number 999 '));
});

test('windowing trims in jumps: the start stays put between requests until the limit is passed again', () => {
  const c = new Conversation();
  for (let i = 0; i < 100; i++) c.add(i % 2 === 0 ? Speaker.Them : Speaker.Me, `T${String(i).padStart(3, '0')} ` + 'x'.repeat(95));
  const first = c.window(5000, 3000);
  const firstTurn = first.split('\n')[1];
  assert.ok(first.length <= 5000 && first.length > 2500 && first.length < 3200, `${first.length}`);
  for (let i = 100; i < 115; i++) { // a little more talk: not enough to pass the limit again
    c.add(i % 2 === 0 ? Speaker.Them : Speaker.Me, `T${i} ` + 'x'.repeat(95));
    assert.equal(c.window(5000, 3000).split('\n')[1], firstTurn);
  }
  for (let i = 115; i < 160; i++) c.add(i % 2 === 0 ? Speaker.Them : Speaker.Me, `T${i} ` + 'x'.repeat(95));
  const later = c.window(5000, 3000);
  assert.notEqual(later.split('\n')[1], firstTurn);
  assert.ok(later.length <= 5000);
});

test('a monologue keeps only its latest 5,000 characters, and the newest turn is never dropped', () => {
  const c = new Conversation();
  c.add(Speaker.Them, 'start ' + 'y'.repeat(9000) + ' end');
  const w = c.window(100, 50);
  assert.ok(w.startsWith('Them: … ') && w.endsWith(' end'));
  assert.ok(w.length < 5020);
});

test('clear forgets the window floor', () => {
  const c = new Conversation();
  for (let i = 0; i < 60; i++) c.add(i % 2 ? Speaker.Me : Speaker.Them, 'z'.repeat(100) + i);
  c.window(1000, 500);
  c.clear();
  assert.equal(c.window(1000, 500), '');
  c.add(Speaker.Them, 'fresh');
  assert.equal(c.window(1000, 500), 'Them: fresh');
});
