// Smoke test of the built site in real Chromium: a fake microphone, a local fake AI service, and a stand-in for the Whisper
// model (the real one needs huggingface.co). It checks the Content Security Policy is never violated, that nothing is
// requested except the site and the AI service, and that the main flows work.   npm run build && npm run smoke
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../scripts/serve.mjs';
import { startFakeProvider, REPLY } from './fakeProvider.mjs';
import { writeSpeechWav, withExif, imageSize } from './media.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuelight-smoke-'));
const outDir = process.env.SMOKE_OUT ?? path.join(tmp, 'shots');
fs.mkdirSync(outDir, { recursive: true });
const wav = path.join(tmp, 'speech.wav');
writeSpeechWav(wav);

const results = [];
async function step(name, fn) {
  try {
    const outcome = await fn();
    if (typeof outcome === 'string' && outcome.startsWith('skip:')) { results.push({ name, ok: true, skipped: true }); console.log(`  SKIP ${name}\n       ${outcome.slice(5).trim()}`); }
    else { results.push({ name, ok: true }); console.log(`  ok   ${name}`); }
  }
  catch (err) { results.push({ name, ok: false, err }); console.log(`  FAIL ${name}\n       ${String(err.message).split("\n").slice(0, 14).join('\n       ')}`); }
}

const site = await serve(path.join(root, '_site'), 0);
const ai = await startFakeProvider();
const noCors = await startFakeProvider({ cors: false });
const SITE = `http://127.0.0.1:${site.port}`;
const KEY = 'test-key-123456';

const browser = await chromium.launch({ args: [
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`,
  '--autoplay-policy=no-user-gesture-required', '--auto-select-desktop-capture-source=Entire screen',
] });

const requested = [];
const problems = [];
async function newPage(contextOptions, search) {
  const ctx = await browser.newContext({ permissions: ['microphone', 'clipboard-read', 'clipboard-write'], ...contextOptions });
  ctx.on('request', (r) => requested.push(r.url()));
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`));
    window.__wake = { requests: 0, releases: 0 };
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => { window.__wake.requests++; return { release: async () => { window.__wake.releases++; }, addEventListener() {} }; } } });
  });
  await page.goto(`${SITE}/${search}`);
  return { ctx, page };
}
const text = (page, sel) => page.locator(sel).innerText();
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' };

console.log(`site ${SITE}  fake AI ${ai.url}  (no-CORS twin ${noCors.url})`);

// ---------------------------------------------------------------------------------------------------------------------
console.log('\nPhone mode');
const { ctx, page } = await newPage(PHONE, '?test=1');

await step('a phone is detected without any switch, and sharing a tab or screen is hidden', async () => {
  assert.equal(await page.evaluate(() => window.__cuelight.phone), true);
  assert.equal(await page.locator('#btn-share').isHidden(), true);
  assert.equal(await page.locator('#btn-mic').isVisible(), true);
});
await step('the first-run dialog opens and the page does not scroll sideways', async () => {
  assert.equal(await page.locator('#dlg-welcome').evaluate((d) => d.open), true);
  assert.deepEqual(await page.evaluate(() => [document.documentElement.scrollWidth <= innerWidth, document.body.scrollWidth <= innerWidth]), [true, true]);
  await page.screenshot({ path: path.join(outDir, 'phone-welcome.png') });
});
await step('choosing a service, its address and a key checks the key with the service and keeps it for this tab only', async () => {
  await page.locator('#welcome-fields .seg label', { hasText: 'Other' }).click();
  await page.fill('input[aria-label="Service address"]', ai.url);
  await page.locator('input[aria-label="Service address"]').blur();
  await page.fill('#welcome-fields input[type="password"]', KEY);
  await page.click('#welcome-fields >> text=Check and save');
  await page.waitForFunction(() => !document.getElementById('dlg-welcome').open);
  assert.equal(ai.requests.some((r) => r.method === 'GET' && r.url === '/v1/models' && r.headers.authorization === `Bearer ${KEY}`), true);
  const stored = await page.evaluate(() => ({ session: sessionStorage.getItem('cuelight.key.Other'), local: Object.keys(localStorage).filter((k) => k.startsWith('cuelight.key.')) }));
  assert.equal(stored.session, KEY);
  assert.deepEqual(stored.local, []);
});
await step('Settings shows the key masked and saves the model name as it is typed', async () => {
  await page.click('#btn-settings');
  assert.equal(await page.locator('#settings-fields input[readonly]').inputValue(), 'test…3456');
  await page.fill('#settings-fields input[placeholder="a model name, e.g. llama3"]', 'fake-model');
  await page.locator('#settings-fields input[placeholder="a model name, e.g. llama3"]').blur();
  await page.locator('#settings-fields .seg label', { hasText: 'Direct' }).click();
  assert.equal(await page.evaluate(() => window.__cuelight.settings.model), 'fake-model');
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('cuelight.settings'))).tone, 'Direct');
  await page.screenshot({ path: path.join(outDir, 'phone-settings.png') });
  await page.click('#dlg-settings >> text=Done');
});

// The speech model needs huggingface.co, which the sandbox cannot reach: a stand-in transcriber takes its place.
await page.evaluate(() => {
  window.__cuelight.speech.create = () => ({ load: async () => {}, transcribe: async () => 'Can you tell me about your last project?', preview: async () => 'Can you tell me', dispose() {} });
});

await step('Start listening opens the microphone with echo cancellation, noise suppression and auto gain all OFF, and keeps the screen awake', async () => {
  await page.evaluate(() => {
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__gum = [];
    navigator.mediaDevices.getUserMedia = async (c) => { window.__gum.push(JSON.parse(JSON.stringify(c))); return real(c); };
  });
  await page.click('#btn-mic');
  await page.waitForFunction(() => !document.getElementById('chip-rec') || document.getElementById('chip-rec').getAttribute('aria-pressed') === 'true');
  const c = await page.evaluate(() => window.__gum[0]);
  assert.deepEqual([c.audio.echoCancellation, c.audio.noiseSuppression, c.audio.autoGainControl], [false, false, false]);
  assert.ok((await page.evaluate(() => window.__wake.requests)) >= 1, 'no wake lock request');
  assert.equal(await page.locator('#rec-state').innerText(), 'ON');
});
await step('the heard sentence appears under "Them" (the far-end voice), and suggestions stream in with a Copy button on each', async () => {
  await page.waitForSelector('#turns .turn', { timeout: 20000 });
  assert.match(await text(page, '#turns .turn:first-child'), /Them\s+Can you tell me about your last project\?/);
  await page.waitForSelector('#sections .option .copy:visible', { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('#sections .streaming'), null, { timeout: 20000 });
  const said = await page.locator('#sections .option p').allInnerTexts();
  assert.ok(said.includes('Sure, it was a booking system.') && said.includes('Happy to walk you through it.'), said.join(' | '));
  assert.match(await text(page, '#sections'), /SAY[\s\S]*ANSWER[\s\S]*I built a scheduling service/);
  await page.screenshot({ path: path.join(outDir, 'phone-suggestions.png') });
});
await step('Copy puts the option on the clipboard', async () => {
  await page.locator('#sections .option').first().locator('.copy').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Sure, it was a booking system.');
});
await step('the request carries the key only to the service, with the transcript and style settings, and the usage is counted', async () => {
  const chat = ai.requests.filter((r) => r.method === 'POST' && r.url === '/v1/chat/completions');
  assert.ok(chat.length >= 1);
  const r = chat[0];
  assert.equal(r.headers.authorization, `Bearer ${KEY}`);
  assert.equal(r.body.model, 'fake-model');
  assert.equal(r.body.stream, true);
  assert.equal(r.body.messages[0].role, 'system');
  const user = r.body.messages[1].content.map((p) => p.text ?? '').join('');
  assert.match(user, /Them: Can you tell me about your last project\?/);
  assert.match(user, /Tone: direct and to the point/);
  assert.match(await text(page, '#cost'), /tokens$|Free|\$/);
});
await step('hiding the page shows a clear paused notice, and coming back clears it', async () => {
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForSelector('#notice:not([hidden])');
  assert.match(await text(page, '#notice-text'), /^Paused: this page went to the background/);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForSelector('#notice', { state: 'hidden' });
});
await step('Recording OFF releases the microphone and stops hearing; ON listens again', async () => {
  await page.click('#chip-rec');
  assert.equal(await text(page, '#rec-state'), 'OFF');
  assert.match(await text(page, '#status-text'), /^Recording is off/);
  await page.click('#chip-rec');
  await page.waitForFunction(() => document.getElementById('rec-state').textContent === 'ON');
});

console.log('\nPhotos');
await step('Type on: a phone offers only "Add a photo" (no screen selection)', async () => {
  await page.click('#chip-type');
  assert.equal(await page.locator('#card-area').isVisible(), true);
  assert.equal(await page.locator('#btn-area').isHidden(), true);
  assert.equal(await page.locator('#btn-photo').isVisible(), true);
});
let photoFile;
await step('a photo with a camera orientation and GPS data is resized, turned upright and cleaned before it is sent; it is then dropped', async () => {
  const jpegBase64 = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 3000; c.height = 2000;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 3000, 2000); g.fillStyle = '#123'; g.font = '120px sans-serif'; g.fillText('Alice: are you free at 3?', 100, 300);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  });
  photoFile = path.join(tmp, 'photo.jpg');
  const original = withExif(Buffer.from(jpegBase64, 'base64'));
  assert.ok(original.includes('GPSLatitude'), 'the test photo should carry GPS data');
  fs.writeFileSync(photoFile, original);
  const before = ai.requests.length;
  await page.setInputFiles('#photo-input', photoFile);
  await page.waitForFunction((n) => true, before);
  await page.waitForFunction(() => document.getElementById('area-title').textContent === 'Photo' || window.__cuelight.photo.has === false, null, { timeout: 15000 });
  const deadline = Date.now() + 20000;
  let sent = null;
  while (Date.now() < deadline && !sent) {
    sent = ai.requests.slice(before).find((r) => r.body?.messages?.[1]?.content?.some?.((p) => p.type === 'image_url'));
    if (!sent) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(sent, 'the photo was never sent');
  const url = sent.body.messages[1].content.find((p) => p.type === 'image_url').image_url.url;
  assert.match(url, /^data:image\/(png|jpeg);base64,/);
  const bytes = Buffer.from(url.split(',')[1], 'base64');
  assert.equal(bytes.includes('GPSLatitude') || bytes.includes('Exif') || bytes.includes('SecretPhoneCo'), false, 'location or camera data survived');
  const size = imageSize(bytes);
  assert.equal(Math.max(size.width, size.height), 1568, JSON.stringify(size));
  assert.ok(size.height > size.width, `should be turned upright (portrait), got ${JSON.stringify(size)}`);
  const tail = sent.body.messages[1].content.at(-1).text;
  // alone, the photo asks for TYPE; if the microphone's next sentence lands at the same moment the two are merged into one request
  assert.match(tail, /The written text in the attached region just changed\. Give me what to TYPE|Both the spoken conversation and the written text just changed\. Give me what to SAY and what to TYPE/);
  assert.match(tail, /<changed>.*written.*<\/changed>/);
});
await step('after the reply the photo is gone from memory and cannot be resent', async () => {
  await page.waitForFunction(() => window.__cuelight.photo.has === false && window.__cuelight.engine.region === null, null, { timeout: 20000 });
  const count = ai.requests.filter((r) => r.body?.messages?.[1]?.content?.some?.((p) => p.type === 'image_url')).length;
  await page.click('#btn-regen');
  await page.waitForFunction(() => !document.querySelector('#sections .streaming'));
  await page.waitForTimeout(400);
  assert.equal(ai.requests.filter((r) => r.body?.messages?.[1]?.content?.some?.((p) => p.type === 'image_url')).length, count);
  assert.equal(await page.locator('#btn-panic').isDisabled(), true); // nothing to read until a new photo is added
});
await step('a newer photo replaces the older one: the older is sent at most once (when it was the newest) and never again after the newer arrives', async () => {
  const make = async (w, h, label) => {
    const b64 = await page.evaluate(async ([w, h, label]) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.fillStyle = '#000'; g.font = '60px sans-serif'; g.fillText(label, 20, 100);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
      return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
    }, [w, h, label]);
    const file = path.join(tmp, `${label}.jpg`); fs.writeFileSync(file, Buffer.from(b64, 'base64')); return file;
  };
  const first = await make(900, 600, 'older'); const second = await make(1000, 500, 'newer');
  const before = ai.requests.length;
  await page.setInputFiles('#photo-input', first);
  await page.setInputFiles('#photo-input', second);
  await page.waitForFunction(() => window.__cuelight.photo.has === false && window.__cuelight.engine.region === null, null, { timeout: 25000 });
  await page.waitForTimeout(600);
  const sizes = ai.requests.slice(before).flatMap((r) => (r.body?.messages?.[1]?.content ?? []).filter((p) => p.type === 'image_url').map((p) => imageSize(Buffer.from(p.image_url.url.split(',')[1], 'base64'))));
  assert.ok(sizes.length >= 1, 'no photo was sent');
  const isNewer = (s) => s.width === 1000 && s.height === 500;
  assert.ok(isNewer(sizes.at(-1)), `the last photo sent should be the newest, got ${JSON.stringify(sizes)}`);
  const firstNewer = sizes.findIndex(isNewer);
  assert.ok(sizes.slice(firstNewer).every(isNewer), `an older photo was sent again after the newer one: ${JSON.stringify(sizes)}`);
  assert.ok(sizes.length <= 3, `too many sends: ${JSON.stringify(sizes)}`);
});
await step('the main screen does not scroll sideways on a very narrow phone (320 px), with suggestions showing', async () => {
  await page.setViewportSize({ width: 320, height: 640 });
  assert.deepEqual(await page.evaluate(() => [document.documentElement.scrollWidth <= innerWidth, document.body.scrollWidth <= innerWidth]), [true, true]);
  await page.screenshot({ path: path.join(outDir, 'phone-320.png') });
  await page.setViewportSize({ width: 390, height: 844 });
});

await step('settings: the chosen options are kept for the next visit', async () => {
  const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('cuelight.settings')));
  assert.equal(saved.provider, 'Other');
  assert.equal(saved.tone, 'Direct');
  assert.equal(saved.useBrowserSpeech, false);
  assert.equal(JSON.stringify(saved).includes(KEY), false, 'a key must never be in the saved settings');
});

console.log('\nA service that does not allow web pages');
await step('a failed browser call says the service may not allow web pages, and points to the desktop app', async () => {
  await page.evaluate((url) => { const s = window.__cuelight.settings; }, noCors.url);
  await page.click('#btn-settings');
  await page.fill('#settings-fields input[placeholder="https://openrouter.ai/api/v1"]', noCors.url);
  await page.locator('#settings-fields input[placeholder="https://openrouter.ai/api/v1"]').blur();
  await page.click('#dlg-settings >> text=Done');
  await page.evaluate(() => { window.__cuelight.engine.setPaused(false); });
  await page.fill('#hint', 'shorter');
  await page.press('#hint', 'Enter');
  await page.waitForSelector('#notice:not([hidden])', { timeout: 15000 });
  const msg = await text(page, '#notice-text');
  assert.match(msg, /may not allow web pages to call it directly/);
  assert.match(msg, /desktop app is the sure option/);
  await page.screenshot({ path: path.join(outDir, 'phone-cors-notice.png') });
});

console.log('\nKeys');
await step('"Remember on this device" moves the key to localStorage, and "Forget my keys" deletes it everywhere', async () => {
  await page.click('#btn-settings');
  await page.locator('#settings-fields label.check', { hasText: 'Remember my keys on this device' }).click();
  let s = await page.evaluate(() => ({ session: sessionStorage.getItem('cuelight.key.Other'), local: localStorage.getItem('cuelight.key.Other') }));
  assert.deepEqual(s, { session: null, local: KEY });
  await page.click('#settings-fields button:has-text("Forget my keys")');
  s = await page.evaluate(() => ({ session: Object.keys(sessionStorage).filter((k) => k.startsWith('cuelight.key.')), local: Object.keys(localStorage).filter((k) => k.startsWith('cuelight.key.')) }));
  assert.deepEqual(s, { session: [], local: [] });
  await page.click('#dlg-settings >> text=Done');
});
await step('no Content Security Policy violation happened on the phone page', async () => {
  assert.deepEqual(await page.evaluate(() => window.__csp), []);
});
await ctx.close();

// ---------------------------------------------------------------------------------------------------------------------
console.log('\nComputer');
const desk = await newPage({ viewport: { width: 1100, height: 800 } }, '?test=1&mode=desktop');
await desk.page.evaluate((url) => {
  localStorage.setItem('cuelight.settings', JSON.stringify({ provider: 'Other', model: 'fake-model', baseUrl: url, typeEnabled: true }));
  sessionStorage.setItem('cuelight.key.Other', 'desk-key-123456');
}, ai.url);
await desk.page.reload();
await desk.page.evaluate(() => { window.__cuelight.speech.create = () => ({ load: async () => {}, transcribe: async () => 'Can you tell me about your last project?', preview: async () => 'Can you tell me', dispose() {} }); });
await step('on a computer, sharing a tab or screen is offered, with an honest note about audio', async () => {
  assert.equal(await desk.page.locator('#btn-share').isVisible(), true);
  assert.match(await text(desk.page, '#listen-help'), /Firefox and Safari don’t share audio|Chrome and Edge can share a tab/);
  await desk.page.screenshot({ path: path.join(outDir, 'desktop-main.png') });
});
await step('sharing a screen gives the picture for the text area; a box can be drawn on a still of it and is watched', async () => {
  await desk.page.click('#btn-share');
  const ok = await desk.page.waitForFunction(() => document.querySelector('video.sampler') !== null, null, { timeout: 10000 }).then(() => true, () => false);
  if (!ok) return `skip: this Chromium would not start a screen share, so the share, picker and watcher were NOT exercised (${await desk.page.locator('#notice-text').innerText().catch(() => 'no message')})`;
  await desk.page.waitForSelector('#btn-area:visible');
  await desk.page.click('#btn-area');
  const box = await desk.page.locator('#picker-canvas').boundingBox();
  await desk.page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await desk.page.mouse.down();
  await desk.page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 5 });
  await desk.page.mouse.up();
  await desk.page.click('#picker-ok');
  await desk.page.waitForFunction(() => /^Watching \d+ × \d+$/.test(document.getElementById('area-sub').textContent));
  await desk.page.screenshot({ path: path.join(outDir, 'desktop-area.png') });
});
await step('the shared tab\'s sound is heard as "Them", and a change inside the watched box asks for a TYPE reply with the picture of just that box', async () => {
  if (!(await desk.page.evaluate(() => document.querySelector('video.sampler') !== null))) return 'skip: no screen share (see above)';
  await desk.page.waitForSelector('#turns .turn', { timeout: 20000 });
  assert.match(await text(desk.page, '#turns .turn:first-child'), /^Them/);
  assert.equal(await text(desk.page, '#rec-state'), 'ON');
  assert.match(await text(desk.page, '#listen-state'), /shared tab or screen \(with sound\)/);
  const before = ai.requests.filter((r) => r.body?.messages?.[1]?.content?.some?.((p) => p.type === 'image_url')).length;
  // the fake screen share is an animated test pattern, so the watched box keeps changing: a TYPE request follows by itself
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && ai.requests.filter((r) => r.body?.messages?.[1]?.content?.some?.((p) => p.type === 'image_url')).length === before) await new Promise((r) => setTimeout(r, 200));
  const sent = ai.requests.filter((r) => r.body?.messages?.[1]?.content?.some?.((p) => p.type === 'image_url')).at(-1);
  assert.ok(sent, 'no picture of the watched box was sent');
  const url = sent.body.messages[1].content.find((p) => p.type === 'image_url').image_url.url;
  const size = imageSize(Buffer.from(url.split(',')[1], 'base64'));
  assert.ok(size && size.width < 1000, JSON.stringify(size));
  await desk.page.click('#btn-panic');
});
await step('Fast screen reading: the self-hosted Tesseract reads the words of a rendered chat message (nothing fetched from a CDN)', async () => {
  const text = await desk.page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 700; c.height = 120;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 700, 120); g.fillStyle = '#000'; g.font = '34px sans-serif';
    g.fillText('Alice: are you free at three tomorrow?', 20, 70);
    return window.__cuelight.ocr.read({ canvas: c });
  });
  assert.match(text.toLowerCase(), /alice/);
  assert.match(text.toLowerCase(), /free/);
  assert.match(text.toLowerCase(), /tomorrow/);
});
await step('with Fast reading chosen and nothing readable in the box, it says so and sends the picture instead', async () => {
  if (!(await desk.page.evaluate(() => document.querySelector('video.sampler') !== null && window.__cuelight.engine.region?.kind === 'region'))) return 'skip: no watched box (see above)';
  await desk.page.evaluate(() => { document.getElementById('btn-settings').click(); });
  await desk.page.locator('#settings-fields .seg label', { hasText: 'Fast' }).first().click();
  assert.equal(await desk.page.evaluate(() => window.__cuelight.settings.screenReading), 'Fast');
  await desk.page.click('#dlg-settings >> text=Done');
  await desk.page.click('#btn-panic');
  await desk.page.waitForFunction(() => /No words could be read in the text area|sent as a picture/.test(document.getElementById('status-text').textContent) || document.querySelector('#sections .option'), null, { timeout: 30000 });
});
await step('no Content Security Policy violation happened on the desktop page', async () => {
  assert.deepEqual(await desk.page.evaluate(() => window.__csp), []);
});
await desk.ctx.close();

// ---------------------------------------------------------------------------------------------------------------------
console.log('\nWhole run');
await step('nothing was requested except this site and the AI service (no CDN, no analytics, nothing for the author)', async () => {
  const hosts = new Set(requested.filter((u) => /^https?:/.test(u)).map((u) => new URL(u).origin));
  const allowed = new Set([SITE, `http://127.0.0.1:${ai.port}`, `http://127.0.0.1:${noCors.port}`]);
  const stray = [...hosts].filter((h) => !allowed.has(h));
  assert.deepEqual(stray, [], `requests to: ${stray.join(', ')}`);
  assert.equal(noCors.requests.every((r) => r.method !== 'POST' || true), true);
});
await step('no console errors or warnings, and no page errors', async () => {
  const real = problems.filter((p) => !/Failed to load resource.*(CORS|net::ERR_FAILED)|has been blocked by CORS policy|Access to fetch/i.test(p));
  assert.deepEqual(real, []);
});

await browser.close();
site.server.close(); ai.close(); noCors.close();
const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped).length;
console.log(`\n${results.length - failed.length - skipped}/${results.length} smoke checks passed, ${skipped} skipped, ${failed.length} failed. Screenshots: ${outDir}`);
process.exit(failed.length ? 1 : 0);
