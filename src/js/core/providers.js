// Port of Providers.cs and the Models part of Settings.cs: which providers exist, their models and defaults.

export const Provider = Object.freeze({
  Claude: 'Claude', OpenAi: 'OpenAi', Gemini: 'Gemini', Grok: 'Grok', Nvidia: 'Nvidia', Other: 'Other',
});

/** @typedef {{id:string,name:string,blurb:string,tip?:string,seesPictures?:boolean}} ModelChoice */
const model = (id, name, blurb, tip = '', seesPictures = true) => ({ id, name, blurb, tip, seesPictures });

/** The Claude models the app offers. */
export const Models = Object.freeze({
  // Sonnet: very good replies at half the price of Opus. Cost matters here because the app asks Claude again after
  // nearly every sentence it hears.
  default: 'claude-sonnet-5-5',
  all: Object.freeze([
    model('claude-opus-5-5', 'Claude Opus 5.5', 'Best replies · 2× the cost',
      'The most capable model: the best replies. A little slower, and it costs twice as much as Sonnet for each suggestion.'),
    model('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'Recommended',
      'The recommended balance: very good replies, quick, and half the cost of Opus.'),
    model('claude-haiku-5-5', 'Claude Haiku 5.5', 'Cheapest · 1/20 the cost',
      "The fastest and cheapest, about a twentieth of Sonnet's cost. Good for trying the app out or for long calls; less nuanced than the others."),
  ]),
  // Models the app used to offer, mapped to the one that replaces them (saved settings may still name them).
  retired: Object.freeze({ 'claude-haiku-4-5': 'claude-haiku-5-5' }),

  /** The model to actually use for a saved id: itself if the app offers it, its replacement if it was retired from
   *  the list, otherwise the default. */
  resolve(id) {
    if (typeof id === 'string' && Models.all.some((m) => m.id === id)) return id;
    if (typeof id === 'string' && Object.hasOwn(Models.retired, id)) return Models.retired[id];
    return Models.default;
  },
});

/**
 * What the app knows about one provider: where to get a key, where to send requests and which models to offer.
 * @typedef {object} ProviderInfo
 * @property {string} id  @property {string} name  @property {string} company  @property {string} keyUrl
 * @property {string} keyHost  @property {string} keyHint  @property {string|null} baseUrl
 * @property {string} defaultModel  @property {ModelChoice[]} models  @property {string} blurb  @property {boolean} isFree
 */
function info(id, name, company, keyUrl, keyHost, keyHint, baseUrl, defaultModel, models, blurb, isFree = false) {
  return Object.freeze({
    id, name, company, keyUrl, keyHost, keyHint, baseUrl, defaultModel, models: Object.freeze(models), blurb, isFree,
    isClaude: id === Provider.Claude,
    // "Other" is any OpenAI-style service: its address and model name are typed in.
    isCustom: id === Provider.Other,
    hasKeyPage: keyUrl.length > 0,
  });
}

// Model ids and list prices as published by each provider in October 2026. Models are replaced often, so the app also
// takes any model id typed in (Settings), and a model it has no price for is still counted, in tokens.
export const PROVIDERS = Object.freeze([
  info(Provider.Claude, 'Claude', 'Anthropic',
    'https://console.anthropic.com/settings/keys', 'console.anthropic.com', 'sk-ant-…',
    null, Models.default, [...Models.all],
    "Anthropic's Claude. It remembers the earlier part of the conversation between suggestions, which keeps the cost down."),

  info(Provider.OpenAi, 'ChatGPT', 'OpenAI',
    'https://platform.openai.com/api-keys', 'platform.openai.com', 'sk-…',
    'https://api.openai.com/v1', 'gpt-6.1-sol',
    [
      model('gpt-6-astra', 'GPT-6 Astra', 'Best replies · 5× the cost',
        "OpenAI's most capable model: the best replies. Slower, and about five times the price of GPT-6.1 Sol."),
      model('gpt-6.1-sol', 'GPT-6.1 Sol', 'Recommended',
        'The recommended balance: very good replies at a moderate price.'),
      model('gpt-6-luna', 'GPT-6 Luna', 'Cheapest · 1/20 the cost',
        "The fastest and cheapest, about a twentieth of Sol's price. Less nuanced."),
    ],
    "OpenAI's GPT models, the ones behind ChatGPT. You need an OpenAI API key; a ChatGPT subscription doesn't include one."),

  info(Provider.Gemini, 'Gemini', 'Google',
    'https://aistudio.google.com/apikey', 'aistudio.google.com', 'AIza…',
    'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-3.8-flash',
    [
      model('gemini-3.1-pro-preview', 'Gemini 3.1 Pro (preview)', 'Best replies',
        "Google's most capable Gemini: the best replies, slower and pricier than Flash. Still a preview model."),
      model('gemini-3.8-flash', 'Gemini 3.8 Flash', 'Recommended',
        'The recommended balance: quick, good replies, low price.'),
    ],
    "Google's Gemini models, through the Gemini API. A key from Google AI Studio works."),

  info(Provider.Grok, 'Grok', 'xAI',
    'https://console.x.ai', 'console.x.ai', 'xai-…',
    'https://api.x.ai/v1', 'grok-4.7',
    [
      model('grok-4.7', 'Grok 4.7', 'Recommended',
        "xAI's newest Grok: the best replies. It always reasons a little before answering."),
      model('grok-4.3', 'Grok 4.3', 'Cheaper', 'An older Grok at about half the price.'),
    ],
    "xAI's Grok models. You need an xAI API key."),

  // build.nvidia.com: a free key comes with a free NVIDIA Developer Program account. It is rate limited (about 40
  // requests a minute is the figure usually quoted; NVIDIA doesn't publish exact limits) and meant for trying things
  // out, not for production.
  info(Provider.Nvidia, 'NVIDIA', 'NVIDIA',
    'https://build.nvidia.com/settings/api-keys', 'build.nvidia.com', 'nvapi-…',
    'https://integrate.api.nvidia.com/v1', 'meta/llama-3.3-70b-instruct',
    [
      model('meta/llama-3.3-70b-instruct', 'Llama 3.3 70B', 'Free · text only',
        "Meta's Llama 3.3 70B on NVIDIA's free API catalog. Good replies, but it can't read pictures, so Type needs Fast screen reading (or the vision model below).",
        false),
      model('meta/llama-3.2-11b-vision-instruct', 'Llama 3.2 11B Vision', 'Free · reads pictures',
        'A smaller Llama that can also read pictures, so Type works. Its replies are weaker than the 70B\'s.'),
    ],
    "NVIDIA's API catalog: free to try with a free NVIDIA developer account. It is rate limited and meant for testing, and it offers open models such as Llama.",
    true),

  info(Provider.Other, 'Other', 'the service you enter',
    '', '', 'API key (if it needs one)',
    null, '', [],
    'Any service that speaks the OpenAI chat API: OpenRouter, Groq, Together, a model running on this PC with Ollama, and many more. Enter its address and a model name.'),
]);

export function getProvider(id) {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

/** False for a listed model that can't read pictures. Anything else (including a model name typed in) is assumed to. */
export function canSeePictures(provider, modelId) {
  if (provider === Provider.Claude) return true;
  const choice = getProvider(provider).models.find((m) => m.id === (modelId ?? '').trim());
  return choice?.seesPictures ?? true;
}

/** Which provider a key looks like it belongs to, going by how its provider's keys start; null if unsure. */
export function detectProvider(key) {
  key = (key ?? '').trim();
  if (key.startsWith('sk-ant-')) return Provider.Claude;
  if (key.startsWith('xai-')) return Provider.Grok;
  if (key.startsWith('nvapi-')) return Provider.Nvidia;
  if (key.startsWith('AIza')) return Provider.Gemini;
  if (key.startsWith('sk-')) return Provider.OpenAi;
  return null;
}

/** The model to actually use for a saved id. Claude's list is fixed; for the others any id the user typed is kept, and
 *  only an empty one falls back to the provider's default. */
export function resolveModel(provider, id) {
  if (provider === Provider.Claude) return Models.resolve(id);
  id = (id ?? '').trim();
  return id.length > 0 ? id : getProvider(provider).defaultModel;
}

/** Saved for a service that needs no key (a model running on this device, say), so "has a key" stays simple. It is never
 *  sent anywhere. */
export const NO_KEY = 'no-key';
