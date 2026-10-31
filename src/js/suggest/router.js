// Port of RoutingSuggester and KeyValidator: sends each request, or key check, to the provider the settings name.
import { Provider } from '../core/providers.js';
import { ClaudeSuggester, validateClaudeKey } from './claude.js';
import { OpenAiCompatibleSuggester, validateOpenAiKey } from './openai.js';

/** The suggester the engine uses: { stream(request, signal) }. */
export function createSuggester({ getKey, fetch: fetchImpl, claudeBaseUrl, openAiBaseUrl, pageProtocol } = {}) {
  const claude = new ClaudeSuggester({ getKey, fetch: fetchImpl, ...(claudeBaseUrl ? { baseUrl: claudeBaseUrl } : {}) });
  const compatible = new OpenAiCompatibleSuggester({ getKey, fetch: fetchImpl, baseUrl: openAiBaseUrl ?? null, ...(pageProtocol ? { pageProtocol } : {}) });
  return {
    stream: (request, signal) =>
      (request.settings.provider === Provider.Claude ? claude : compatible).stream(request, signal),
  };
}

/** Checks a key with whichever provider it belongs to. Resolves { ok, message }. */
export function validateKey(provider, apiKey, address, opts = {}) {
  return provider === Provider.Claude
    ? validateClaudeKey(apiKey, opts)
    : validateOpenAiKey(provider, apiKey, address, opts);
}
