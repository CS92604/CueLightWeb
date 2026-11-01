// Builds the static site into _site/: copies src/, and vendors every library from node_modules (pinned by package-lock.json)
// so that the page loads nothing from a CDN. Run with: npm run build
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '_site');
const require = createRequire(path.join(root, 'package.json'));

const log = (...a) => console.log(...a);
const fail = (msg) => { console.error(`build: ${msg}`); process.exit(1); };

function pkgDir(name, from = require) {
  // Resolve a package's directory without relying on its "exports" map (many don't export package.json).
  for (const base of from.resolve.paths(name) ?? []) {
    const dir = path.join(base, name);
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  fail(`package ${name} is not installed: run npm ci`);
}

function copy(from, to) {
  if (!fs.existsSync(from)) fail(`missing ${path.relative(root, from)}: run npm ci`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// 1. The site itself
fs.cpSync(path.join(root, 'src'), out, { recursive: true });

// 2. transformers.js (the self-contained build: onnxruntime-web is bundled into it) and the onnxruntime WASM it runs.
//    The onnxruntime files MUST come from the copy that transformers.js was built against (it nests its own).
const tf = pkgDir('@huggingface/transformers');
const tfPkg = JSON.parse(fs.readFileSync(path.join(tf, 'package.json'), 'utf8'));
const tfRequire = createRequire(path.join(tf, 'package.json'));
const ort = pkgDir('onnxruntime-web', tfRequire);
const ortPkg = JSON.parse(fs.readFileSync(path.join(ort, 'package.json'), 'utf8'));
copy(path.join(tf, 'dist', 'transformers.min.js'), path.join(out, 'vendor', 'transformers.min.js'));
// "asyncify" runs WebGPU and WASM; the plain build is smaller and is used when there is no WebGPU. ("jsep" does not run
// WebGPU with this version, so it is not shipped.)
for (const f of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'])
  copy(path.join(ort, 'dist', f), path.join(out, 'vendor', 'ort', f));

// 3. Fonts
const inter = pkgDir('@fontsource-variable/inter');
const serif = pkgDir('@fontsource/young-serif');
copy(path.join(inter, 'files', 'inter-latin-wght-normal.woff2'), path.join(out, 'fonts', 'inter-latin-wght-normal.woff2'));
copy(path.join(serif, 'files', 'young-serif-latin-400-normal.woff2'), path.join(out, 'fonts', 'young-serif-latin-400-normal.woff2'));

// 4. Tesseract (reads the words of a text area on this device: "Fast" screen reading), when it has been wired in
const tessDir = path.join(root, 'src', 'js', 'screen', 'ocr.js');
if (fs.existsSync(tessDir)) {
  const tess = pkgDir('tesseract.js');
  const core = pkgDir('tesseract.js-core');
  const data = pkgDir('@tesseract.js-data/eng');
  copy(path.join(tess, 'dist', 'tesseract.esm.min.js'), path.join(out, 'vendor', 'tesseract', 'tesseract.esm.min.js'));
  copy(path.join(tess, 'dist', 'worker.min.js'), path.join(out, 'vendor', 'tesseract', 'worker.min.js'));
  for (const f of ['tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'])
    copy(path.join(core, f), path.join(out, 'vendor', 'tesseract', 'core', f));
  copy(path.join(data, '4.0.0_best_int', 'eng.traineddata.gz'), path.join(out, 'vendor', 'tesseract', 'lang', 'eng.traineddata.gz'));
}

// 5. Licenses of everything vendored, next to the libraries
const licenseDir = path.join(out, 'vendor', 'licenses');
const bundled = [
  ['transformers.js', tf], ['onnxruntime-web', ort], ['inter', inter], ['young-serif', serif],
  ...(fs.existsSync(tessDir) ? [['tesseract.js', pkgDir('tesseract.js')], ['tesseract.js-core', pkgDir('tesseract.js-core')], ['tesseract.js-data-eng', pkgDir('@tesseract.js-data/eng')]] : []),
];
for (const [name, dir] of bundled) {
  const file = fs.readdirSync(dir).find((f) => /^licen[sc]e(\..*)?$/i.test(f));
  if (file) copy(path.join(dir, file), path.join(licenseDir, `${name}.${file}`.replace(/\.(LICENSE|license|LICENCE)(?=\.|$)/, '.LICENSE')));
}
copy(path.join(root, 'THIRD-PARTY-NOTICES.md'), path.join(out, 'THIRD-PARTY-NOTICES.md'));
copy(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));

// 6. GitHub Pages: no Jekyll processing
fs.writeFileSync(path.join(out, '.nojekyll'), '');

// 7. A record of what went in
const manifest = { transformers: tfPkg.version, onnxruntimeWeb: ortPkg.version, builtFrom: 'package-lock.json' };
fs.writeFileSync(path.join(out, 'vendor', 'versions.json'), JSON.stringify(manifest, null, 2) + '\n');

// 8. Checks: the built page must reference nothing outside itself
const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
if (/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/i.test(html)) fail('index.html has an inline script');
if (/\sstyle\s*=|<style[\s>]/i.test(html)) fail('index.html has inline style');
if (/\son[a-z]+\s*=/i.test(html)) fail('index.html has an inline event handler');
if (/(src|href)\s*=\s*["']https?:\/\/(?!github\.com|cs92604\.github\.io\/CueLightWeb\/|console\.|platform\.|aistudio\.|build\.nvidia)/i.test(html)) fail('index.html loads something from another site');

function size(dir) { let n = 0; for (const f of fs.readdirSync(dir, { withFileTypes: true })) n += f.isDirectory() ? size(path.join(dir, f.name)) : fs.statSync(path.join(dir, f.name)).size; return n; }
log(`built _site (${(size(out) / 1e6).toFixed(1)} MB): transformers.js ${tfPkg.version}, onnxruntime-web ${ortPkg.version}`);
