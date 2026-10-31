// Port of Settings.cs: user preferences, how they are described to the AI, and provider/model memory.
import { Provider, Models, getProvider, resolveModel } from './providers.js';

export const Professionalism = Object.freeze({ VeryCasual: 'VeryCasual', Casual: 'Casual', Professional: 'Professional', Formal: 'Formal' });
export const Proficiency = Object.freeze({ Simple: 'Simple', Everyday: 'Everyday', Fluent: 'Fluent', Advanced: 'Advanced' });
export const Tone = Object.freeze({ Warm: 'Warm', Neutral: 'Neutral', Direct: 'Direct', Diplomatic: 'Diplomatic', Confident: 'Confident' });
export const ReplyLength = Object.freeze({ Brief: 'Brief', Short: 'Short', Detailed: 'Detailed' });
export const SpeechAccuracy = Object.freeze({ Fast: 'Fast', Balanced: 'Balanced', Accurate: 'Accurate' });

/** How the watched text area reaches the AI. Fast: the words on it are read in this browser and only that text is sent.
 *  Detailed: a picture of it is sent, so the AI also sees layout, colours and who wrote what. */
export const ScreenReading = Object.freeze({ Fast: 'Fast', Detailed: 'Detailed' });

const has = (enumObj, v) => Object.values(enumObj).includes(v);

/**
 * @typedef {object} Settings
 * @property {string} professionalism @property {string} proficiency @property {string} tone @property {string} length
 * @property {number} options Suggestions per section (1-3)
 * @property {string} replyLanguage Empty = same language as the other person
 * @property {string} customInstructions Free text: who the user is, words to avoid, background for the conversation
 * @property {string} provider @property {string} model @property {string} baseUrl
 * @property {Record<string,string>} providerModels The model last used with each provider
 * @property {boolean} thinkFirst @property {boolean} useMicrophone @property {boolean} autoSuggest
 * @property {boolean} typeEnabled @property {string} speechAccuracy @property {string} screenReading
 * @property {boolean} useBrowserSpeech Use the browser's built-in speech recognition (sends audio to Google or Apple)
 */

/** @returns {Settings} */
export function defaultSettings() {
  return {
    professionalism: Professionalism.Professional,
    proficiency: Proficiency.Fluent,
    tone: Tone.Warm,
    length: ReplyLength.Short,
    options: 2,
    replyLanguage: '',
    customInstructions: '',
    provider: Provider.Claude,
    model: Models.default,
    baseUrl: '',
    providerModels: {},
    thinkFirst: false,
    useMicrophone: false,
    autoSuggest: true,
    typeEnabled: false,
    speechAccuracy: SpeechAccuracy.Balanced,
    screenReading: ScreenReading.Detailed,
    useBrowserSpeech: false,
  };
}

/** Settings for a first launch. A phone, or a browser without WebGPU, gets the fastest speech model so transcription
 *  keeps up with the conversation; everything else is the normal default. */
export function forFirstRun({ isPhone = false, hasWebGpu = true } = {}) {
  return { ...defaultSettings(), speechAccuracy: isPhone || !hasWebGpu ? SpeechAccuracy.Fast : SpeechAccuracy.Balanced };
}

/** Switch to another provider, remembering the model of the one being left and restoring the one last used with the new
 *  provider (or its default). Returns a new settings object. */
export function useProvider(settings, provider) {
  if (provider === settings.provider) return settings;
  const providerModels = { ...(settings.providerModels ?? {}) };
  providerModels[settings.provider] = settings.model;
  const remembered = providerModels[provider];
  return {
    ...settings,
    providerModels,
    provider,
    model: typeof remembered === 'string' && remembered.trim() !== '' ? remembered : getProvider(provider).defaultModel,
  };
}

/** A cleaned-up copy: values clamped, unknown values replaced by defaults, the model resolved. */
export function normalized(settings) {
  const d = defaultSettings();
  const s = { ...d, ...(settings ?? {}) };
  const n = Math.trunc(Number(s.options));
  s.options = Number.isFinite(n) ? Math.min(3, Math.max(1, n)) : d.options;
  s.replyLanguage = String(s.replyLanguage ?? '').trim();
  s.customInstructions = String(s.customInstructions ?? '').trim();
  if (!has(Provider, s.provider)) s.provider = Provider.Claude;
  s.model = resolveModel(s.provider, s.model);
  s.baseUrl = String(s.baseUrl ?? '').trim();
  s.providerModels = s.providerModels && typeof s.providerModels === 'object' && !Array.isArray(s.providerModels) ? { ...s.providerModels } : {};
  if (!has(Professionalism, s.professionalism)) s.professionalism = Professionalism.Professional;
  if (!has(Proficiency, s.proficiency)) s.proficiency = Proficiency.Fluent;
  if (!has(Tone, s.tone)) s.tone = Tone.Warm;
  if (!has(ReplyLength, s.length)) s.length = ReplyLength.Short;
  if (!has(SpeechAccuracy, s.speechAccuracy)) s.speechAccuracy = SpeechAccuracy.Balanced;
  if (!has(ScreenReading, s.screenReading)) s.screenReading = ScreenReading.Detailed;
  for (const k of ['thinkFirst', 'useMicrophone', 'autoSuggest', 'typeEnabled', 'useBrowserSpeech']) s[k] = Boolean(s[k]);
  return s;
}

/** The style block that goes into every request. */
export function toPrompt(settings) {
  const s = normalized(settings);
  const lines = [
    `- Formality: ${describeProfessionalism(s.professionalism)}`,
    `- Jargon and depth of explanation: ${describeProficiency(s.proficiency)}`,
    `- Tone: ${describeTone(s.tone)}`,
    `- Length: ${describeLength(s.length)}`,
    `- Options: up to ${s.options} per section`,
    `- Reply language: ${s.replyLanguage.length > 0 ? s.replyLanguage : 'the same language the other person is using'}`,
  ];
  if (s.customInstructions.length > 0) lines.push(`- About me / extra instructions from me: ${s.customInstructions}`);
  return lines.join('\n');
}

export function describeProfessionalism(v) {
  switch (v) {
    case Professionalism.VeryCasual: return 'very casual, like texting a friend: contractions, relaxed phrasing, light slang is fine';
    case Professionalism.Casual: return 'casual and friendly, like talking to a colleague you get along with';
    case Professionalism.Professional: return 'professional: polite and clear, no slang, still natural and not stiff';
    default: return 'formal: courteous, precise and respectful, as with a senior stakeholder or in a formal setting';
  }
}

export function describeProficiency(v) {
  switch (v) {
    case Proficiency.Simple: return 'plain language with no jargon. Use everyday words, define any unavoidable term in a few words, and explain things simply and from the ground up, as if to a newcomer to the topic';
    case Proficiency.Everyday: return 'mostly plain language with only common, widely known terms. Briefly explain anything technical, with short, practical explanations';
    case Proficiency.Fluent: return 'normal professional vocabulary for the topic. Use standard field terminology without defining it, assume shared background, and explain at a working level of detail';
    default: return 'specialist level. Use precise technical terminology and jargon freely, skip the basics, and go into depth where it matters: mechanisms, trade-offs and specifics. (This is about depth and vocabulary, not length)';
  }
}

/** One line shown under the Proficiency control in Settings. */
export function captionProficiency(v) {
  switch (v) {
    case Proficiency.Simple: return 'Plain words, no jargon. Explains things from the ground up.';
    case Proficiency.Everyday: return 'Mostly plain words. A few common terms, briefly explained.';
    case Proficiency.Fluent: return 'Normal professional vocabulary. Assumes shared background.';
    default: return 'Specialist jargon and depth. Skips the basics.';
  }
}

export function describeTone(v) {
  switch (v) {
    case Tone.Warm: return 'warm and personable';
    case Tone.Neutral: return 'neutral and matter-of-fact';
    case Tone.Direct: return 'direct and to the point, without padding';
    case Tone.Diplomatic: return 'diplomatic and tactful, softening anything that could land badly';
    default: return 'confident and assertive, without being aggressive';
  }
}

export function describeLength(v) {
  switch (v) {
    case ReplyLength.Brief: return 'brief: one short sentence per option';
    case ReplyLength.Short: return 'short: one or two sentences per option';
    default: return 'detailed: two to four sentences per option, with a reason or example placeholder where it helps';
  }
}
