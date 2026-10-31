import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageMeter, tokenUsage, priceFor, costLabel, costTip } from '../src/js/core/usage.js';
import { Provider, PROVIDERS, getProvider } from '../src/js/core/providers.js';

test('cost is worked out from the list price of each token kind', () => {
  const m = new UsageMeter();
  m.add(tokenUsage('claude-sonnet-5-5', 100, 500, 4000, 300)); // 100×$2 + 500×$2.50 + 4000×$0.10 + 300×$10 per million
  const u = m.snapshot();
  assert.deepEqual([u.requests, u.input, u.cacheWrite, u.cacheRead, u.output], [1, 100, 500, 4000, 300]);
  assert.ok(Math.abs(u.cost - 0.00485) < 1e-12);
  assert.equal(u.unpriced, false);
  assert.ok(Math.abs(u.cachedShare - 4000 / 4600) < 1e-12);
});

test('a dated model id counts as its base id; an unknown model is counted in tokens and flagged', () => {
  assert.ok(priceFor('claude-haiku-4-5-20251001'));
  assert.equal(priceFor('gemini-3.1-pro-preview').output, 12);
  assert.equal(priceFor('some-new-model'), null);
  const m = new UsageMeter();
  m.add(tokenUsage('some-new-model', 1500, 0, 0, 500, Provider.Other));
  const u = m.snapshot();
  assert.equal(u.cost, 0);
  assert.equal(u.unpriced, true);
  assert.equal(costLabel(u), '2k tokens');
});

test('NVIDIA is free: counted in tokens, costs nothing, label says Free', () => {
  const m = new UsageMeter();
  m.add(tokenUsage('meta/llama-3.3-70b-instruct', 1000, 0, 0, 100, Provider.Nvidia));
  const u = m.snapshot();
  assert.equal(u.cost, 0);
  assert.equal(u.unpriced, false);
  assert.equal(u.input, 1000);
  assert.equal(costLabel(u), 'Free');
  assert.match(costTip(u, getProvider(Provider.Nvidia)), /API is free, so nothing is being charged for the 1 request made/);
});

test('the corner label: $0.00, <$0.01, ≈ $x.xx and a + when part could not be priced', () => {
  assert.equal(costLabel(new UsageMeter().snapshot()), '$0.00');
  const m = new UsageMeter();
  m.add(tokenUsage('claude-sonnet-5-5', 1000, 0, 0, 100));
  assert.equal(costLabel(m.snapshot()), '≈ <$0.01');
  for (let i = 0; i < 400; i++) m.add(tokenUsage('claude-sonnet-5-5', 5000, 0, 0, 400));
  assert.match(costLabel(m.snapshot()), /^≈ \$\d+\.\d\d$/);
  m.add(tokenUsage('mystery', 1, 0, 0, 1));
  assert.match(costLabel(m.snapshot()), /\+$/);
});

test('every priced model offered in Settings has a price; free and custom providers need none', () => {
  for (const p of PROVIDERS.filter((x) => !x.isFree && !x.isCustom))
    for (const model of p.models) assert.ok(priceFor(model.id), `${model.id} has no price`);
});

test('claude cache writes cost 1.25× the input price, as the README says', () => {
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-haiku-4-5']) {
    const p = priceFor(id);
    assert.ok(Math.abs(p.cacheWrite - p.input * 1.25) < 1e-9, id);
  }
});

test('the tooltip explains the estimate and where the exact bill is', () => {
  const m = new UsageMeter();
  assert.match(costTip(m.snapshot()), /Nothing has been sent yet\. Your Claude Console/);
  m.add(tokenUsage('claude-sonnet-5-5', 100, 0, 300, 50));
  assert.match(costTip(m.snapshot()), /1 request\. 75% of what Claude read came from its memory/);
});
