// What a visitor sees on the repository's front page and in the built page: no broken links, the community and legal files
// are there, nothing that looks like a secret is committed, and the page keeps its promises (no inline script or style, no
// outside scripts, nothing sent anywhere but the AI provider).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const SKIP = new Set(['node_modules', '.git', '_site', 'smoke-shots']);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full); else yield full;
  }
}
const code = (f) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n'); // without comments
const files = (...exts) => [...walk(root)].filter((f) => exts.includes(path.extname(f).toLowerCase()));
const rel = (f) => path.relative(root, f).split(path.sep).join('/');

test('the community and legal files are present', () => {
  for (const f of ['LICENSE', 'README.md', 'SECURITY.md', 'THIRD-PARTY-NOTICES.md', '.gitignore', 'package-lock.json', '.github/workflows/pages.yml', 'src/index.html', 'src/manifest.webmanifest'])
    assert.ok(fs.existsSync(path.join(root, f)), `${f} is missing`);
  assert.match(read('LICENSE'), /^MIT License/);
});

for (const doc of ['README.md', 'SECURITY.md', 'THIRD-PARTY-NOTICES.md']) {
  test(`every relative link and picture in ${doc} points at a file that exists`, () => {
    const text = read(doc);
    const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).concat([...text.matchAll(/src="([^"]+)"/g)].map((m) => m[1]))
      .filter((t) => !/^([a-z][a-z0-9+.-]*:|#)/i.test(t)).map((t) => t.split('#')[0]).filter(Boolean);
    for (const t of new Set(targets)) assert.ok(fs.existsSync(path.join(root, t)), `${doc} points at ${t}, which doesn't exist`);
  });
}

test('every in-page link in the README matches a heading', () => {
  const text = read('README.md');
  const slug = (h) => h.trim().toLowerCase().replace(/ /g, '-').replace(/[^a-z0-9_-]/g, '');
  const headings = new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])));
  for (const a of new Set([...text.matchAll(/\]\(#([^)\s]+)\)/g)].map((m) => m[1]))) assert.ok(headings.has(a), `the README links to #${a}, but no heading has that name`);
});

test('every package the site ships is covered by the third-party notices', () => {
  const notices = read('THIRD-PARTY-NOTICES.md').toLowerCase();
  const pkg = JSON.parse(read('package.json'));
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    const bare = name.replace(/^@[^/]+\//, '');
    assert.ok(notices.includes(name.toLowerCase()) || notices.includes(bare.toLowerCase()), `${name} isn't mentioned in THIRD-PARTY-NOTICES.md`);
  }
  for (const needle of ['transformers.js', 'onnx runtime', 'tesseract', 'whisper', 'inter', 'young serif']) assert.ok(notices.includes(needle), needle);
});

test('nothing that looks like an API key, a token or a personal address is committed', () => {
  const patterns = [
    ['an Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/], ['an OpenAI key', /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/], ['a Google key', /AIza[0-9A-Za-z_-]{30,}/],
    ['an NVIDIA key', /nvapi-[A-Za-z0-9_-]{20,}/], ['an xAI key', /xai-[A-Za-z0-9]{20,}/], ['a GitHub token', /\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/],
    ['a Hugging Face token', /\bhf_[A-Za-z0-9]{30,}/], ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['a personal e-mail address', /[A-Za-z0-9._%+-]+@(gmail|outlook|hotmail|yahoo|icloud|proton|protonmail)\.[a-z]{2,}/i],
    ["a path on someone's computer", /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\|\/home\/[a-z][a-z0-9_-]*\/|\/Users\/[A-Za-z0-9._-]+\//],
  ];
  // The tests and the smoke test hold made-up keys on purpose (short ones, and this very list), so they are not scanned.
  const scanned = files('.js', '.mjs', '.html', '.css', '.md', '.yml', '.json', '.webmanifest', '.txt', '.svg')
    .filter((f) => !rel(f).startsWith('tests/') && !rel(f).startsWith('smoke/') && rel(f) !== 'package-lock.json');
  assert.ok(scanned.length > 25, 'the scan should cover the whole source');
  for (const f of scanned) {
    const text = fs.readFileSync(f, 'utf8');
    for (const [name, re] of patterns) assert.equal(re.test(text), false, `${rel(f)} looks like it contains ${name}`);
  }
  // the lock file is long: only the secret patterns apply to it
  for (const [name, re] of patterns.slice(0, 8)) assert.equal(re.test(read('package-lock.json')), false, `package-lock.json looks like it contains ${name}`);
});

test('the page sets the Content Security Policy it promises, with no inline script or style and no outside scripts', () => {
  const html = read('src', 'index.html');
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
  assert.ok(csp, 'no Content Security Policy meta tag');
  const d = Object.fromEntries(csp.split(';').map((x) => x.trim()).filter(Boolean).map((x) => { const [k, ...v] = x.split(/\s+/); return [k, v]; }));
  assert.deepEqual(d['script-src'], ["'self'", "'wasm-unsafe-eval'"]);
  assert.deepEqual(d['style-src'], ["'self'"]);
  assert.deepEqual(d['worker-src'], ["'self'", 'blob:']);
  assert.ok(['https:', 'http://localhost:*', 'http://127.0.0.1:*'].every((s) => d['connect-src'].includes(s)), d['connect-src'].join(' '));
  assert.equal(d['default-src'].join(' '), "'none'");
  assert.equal(/unsafe-inline|unsafe-eval/.test(csp.replace('wasm-unsafe-eval', '')), false);
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'), 'the policy must come before the first script');
  assert.equal(/<script(?![^>]*\ssrc=)[^>]*>/i.test(html), false, 'an inline script');
  assert.equal(/<style[\s>]/i.test(html) || /\sstyle\s*=/i.test(html), false, 'inline style');
  assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'an inline event handler');
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^(https?:|#|mailto:)/.test(m[1])) { assert.match(m[1], /^#/, `index.html loads or links ${m[1]}`); continue; }
    assert.ok(fs.existsSync(path.join(root, 'src', m[1])) || m[1].startsWith('js/') === false && false, `${m[1]} is referenced but missing`);
  }
});

test('our own code loads nothing from a CDN, uses no inline styles, and sends nothing anywhere but through the suggesters', () => {
  const own = files('.js', '.css', '.html', '.webmanifest').filter((f) => rel(f).startsWith('src/'));
  assert.ok(own.length > 30);
  for (const f of own) {
    const text = fs.readFileSync(f, 'utf8');
    assert.equal(/(https?:)?\/\/[^\s'"`)]*(cdn|unpkg|jsdelivr|cdnjs|gstatic|fonts\.googleapis|cloudflare)/i.test(text), false, `${rel(f)} mentions a CDN`);
    if (f.endsWith('.js')) {
      assert.equal(/setAttribute\(\s*['"]style['"]|\.cssText|insertAdjacentHTML|document\.write|\beval\(|new Function\(/.test(text), false, `${rel(f)} does something the policy forbids`);
      assert.equal(/XMLHttpRequest|sendBeacon|new WebSocket|new EventSource|gtag\(|google-analytics|googletagmanager|sentry|mixpanel|plausible|posthog|amplitude/i.test(text), false, `${rel(f)} could send data somewhere`);
      assert.equal(/\.innerHTML\s*=/.test(text), false, `${rel(f)} sets innerHTML`);
    }
  }
  const fetchers = own.filter((f) => f.endsWith('.js') && /[^.\w]fetch\(|fetchImpl\(/.test(code(f))).map(rel).sort();
  assert.deepEqual(fetchers, ['src/js/suggest/http.js'], 'only the suggesters\' http helper may call fetch');
});

test('keys are only touched in keys.js; nothing else reads or writes browser storage', () => {
  const users = files('.js').filter((f) => rel(f).startsWith('src/js/') && /localStorage|sessionStorage/.test(fs.readFileSync(f, 'utf8'))).map(rel);
  assert.deepEqual(users, ['src/js/keys.js']);
});

test('every relative import in the source points at a file that exists', () => {
  for (const f of files('.js').filter((x) => rel(x).startsWith('src/js/'))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/(?:from\s+|import\()\s*['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(f), m[1]);
      if (m[1].includes('/vendor/')) { assert.ok(/vendor\/(transformers\.min|tesseract\/tesseract\.esm\.min)\.js$/.test(m[1]), `${rel(f)} imports ${m[1]}`); continue; } // made by the build
      assert.ok(fs.existsSync(target), `${rel(f)} imports ${m[1]}, which doesn't exist`);
    }
  }
});

test('the web app manifest is valid and its icons exist', () => {
  const m = JSON.parse(read('src', 'manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some((i) => i.sizes === '192x192') && m.icons.some((i) => i.sizes === '512x512') && m.icons.some((i) => i.purpose === 'maskable'));
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(root, 'src', i.src)), i.src);
  assert.ok(fs.existsSync(path.join(root, 'src', 'icons', 'icon-180.png')), 'apple-touch-icon');
});

test('the build vendors what the page imports, and the workflow tests and deploys the Pages artifact', () => {
  const build = read('scripts', 'build.mjs');
  for (const needle of ['transformers.min.js', 'ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.wasm', 'inter-latin-wght-normal.woff2', 'young-serif-latin-400-normal.woff2', '.nojekyll'])
    assert.ok(build.includes(needle), `build.mjs doesn't copy ${needle}`);
  const wf = read('.github', 'workflows', 'pages.yml');
  for (const needle of ['npm ci', 'npm test', 'npm run build', 'actions/upload-pages-artifact', 'actions/deploy-pages', 'pages: write', 'id-token: write', 'refs/heads/main'])
    assert.ok(wf.includes(needle), `pages.yml is missing ${needle}`);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies['@huggingface/transformers'], '4.3.2');
  assert.ok(Object.values(pkg.dependencies).every((v) => /^\d/.test(v)), 'dependencies are pinned to exact versions');
});

test('the worker names the whisper models and the runtime files the build ships', () => {
  const worker = read('src', 'js', 'stt', 'worker.js');
  assert.ok(worker.includes('ort-wasm-simd-threaded.asyncify') && worker.includes("'ort-wasm-simd-threaded'"));
  const whisper = read('src', 'js', 'stt', 'whisper.js');
  for (const id of ['onnx-community/whisper-tiny.en', 'onnx-community/whisper-base.en', 'onnx-community/whisper-small.en']) assert.ok(whisper.includes(id), id);
});
