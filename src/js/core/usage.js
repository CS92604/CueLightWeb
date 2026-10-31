// Port of Usage.cs: token usage, the price table, and the running cost meter.
import { Provider, getProvider } from './providers.js';

/** What one request used, as the provider's API reported it.
 *  input: tokens billed at the full price (not cached); cacheWrite: tokens stored in the cache by this request;
 *  cacheRead: tokens served from the cache; output: tokens the AI wrote, including any it thought through first. */
export function tokenUsage(model, input, cacheWrite, cacheRead, output, provider = Provider.Claude) {
  return { model, input, cacheWrite, cacheRead, output, provider };
}

export const totalInput = (u) => u.input + u.cacheWrite + u.cacheRead;

/** The providers' published prices for the models the app offers, in US dollars per million tokens
 *  [input, cacheWrite, cacheRead, output]. The figure the app shows is an estimate from these. */
const TABLE = [
  // Claude (the 5-minute cache, which is the one the app uses).
  ['claude-opus-5-5', 4, 5, 0.2, 20],
  ['claude-sonnet-5-5', 2, 2.5, 0.1, 10],
  ['claude-haiku-5-5', 0.1, 0.125, 0.01, 0.5], // for prompts up to 100,000 tokens, which the app never exceeds
  ['claude-haiku-4-5', 1, 1.25, 0.1, 5],

  ['gpt-6-astra', 10, 10, 1, 50], // up to 272K tokens of prompt, which the app never exceeds
  ['gpt-6.1-sol', 2, 2, 0.1, 10],
  ['gpt-6-luna', 0.1, 0.1, 0.01, 0.5],

  // Gemini 3.8 Flash costs $0.75 / $3.75 until the end of 2026; the standard price from 2027 is used, so the estimate is
  // never too low. Google's cached-input rate wasn't confirmed, so cached tokens are counted at the full price.
  ['gemini-3.8-flash', 1.5, 1.5, 1.5, 7.5],
  ['gemini-3.1-pro', 2, 2, 2, 12], // prompts up to 200K tokens

  ['grok-4.7', 2, 2, 0.5, 6], // up to 200K tokens of prompt
  ['grok-4.3', 1.25, 1.25, 0.2, 2.5],
].map(([id, input, cacheWrite, cacheRead, output]) => ({ id, price: { input, cacheWrite, cacheRead, output } }));

export const PRICING = Object.freeze(TABLE);

/** The price for a model id (a dated id like claude-haiku-4-5-20251001 counts as its base id), or null. */
export function priceFor(model) {
  if (typeof model !== 'string') return null;
  const hit = TABLE.find((row) => model.startsWith(row.id));
  return hit ? hit.price : null;
}

export function costOf(price, u) {
  return (u.input * price.input + u.cacheWrite * price.cacheWrite + u.cacheRead * price.cacheRead + u.output * price.output) / 1_000_000;
}

/** Adds up the usage of every request. */
export class UsageMeter {
  #requests = 0; #input = 0; #write = 0; #read = 0; #output = 0; #cost = 0; #unpriced = false;

  add(usage) {
    this.#requests++;
    this.#input += usage.input;
    this.#write += usage.cacheWrite;
    this.#read += usage.cacheRead;
    this.#output += usage.output;
    if (getProvider(usage.provider ?? Provider.Claude).isFree) { /* a free API: counted in tokens, and costs nothing */ }
    else {
      const price = priceFor(usage.model);
      if (price) this.#cost += costOf(price, usage);
      else this.#unpriced = true; // counted in tokens, but there's no price to turn it into dollars
    }
  }

  snapshot() {
    const totalIn = this.#input + this.#write + this.#read;
    return {
      requests: this.#requests, input: this.#input, cacheWrite: this.#write, cacheRead: this.#read, output: this.#output,
      cost: this.#cost, unpriced: this.#unpriced,
      totalInput: totalIn,
      /** The share of all input tokens that came from the cache (0 to 1). */
      cachedShare: totalIn === 0 ? 0 : this.#read / totalIn,
    };
  }
}

function tokens(n) {
  const fmt = (x) => String(Math.round(x * 10) / 10);
  return n >= 1_000_000 ? `${fmt(n / 1_000_000)}M tokens` : n >= 1_000 ? `${fmt(n / 1_000)}k tokens` : `${n} tokens`;
}

/** The running cost as shown in the corner: an estimate, so it says "≈" (and "+" when part of the use couldn't be priced). */
export function costLabel(u) {
  if (u.requests === 0) return '$0.00';
  if (u.cost === 0 && u.unpriced) return tokens(u.totalInput + u.output);
  if (u.cost === 0) return 'Free';
  const amount = u.cost < 0.005 ? '<$0.01' : '$' + u.cost.toFixed(2);
  return '≈ ' + amount + (u.unpriced ? '+' : '');
}

export function costTip(u, provider = getProvider(Provider.Claude)) {
  const who = provider.isCustom ? 'the AI' : provider.name;
  const exact = provider.isClaude
    ? 'Your Claude Console (console.anthropic.com) shows the exact amount, and lets you set a monthly spending limit.'
    : provider.isCustom
      ? "Your provider's own dashboard shows the exact amount."
      : `Your ${provider.company} account (${provider.keyHost}) shows the exact amount.`;
  const plural = u.requests === 1 ? '' : 's';
  if (provider.isFree)
    return (u.requests === 0
      ? `${who}'s API is free, so nothing will be charged. `
      : `${who}'s API is free, so nothing is being charged for the ${u.requests} request${plural} made since you opened the page. `)
      + 'A free service limits how many requests it will answer; if it reports a limit, turn Auto-suggest off so the page asks less often.';
  if (u.requests === 0)
    return `Estimated cost of ${who}'s suggestions since you opened the page. Nothing has been sent yet. ` + exact;
  const share = Math.round(u.cachedShare * 100);
  const prices = u.unpriced
    ? 'No price is known for some of the models used, so those are counted in tokens only and the total is incomplete. '
    : provider.isCustom ? '' : `This is worked out from ${provider.company}'s list prices. `;
  return `Estimated cost of ${who}'s suggestions since you opened the page: ${u.requests} request${plural}. `
    + `${share}% of what ${who} read came from its memory of earlier requests, which costs far less. `
    + prices + exact;
}
