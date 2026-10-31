// Renders src/icons/icon.svg to the PNG icons the web app manifest and iOS need. A development script (it uses
// Playwright's Chromium): the PNGs are committed, so the build does not need it.  node scripts/make-icons.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');

// A maskable icon needs its picture inside the central 80%: draw the artwork smaller on a full-bleed background.
const maskable = svg.replace('<rect width="512" height="512" rx="112" fill="url(#g)"/>', '<rect width="512" height="512" fill="url(#g)"/>')
  .replace('<g fill="none"', '<g transform="translate(256 256) scale(0.78) translate(-256 -256)" fill="none"')
  .replace('<circle cx="256" cy="256" r="36" fill="#fff"/>', '<circle cx="256" cy="256" r="28" fill="#fff"/>');

const browser = await chromium.launch();
for (const [name, source, size] of [['icon-192.png', svg, 192], ['icon-512.png', svg, 512], ['icon-180.png', maskable, 180], ['icon-maskable-512.png', maskable, 512]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0">${source.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`);
  await page.screenshot({ path: path.join(dir, name), omitBackground: true });
  await page.close();
  console.log('wrote', name);
}
await browser.close();
