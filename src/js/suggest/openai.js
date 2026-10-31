// Port of OpenAiCompatibleSuggester.cs: talks to any service that offers the OpenAI chat API (OpenAI itself, Gemini
// through its OpenAI-compatible address, Grok, NVIDIA, and others), streaming the reply.
//
// Providers differ in small ways about which settings they accept. Sent first: a low reasoning effort (for speed), a
// request for token counts, and the output limit under the name the provider is known to use. If a provider answers 400
// naming one of them, the request is sent again without that setting or with the other name, and that is remembered for
// the model.
import { frontBlocks, tailText, SYSTEM_PROMPT } from '../core/prompting.js';
import { getProvider, Provider, NO_KEY } from '../core/providers.js';
import { tokenUsage } from '../core/usage.js';
import * as ServiceAddress from '../core/serviceAddress.js';
import { ProviderApiError, failure, network, short } from './errors.js';
import { fetchWithin, readBody, REQUEST_TIMEOUT_MS, CHECK_TIMEOUT_MS } from './http.js';
import { readData } from './sse.js';

const MAX_ATTEMPTS = 4;

/** What a provider turned out not to accept. Remembered per provider and model. */
export class Quirks {
  useMaxTokens; noReasoningEffort; noStreamOptions = false; #renamedTokens = false;

  constructor(provider) {
    // OpenAI's newer models want max_completion_tokens; Gemini's address and most other services know max_tokens.
    this.useMaxTokens = provider === Provider.Gemini || provider === Provider.Nvidia || provider === Provider.Other;
    // Other services mostly have no reasoning setting, and some refuse an unknown one: don't offer it there.
    this.noReasoningEffort = provider === Provider.Nvidia || provider === Provider.Other;
  }

  /** Change whatever the error names. False if there is nothing left to change. */
  adapt(errorBody) {
    const b = String(errorBody ?? '').toLowerCase();
    if (!this.noReasoningEffort && b.includes('reasoning')) { this.noReasoningEffort = true; return true; }
    if (!this.noStreamOptions && (b.includes('stream_options') || b.includes('include_usage'))) { this.noStreamOptions = true; return true; }
    if (!this.#renamedTokens && (b.includes('max_tokens') || b.includes('max_completion_tokens'))) {
      this.#renamedTokens = true;
      this.useMaxTokens = !this.useMaxTokens;
      return true;
    }
    return false;
  }
}

/** The JSON body of one request: same order as for Claude: the part that repeats, then the picture, then what changes
 *  every time. Exported for tests. */
export function buildBody(model, front, tail, image, thinkFirst, quirks, maxTokens) {
  const body = { model, stream: true };
  if (!quirks.noStreamOptions) body.stream_options = { include_usage: true };
  body[quirks.useMaxTokens ? 'max_tokens' : 'max_completion_tokens'] = maxTokens;
  if (!quirks.noReasoningEffort) body.reasoning_effort = thinkFirst ? 'medium' : 'low';
  const content = [{ type: 'text', text: front }];
  if (image) content.push({ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } });
  content.push({ type: 'text', text: tail });
  body.messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content }];
  return body;
}

const where = (info) => (info.isCustom ? 'the service' : info.name);

export class OpenAiCompatibleSuggester {
  #getKey; #fetch; #baseUrl; #maxTokens; #pageProtocol; #quirks = new Map();

  /**
   * @param {{getKey:(p:string)=>string|null, fetch?:typeof fetch, baseUrl?:string|null, maxTokens?:number, pageProtocol?:string}} o
   *   baseUrl replaces the provider's address (tests point it at a local server).
   */
  constructor({ getKey, fetch: fetchImpl = globalThis.fetch?.bind(globalThis), baseUrl = null, maxTokens = 4096,
    pageProtocol = globalThis.location?.protocol ?? 'https:' }) {
    this.#getKey = getKey;
    this.#fetch = fetchImpl;
    this.#baseUrl = baseUrl;
    this.#maxTokens = maxTokens;
    this.#pageProtocol = pageProtocol;
  }

  #resolveRoot(info, settings) {
    const address = String(this.#baseUrl ?? (info.isCustom ? settings.baseUrl : info.baseUrl) ?? '').trim().replace(/\/+$/, '');
    if (address.length === 0)
      throw new ProviderApiError("Enter the service's address in Settings, for example https://openrouter.ai/api/v1");
    const bad = ServiceAddress.problem(address) ?? ServiceAddress.browserBlocks(address, this.#pageProtocol);
    if (bad) throw new ProviderApiError(bad);
    return address;
  }

  async *stream(request, signal) {
    const settings = request.settings;
    const info = getProvider(settings.provider);
    const root = this.#resolveRoot(info, settings);
    const model = settings.model.trim();
    if (model.length === 0) throw new ProviderApiError('Enter a model name in Settings.');
    const key = (this.#getKey(settings.provider) ?? '').trim();
    if (key.length === 0) throw new Error(`No ${info.name} API key is set. Add one in Settings.`);

    const quirkKey = `${settings.provider}|${model}`;
    let quirks = this.#quirks.get(quirkKey);
    if (!quirks) this.#quirks.set(quirkKey, (quirks = new Quirks(settings.provider)));
    const front = frontBlocks(request).map((b) => b.text).join('');
    const tail = tailText(request);

    let response = null;
    for (let attempt = 1; ; attempt++) {
      const headers = { 'content-type': 'application/json' };
      if (key !== NO_KEY) headers.authorization = `Bearer ${key}`;
      try {
        response = await fetchWithin(this.#fetch, root + '/chat/completions', {
          method: 'POST', headers,
          body: JSON.stringify(buildBody(model, front, tail, request.regionImage, settings.thinkFirst, quirks, this.#maxTokens)),
        }, REQUEST_TIMEOUT_MS, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        throw network(info, root, err);
      }
      if (response.ok) break;

      const body = await readBody(response);
      const status = response.status;
      if (status === 400 && attempt < MAX_ATTEMPTS && quirks.adapt(body)) continue;
      throw failure(info, model, status, body, request.regionImage != null);
    }

    let input = 0, cached = 0, output = 0, chars = 0;
    let sawUsage = false, started = false;
    let finish = null;
    try {
      for await (const obj of readData(response, signal)) {
        if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) continue;
        started = true;
        if (obj.error && typeof obj.error === 'object')
          throw new ProviderApiError(`${info.name} stopped the reply: ${obj.error.message ?? 'unknown error'}`);

        const choice = Array.isArray(obj.choices) && obj.choices.length > 0 ? obj.choices[0] : null;
        if (choice) {
          const text = choice.delta && typeof choice.delta === 'object' ? choice.delta.content : null;
          if (typeof text === 'string' && text.length > 0) {
            chars += text.length;
            yield text;
          }
          if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
        }
        if (obj.usage && typeof obj.usage === 'object') {
          sawUsage = true;
          const prompt = Number(obj.usage.prompt_tokens) || 0;
          cached = Number(obj.usage.prompt_tokens_details?.cached_tokens) || 0;
          input = Math.max(0, prompt - cached);
          output = Number(obj.usage.completion_tokens) || 0;
        }
      }
    } catch (err) {
      if (err instanceof ProviderApiError || signal?.aborted) throw err;
      throw new ProviderApiError(`The connection to ${where(info)} dropped while it was answering. Try again.`, null, err);
    } finally {
      // Also runs when the request is cut short (a newer one replaced it): what the provider had already read and
      // written is still billed. When no counts came back, an estimate (about four characters to a token) stands in.
      if (started && request.onUsage) {
        if (!sawUsage) {
          input = Math.trunc((SYSTEM_PROMPT.length + front.length + tail.length) / 4);
          output = Math.trunc(chars / 4);
        }
        request.onUsage(tokenUsage(model, input, 0, cached, output, settings.provider));
      }
    }

    if (finish === 'content_filter') yield '\n(The AI declined to suggest a reply for this.)';
    else if (finish === 'length') yield chars === 0 ? '(The model used up its room while thinking. Try again, or pick a faster model in Settings.)' : ' …';
  }
}

/**
 * Cheap check that a key is accepted: asks the service for its model list, which costs nothing. A service with no such
 * list can't be checked, and is let through. NVIDIA, whose list is public, is asked for a single word.
 */
export async function validateOpenAiKey(provider, apiKey, address, { fetch: fetchImpl = globalThis.fetch?.bind(globalThis), baseUrl = null,
  pageProtocol = globalThis.location?.protocol ?? 'https:', signal } = {}) {
  const info = getProvider(provider);
  const root = String(baseUrl ?? (info.isCustom ? address : info.baseUrl) ?? '').trim().replace(/\/+$/, '');
  if (root.length === 0) return { ok: false, message: "Enter the service's address first, for example https://openrouter.ai/api/v1" };
  const bad = ServiceAddress.problem(root) ?? ServiceAddress.browserBlocks(root, pageProtocol);
  if (bad) return { ok: false, message: bad };
  try {
    const k = apiKey.trim();
    const headers = k.length > 0 && k !== NO_KEY ? { authorization: `Bearer ${k}` } : {};
    const response = await fetchWithin(fetchImpl, root + '/models', { method: 'GET', headers }, CHECK_TIMEOUT_MS, signal);
    const status = response.status;
    if (!response.ok && ![404, 405, 501].includes(status)) // 404/405: no model list to ask
      return { ok: false, message: failure(info, '', status, await readBody(response), false).message };

    // NVIDIA lists its models to anyone, so a wrong key would pass the check above: ask for one word instead. (Only a
    // refused key counts as wrong here; a busy service or an unknown model still means the key is fine.)
    if (provider === Provider.Nvidia) {
      const ask = { model: info.defaultModel, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 };
      const answer = await fetchWithin(fetchImpl, root + '/chat/completions', {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(ask),
      }, CHECK_TIMEOUT_MS, signal);
      if (answer.status === 401 || answer.status === 403)
        return { ok: false, message: failure(info, '', answer.status, await readBody(answer), false).message };
    }
    return { ok: true, message: '' };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { ok: false, message: (err instanceof ProviderApiError ? err : network(info, root, err)).message };
  }
}

export { short };
