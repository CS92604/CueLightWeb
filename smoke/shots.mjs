import { createRequire } from 'node:module';
import { serve } from '../scripts/serve.mjs';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const out = process.argv[2];
const { server, port } = await serve('_site', 0);
const browser = await chromium.launch();
for (const [name, mode, scheme, vp] of [['phone-light', 'phone', 'light', { width: 390, height: 844 }], ['phone-dark', 'phone', 'dark', { width: 390, height: 844 }], ['desk-light', 'desktop', 'light', { width: 1100, height: 800 }]]) {
  const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/?mode=${mode}&test=1`);
  await page.click('text=Not now');
  await page.evaluate(() => { const c = window.__cuelight; c.engine.setTextEnabled(true); });
  await page.click('#chip-type'); await page.click('#chip-type');
  await page.screenshot({ path: `${out}/${name}.png` });
  await ctx.close();
}
await browser.close(); server.close();
