import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS, Provider, Models, getProvider, canSeePictures, detectProvider, resolveModel, NO_KEY,
} from '../src/js/core/providers.js';
import {
  defaultSettings, normalized, toPrompt, useProvider, forFirstRun, describeProficiency, captionProficiency, describeTone,
  describeLength, describeProfessionalism, Proficiency, ReplyLength, Tone, Professionalism, SpeechAccuracy,
} from '../src/js/core/settings.js';

test('the six providers, their defaults and key pages match the desktop app', () => {
  assert.deepEqual(PROVIDERS.map((p) => p.name), ['Claude', 'ChatGPT', 'Gemini', 'Grok', 'NVIDIA', 'Other']);
  assert.deepEqual(PROVIDERS.map((p) => p.defaultModel), ['claude-sonnet-5-5', 'gpt-6.1-sol', 'gemini-3.8-flash', 'grok-4.7', 'meta/llama-3.3-70b-instruct', '']);
  assert.equal(getProvider(Provider.Nvidia).isFree, true);
  assert.equal(getProvider(Provider.Other).isCustom, true);
  assert.equal(getProvider(Provider.Other).hasKeyPage, false);
  assert.equal(getProvider(Provider.Claude).baseUrl, null);
  assert.equal(getProvider(Provider.Gemini).baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(getProvider(Provider.Grok).keyUrl, 'https://console.x.ai');
  assert.equal(NO_KEY, 'no-key');
  for (const p of PROVIDERS.filter((x) => !x.isCustom)) assert.ok(p.models.some((m) => m.id === p.defaultModel), p.name);
});

test('only the listed text-only model is flagged as unable to read pictures', () => {
  assert.equal(canSeePictures(Provider.Nvidia, 'meta/llama-3.3-70b-instruct'), false);
  assert.equal(canSeePictures(Provider.Nvidia, ' meta/llama-3.3-70b-instruct '), false);
  assert.equal(canSeePictures(Provider.Nvidia, 'meta/llama-3.2-11b-vision-instruct'), true);
  assert.equal(canSeePictures(Provider.Other, 'anything'), true);
  assert.equal(canSeePictures(Provider.Claude, 'claude-haiku-5-5'), true);
});

test('a key is recognised by how its provider\'s keys start', () => {
  assert.equal(detectProvider('sk-ant-api03-abc'), Provider.Claude);
  assert.equal(detectProvider('sk-proj-abc'), Provider.OpenAi);
  assert.equal(detectProvider('xai-abc'), Provider.Grok);
  assert.equal(detectProvider('nvapi-abc'), Provider.Nvidia);
  assert.equal(detectProvider('AIzaSyabc'), Provider.Gemini);
  assert.equal(detectProvider('hello'), null);
  assert.equal(detectProvider(null), null);
});

test('model resolution: Claude is a fixed list with retired ids mapped; others keep what was typed', () => {
  assert.equal(resolveModel(Provider.Claude, 'claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(resolveModel(Provider.Claude, 'claude-haiku-4-5'), 'claude-haiku-5-5');
  assert.equal(resolveModel(Provider.Claude, 'nonsense'), Models.default);
  assert.equal(resolveModel(Provider.Claude, undefined), Models.default);
  assert.equal(resolveModel(Provider.OpenAi, '  my-model '), 'my-model');
  assert.equal(resolveModel(Provider.OpenAi, ''), 'gpt-6.1-sol');
  assert.equal(resolveModel(Provider.Other, ''), '');
});

test('defaults render every setting, in the desktop wording', () => {
  assert.equal(toPrompt(defaultSettings()), [
    '- Formality: professional: polite and clear, no slang, still natural and not stiff',
    '- Jargon and depth of explanation: normal professional vocabulary for the topic. Use standard field terminology without defining it, assume shared background, and explain at a working level of detail',
    '- Tone: warm and personable',
    '- Length: short: one or two sentences per option',
    '- Options: up to 2 per section',
    '- Reply language: the same language the other person is using',
  ].join('\n'));
});

test('choices change the prompt; About me is added only when set', () => {
  const s = { ...defaultSettings(), professionalism: Professionalism.VeryCasual, tone: Tone.Direct, length: ReplyLength.Detailed, options: 3, replyLanguage: ' French ', customInstructions: ' I am a nurse ' };
  const p = toPrompt(s);
  assert.match(p, /Formality: very casual, like texting a friend/);
  assert.match(p, /Tone: direct and to the point, without padding/);
  assert.match(p, /Length: detailed: two to four sentences per option/);
  assert.match(p, /Options: up to 3 per section/);
  assert.match(p, /Reply language: French\n/);
  assert.ok(p.endsWith('- About me / extra instructions from me: I am a nurse'));
});

test('proficiency levels describe jargon and depth and differ', () => {
  const all = Object.values(Proficiency);
  assert.equal(new Set(all.map(describeProficiency)).size, 4);
  assert.equal(new Set(all.map(captionProficiency)).size, 4);
  assert.match(describeProficiency(Proficiency.Simple), /no jargon/);
  assert.match(describeProficiency(Proficiency.Advanced), /not length/);
  assert.match(describeProfessionalism(Professionalism.Formal), /^formal:/);
  assert.match(describeTone(Tone.Confident), /assertive/);
  assert.match(describeLength(ReplyLength.Brief), /one short sentence/);
});

test('invalid values fall back to defaults and numbers are clamped', () => {
  const n = normalized({ professionalism: 'x', proficiency: 9, tone: null, length: 'Huge', options: 99, provider: 'Nope', model: 'zzz', speechAccuracy: 'Slow', screenReading: 'x', providerModels: 5 });
  assert.equal(n.professionalism, 'Professional');
  assert.equal(n.proficiency, 'Fluent');
  assert.equal(n.tone, 'Warm');
  assert.equal(n.length, 'Short');
  assert.equal(n.options, 3);
  assert.equal(normalized({ options: 0 }).options, 1);
  assert.equal(normalized({ options: 'abc' }).options, 2);
  assert.equal(n.provider, 'Claude');
  assert.equal(n.model, 'claude-sonnet-5-5');
  assert.equal(n.speechAccuracy, 'Balanced');
  assert.equal(n.screenReading, 'Detailed');
  assert.deepEqual(n.providerModels, {});
  assert.equal(normalized(null).provider, 'Claude');
});

test('switching provider remembers the model of the one left and restores the one last used', () => {
  let s = { ...defaultSettings(), model: 'claude-opus-5-5' };
  s = useProvider(s, Provider.OpenAi);
  assert.equal(s.model, 'gpt-6.1-sol');
  s = { ...s, model: 'gpt-6-luna' };
  s = useProvider(s, Provider.Claude);
  assert.equal(s.model, 'claude-opus-5-5');
  s = useProvider(s, Provider.OpenAi);
  assert.equal(s.model, 'gpt-6-luna');
  assert.equal(useProvider(s, Provider.OpenAi), s);
  assert.equal(useProvider(defaultSettings(), Provider.Other).model, '');
});

test('first-run speech accuracy: Fast on phones or without WebGPU, otherwise Balanced', () => {
  assert.equal(forFirstRun({ isPhone: true, hasWebGpu: true }).speechAccuracy, SpeechAccuracy.Fast);
  assert.equal(forFirstRun({ isPhone: false, hasWebGpu: false }).speechAccuracy, SpeechAccuracy.Fast);
  assert.equal(forFirstRun({ isPhone: false, hasWebGpu: true }).speechAccuracy, SpeechAccuracy.Balanced);
  assert.equal(defaultSettings().useBrowserSpeech, false);
});
