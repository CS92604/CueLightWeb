// Port of ClaudeSuggester.cs: talks to the Claude API straight from the browser with the user's key, streaming the reply.
// The desktop app uses Anthropic's .NET SDK; this sends the same request over plain HTTP. The browser-access header,
// and the way the extra settings (thinking override, effort, server-side fallback) are spelled on the wire, have NOT
// been verified against the live API: a 400 that names one of them makes the request go out again without it.
import { frontBlocks, tailText, SYSTEM_PROMPT } from '../core/prompting.js';
import { getProvider, Provider } from '../core/providers.js';
import { tokenUsage } from '../core/usage.js';
import { ProviderApiError, failure, network } from './errors.js';
import { fetchWithin, readBody, REQUEST_TIMEOUT_MS, CHECK_TIMEOUT_MS } from './http.js';
import { readData } from './sse.js';

export const ANTHROPIC_BASE = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_ATTEMPTS = 4;

// Models for which the server-side `fallbacks: "default"` parameter applies.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

export function claudeHeaders(apiKey, extra = {}) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true', // Anthropic's opt-in for calling the API from a web page
    ...extra,
  };
}

/** What the API turned out not to accept for a model. Remembered per model. */
function newQuirks() { return { noThinking: false, noFallbacks: false, noEffort: false }; }

/** Up-front thinking only adds waiting time before a quick conversational reply, so it is turned off where the model
 *  allows it. (Opus 5.5 can't have thinking turned off; low effort keeps it short.) */
function thinkingOverride(model, thinkFirst, quirks) {
  if (thinkFirst || quirks.noThinking) return null;
  if (model.startsWith('claude-sonnet-5-5')) return 'between_tools';
  if (model.startsWith('claude-haiku-5')) return 'disabled';
  return null;
}

/** The JSON body and the extra headers of one request. Exported for tests. */
export function buildRequest(request, maxTokens, quirks = newQuirks()) {
  const settings = request.settings;
  const model = settings.model;

  // Order matters for cost. Claude remembers a request's front part, and pays only a tenth (a twentieth on some models)
  // of the normal price to read it again, but only if that front is identical next time. So: the instructions, then the
  // conversation (marked as the end of what to remember), and only then the things that differ every time.
  const content = [];
  for (const block of frontBlocks(request)) {
    const part = { type: 'text', text: block.text };
    if (block.cacheAfter) part.cache_control = { type: 'ephemeral' };
    content.push(part);
  }
  if (request.regionImage) {
    content.push({ type: 'image', source: { type: 'base64', media_type: request.regionImage.mediaType, data: request.regionImage.data } });
  }
  content.push({ type: 'text', text: tailText(request) });

  const body = {
    model,
    max_tokens: maxTokens, // thinking tokens count toward this
    stream: true,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
  };
  // `effort` is not accepted by Haiku 4.5 (Haiku 5.5 and the other models take it).
  if (!model.startsWith('claude-haiku-4') && !quirks.noEffort)
    body.output_config = { effort: settings.thinkFirst ? 'medium' : 'low' };
  const thinking = thinkingOverride(model, settings.thinkFirst, quirks);
  if (thinking) body.thinking = { type: thinking };
  const headers = {};
  if (FALLBACK_MODELS.has(model) && !quirks.noFallbacks) {
    // If the safety classifiers decline, the API re-runs the request on a fallback model.
    body.fallbacks = 'default';
    headers['anthropic-beta'] = FALLBACK_BETA;
  }
  return { body, headers };
}

/** Which of the extras a 400 names, or the first one still switched on. Returns false if there is nothing left to strip. */
export function adaptQuirks(quirks, model, errorBody) {
  const b = String(errorBody ?? '').toLowerCase();
  const active = {
    thinking: !quirks.noThinking && thinkingOverride(model, false, quirks) !== null,
    fallbacks: !quirks.noFallbacks && FALLBACK_MODELS.has(model),
    effort: !quirks.noEffort && !model.startsWith('claude-haiku-4'),
  };
  let pick = null;
  if (active.thinking && b.includes('thinking')) pick = 'thinking';
  else if (active.fallbacks && (b.includes('fallback') || b.includes('beta'))) pick = 'fallbacks';
  else if (active.effort && (b.includes('effort') || b.includes('output_config'))) pick = 'effort';
  else pick = ['thinking', 'fallbacks', 'effort'].find((k) => active[k]) ?? null; // strip one at a time, in this order
  if (pick === null) return false;
  if (pick === 'thinking') quirks.noThinking = true;
  else if (pick === 'fallbacks') quirks.noFallbacks = true;
  else quirks.noEffort = true;
  return true;
}

export class ClaudeSuggester {
  #getKey; #fetch; #maxTokens; #base; #quirks = new Map();

  /** @param {{getKey:(p:string)=>string|null, fetch?:typeof fetch, maxTokens?:number, baseUrl?:string}} o */
  constructor({ getKey, fetch: fetchImpl = globalThis.fetch?.bind(globalThis), maxTokens = 2048, baseUrl = ANTHROPIC_BASE }) {
    this.#getKey = getKey;
    this.#fetch = fetchImpl;
    this.#maxTokens = maxTokens;
    this.#base = baseUrl.replace(/\/+$/, '');
  }

  /** Stream the text of a suggestion as Claude writes it. */
  async *stream(request, signal) {
    const info = getProvider(Provider.Claude);
    const model = request.settings.model;
    const key = (this.#getKey(Provider.Claude) ?? '').trim();
    if (key.length === 0) throw new Error('No Claude API key is set.');
    let quirks = this.#quirks.get(model);
    if (!quirks) this.#quirks.set(model, (quirks = newQuirks()));

    let response = null;
    for (let attempt = 1; ; attempt++) {
      const { body, headers } = buildRequest(request, this.#maxTokens, quirks);
      try {
        response = await fetchWithin(this.#fetch, `${this.#base}/v1/messages`, {
          method: 'POST',
          headers: claudeHeaders(key, { 'content-type': 'application/json', ...headers }),
          body: JSON.stringify(body),
        }, REQUEST_TIMEOUT_MS, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        throw network(info, this.#base, err);
      }
      if (response.ok) break;

      const text = await readBody(response);
      const status = response.status;
      if (status === 400 && attempt < MAX_ATTEMPTS && adaptQuirks(quirks, model, text)) continue;
      throw failure(info, model, status, text, request.regionImage != null);
    }

    let stopReason = null;
    let input = 0, written = 0, read = 0, output = 0, chars = 0;
    let started = false;
    try {
      for await (const ev of readData(response, signal)) {
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
          chars += ev.delta.text.length;
          yield ev.delta.text;
        } else if (ev.type === 'message_start') {
          const u = ev.message?.usage ?? {};
          input = u.input_tokens ?? 0;
          written = u.cache_creation_input_tokens ?? 0;
          read = u.cache_read_input_tokens ?? 0;
          output = u.output_tokens ?? 0;
          started = true;
        } else if (ev.type === 'message_delta') {
          stopReason = ev.delta?.stop_reason ?? stopReason;
          const u = ev.usage ?? {}; // running totals for the whole request
          input = u.input_tokens ?? input;
          written = u.cache_creation_input_tokens ?? written;
          read = u.cache_read_input_tokens ?? read;
          output = u.output_tokens ?? output;
        } else if (ev.type === 'error') {
          throw new ProviderApiError(`Claude stopped the reply: ${ev.error?.message ?? 'unknown error'}`);
        }
      }
    } catch (err) {
      if (err instanceof ProviderApiError || signal?.aborted) throw err;
      throw new ProviderApiError('The connection to Claude dropped while it was answering. Try again.', null, err);
    } finally {
      // Also runs when the request is cut short (a newer one replaced it): what Claude had already read and written is
      // still billed, so it still counts. A cut-off request never reports its final total; roughly four characters
      // make a token.
      if (started && request.onUsage) {
        if (stopReason === null) output = Math.max(output, Math.trunc(chars / 4));
        request.onUsage(tokenUsage(model, input, written, read, output));
      }
    }

    if (stopReason === 'refusal') yield '\n(Claude declined to suggest a reply for this.)';
    else if (stopReason === 'max_tokens') yield ' …';
  }
}

/** Cheap check that a key is accepted (lists models; costs nothing). */
export async function validateClaudeKey(apiKey, { fetch: fetchImpl = globalThis.fetch?.bind(globalThis), baseUrl = ANTHROPIC_BASE, signal } = {}) {
  const info = getProvider(Provider.Claude);
  const base = baseUrl.replace(/\/+$/, '');
  try {
    const response = await fetchWithin(fetchImpl, `${base}/v1/models?limit=1`, {
      method: 'GET', headers: claudeHeaders(apiKey.trim()),
    }, CHECK_TIMEOUT_MS, signal);
    if (response.ok) return { ok: true, message: '' };
    return { ok: false, message: failure(info, '', response.status, await readBody(response), false).message };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { ok: false, message: network(info, base, err).message };
  }
}
