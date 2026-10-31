import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Trigger } from '../src/js/core/prompting.js';
import { defaultSettings, useProvider } from '../src/js/core/settings.js';
import { Provider } from '../src/js/core/providers.js';
import { ClaudeSuggester, buildRequest, validateClaudeKey, FALLBACK_BETA } from '../src/js/suggest/claude.js';
import { OpenAiCompatibleSuggester, validateOpenAiKey, buildBody, Quirks } from '../src/js/suggest/openai.js';
import { createSuggester, validateKey } from '../src/js/suggest/router.js';
import { ProviderApiError, describe, extractMessage } from '../src/js/suggest/errors.js';
import { scriptedFetch, sseResponse, jsonResponse, FAKE_IMAGE } from './helpers.js';

const collect = async (gen) => { let s = ''; for await (const c of gen) s += c; return s; };
const settingsFor = (provider, over = {}) => ({ ...useProvider(defaultSettings(), provider), ...over });
const request = (settings, over = {}) => ({ transcript: 'Them: Can you tell me about your last project?', settings, trigger: Trigger.Speech, hint: null, regionImage: null, rejected: null, regionText: null, ...over });

// -- Claude ---------------------------------------------------------------------------------------------------

const claudeStream = (text = ['SAY\n• Hello', ' there'], usage = {}) => sseResponse([
  { type: 'message_start', message: { usage: { input_tokens: 120, cache_creation_input_tokens: 40, cache_read_input_tokens: 900, output_tokens: 1, ...usage } } },
  { type: 'ping' },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ...text.map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'ignored' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
  { type: 'message_stop' },
]);
const claudeSuggester = (fetch, over = {}) => new ClaudeSuggester({ getKey: () => 'sk-ant-test', fetch, ...over });
const bodyOf = (call) => JSON.parse(call.init.body);

test('Claude: streams the text, sends the browser headers and caches the system prompt', async () => {
  const fetch = scriptedFetch([claudeStream()]);
  const usage = [];
  const out = await collect(claudeSuggester(fetch).stream(request(defaultSettings(), { onUsage: (u) => usage.push(u) })));
  assert.equal(out, 'SAY\n• Hello there');
  const call = fetch.calls[0];
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['x-api-key'], 'sk-ant-test');
  assert.equal(call.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(call.init.headers['content-type'], 'application/json');
  const body = bodyOf(call);
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 2048);
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
  assert.ok(body.system[0].text.startsWith('You are a live conversation assistant'));
  const content = body.messages[0].content;
  assert.ok(content[0].text.startsWith('<style_settings>'));
  assert.ok(content.at(-1).text.startsWith('</conversation_so_far>'));
  assert.deepEqual(body.thinking, { type: 'between_tools' });
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.equal(body.fallbacks, 'default');
  assert.equal(call.init.headers['anthropic-beta'], FALLBACK_BETA);
  assert.deepEqual(usage, [{ model: 'claude-sonnet-5-5', input: 120, cacheWrite: 40, cacheRead: 900, output: 42, provider: 'Claude' }]);
});

test('Claude: the cache marker goes on the last complete front chunk, and the picture comes between front and tail', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `Them: line ${i} ` + 'x'.repeat(80)).join('\n');
  const { body } = buildRequest(request(defaultSettings(), { transcript: lines, regionImage: FAKE_IMAGE }), 2048);
  const content = body.messages[0].content;
  const marked = content.map((p, i) => (p.cache_control ? i : -1)).filter((i) => i >= 0);
  assert.equal(marked.length, 1);
  const imageAt = content.findIndex((p) => p.type === 'image');
  assert.deepEqual(content[imageAt].source, { type: 'base64', media_type: 'image/png', data: FAKE_IMAGE.data });
  assert.ok(marked[0] < imageAt);
  assert.equal(imageAt, content.length - 2);
});

test('Claude: model-specific extras (Opus keeps thinking, Haiku 5.5 disables it, Haiku 4.5 gets no effort and no fallback)', () => {
  const b = (model, over) => buildRequest(request({ ...defaultSettings(), model, ...over }), 2048);
  const opus = b('claude-opus-5-5'); assert.equal(opus.body.thinking, undefined); assert.equal(opus.body.fallbacks, 'default');
  const haiku = b('claude-haiku-5-5'); assert.deepEqual(haiku.body.thinking, { type: 'disabled' }); assert.equal(haiku.body.fallbacks, undefined); assert.equal(haiku.headers['anthropic-beta'], undefined);
  assert.deepEqual(haiku.body.output_config, { effort: 'low' });
  const old = buildRequest({ ...request(defaultSettings()), settings: { ...defaultSettings(), model: 'claude-haiku-4-5' } }, 2048);
  assert.equal(old.body.output_config, undefined);
  const think = b('claude-sonnet-5-5', { thinkFirst: true });
  assert.equal(think.body.thinking, undefined); assert.deepEqual(think.body.output_config, { effort: 'medium' });
});

test('Claude: on a 400 the extras are stripped one at a time, and remembered for the model', async () => {
  const bad = (msg) => jsonResponse({ type: 'error', error: { type: 'invalid_request_error', message: msg } }, 400);
  const failures = [bad('thinking: between_tools is not supported'), bad('unknown parameter: fallbacks'), bad('output_config.effort is invalid')];
  let n = 0;
  const fetch = scriptedFetch(() => failures[n++] ?? claudeStream());
  const s = claudeSuggester(fetch);
  assert.equal(await collect(s.stream(request(defaultSettings()))), 'SAY\n• Hello there');
  const sent = fetch.calls.map(bodyOf);
  assert.equal(sent.length, 4);
  assert.ok(sent[0].thinking && sent[0].fallbacks && sent[0].output_config);
  assert.ok(!sent[1].thinking && sent[1].fallbacks && sent[1].output_config);
  assert.ok(!sent[2].thinking && !sent[2].fallbacks && sent[2].output_config);
  assert.ok(!sent[3].thinking && !sent[3].fallbacks && !sent[3].output_config);
  assert.equal(fetch.calls[3].init.headers['anthropic-beta'], undefined);
  // remembered: the next request for the same model starts without any of them
  fetch.calls.length = 0;
  await collect(s.stream(request(defaultSettings())));
  const next = bodyOf(fetch.calls[0]);
  assert.ok(!next.thinking && !next.fallbacks && !next.output_config);
});

test('Claude: a 400 that names nothing strips the first extra still on; with nothing left it is reported', async () => {
  const bad = jsonResponse({ error: { message: 'something odd' } }, 400);
  const fetch = scriptedFetch([bad.clone(), bad.clone(), bad.clone(), bad.clone()]);
  await assert.rejects(collect(claudeSuggester(fetch).stream(request(defaultSettings()))), (e) => e instanceof ProviderApiError && /Claude API error: something odd/.test(e.message) && e.status === 400);
  assert.equal(fetch.calls.length, 4);
  const noExtras = scriptedFetch([jsonResponse({ error: { message: 'bad' } }, 400)]);
  await assert.rejects(collect(claudeSuggester(noExtras).stream(request({ ...defaultSettings(), model: 'claude-haiku-4-5' }))), /Claude API error: bad/);
  assert.equal(noExtras.calls.length, 1);
});

test('Claude: the quirk memory is kept per suggester and model', async () => {
  const fetch = scriptedFetch((n) => (n === 0 ? jsonResponse({ error: { message: 'thinking not allowed' } }, 400) : claudeStream()));
  const s = claudeSuggester(fetch);
  await collect(s.stream(request(defaultSettings())));
  await collect(s.stream(request(defaultSettings())));
  const sent = fetch.calls.map(bodyOf);
  assert.equal(sent.length, 3);
  assert.ok(sent[0].thinking && !sent[1].thinking && !sent[2].thinking);
});

test('Claude: a refusal and the token limit are reported to the user; usage is estimated when cut off', async () => {
  const refused = sseResponse([{ type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } }, { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 1 } }]);
  assert.match(await collect(claudeSuggester(scriptedFetch([refused])).stream(request(defaultSettings()))), /Claude declined to suggest a reply/);
  const long = sseResponse([{ type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'SAY\n• long' } }, { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 2048 } }]);
  assert.ok((await collect(claudeSuggester(scriptedFetch([long])).stream(request(defaultSettings())))).endsWith(' …'));
  // cut off: the consumer stops after the first chunk; no final total ever arrived
  const usage = [];
  const cut = sseResponse([{ type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 1 } } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x'.repeat(400) } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'never read' } }]);
  for await (const _ of claudeSuggester(scriptedFetch([cut])).stream(request(defaultSettings(), { onUsage: (u) => usage.push(u) }))) break;
  assert.equal(usage.length, 1);
  assert.equal(usage[0].input, 50);
  assert.equal(usage[0].output, 100); // about four characters to a token
});

test('Claude: an error event in the stream, a missing key and an aborted request', async () => {
  const err = sseResponse([{ type: 'message_start', message: { usage: {} } }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]);
  await assert.rejects(collect(claudeSuggester(scriptedFetch([err])).stream(request(defaultSettings()))), /Claude stopped the reply: Overloaded/);
  await assert.rejects(collect(new ClaudeSuggester({ getKey: () => null, fetch: scriptedFetch([]) }).stream(request(defaultSettings()))), /No Claude API key is set/);
  const ac = new AbortController(); ac.abort();
  const fetch = async (url, init) => { if (init.signal.aborted) throw Object.assign(new Error('x'), { name: 'AbortError' }); return claudeStream(); };
  await assert.rejects(collect(claudeSuggester(fetch).stream(request(defaultSettings()), ac.signal)), (e) => e.name === 'AbortError');
});

test('Claude: failures are explained in plain words', async () => {
  for (const [status, expected] of [[401, "Claude didn't accept that key"], [403, "doesn't have permission to use the Claude API"], [404, "couldn't find that model"], [429, 'rate-limiting'], [529, 'had a problem'], [500, 'had a problem']]) {
    await assert.rejects(collect(claudeSuggester(scriptedFetch([jsonResponse({ error: { message: 'x' } }, status)])).stream(request(defaultSettings()))),
      (e) => e instanceof ProviderApiError && e.message.includes(expected) && e.status === status, String(status));
  }
});

test('Claude: a network failure (TypeError) says the service may not allow web pages', async () => {
  await assert.rejects(collect(claudeSuggester(scriptedFetch([new TypeError('Failed to fetch')])).stream(request(defaultSettings()))),
    (e) => e instanceof ProviderApiError && /Couldn't reach Claude/.test(e.message) && /may not allow web pages/.test(e.message) && /desktop app is the sure option/.test(e.message));
});

test('Claude: a request that never starts answering times out', async () => {
  const fetch = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const { fetchWithin } = await import('../src/js/suggest/http.js');
  await assert.rejects(fetchWithin(fetch, 'https://x', {}, 20, undefined), (e) => e.name === 'TimeoutError');
});

test('Claude: key validation lists models, and explains a bad key', async () => {
  const ok = scriptedFetch([jsonResponse({ data: [] })]);
  assert.deepEqual(await validateClaudeKey(' sk-ant-good ', { fetch: ok }), { ok: true, message: '' });
  assert.equal(ok.calls[0].url, 'https://api.anthropic.com/v1/models?limit=1');
  assert.equal(ok.calls[0].init.headers['x-api-key'], 'sk-ant-good');
  const bad = await validateClaudeKey('nope', { fetch: scriptedFetch([jsonResponse({ error: { message: 'invalid x-api-key' } }, 401)]) });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /Claude didn't accept that key/);
  const offline = await validateClaudeKey('k', { fetch: scriptedFetch([new TypeError('Failed to fetch')]) });
  assert.match(offline.message, /Couldn't reach Claude/);
});

// -- OpenAI-compatible ----------------------------------------------------------------------------------------

const chat = (parts = ['SAY\n• Hi', ' there'], { usage = { prompt_tokens: 1000, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 600 } }, finish = 'stop' } = {}) => sseResponse([
  ...parts.map((p) => ({ choices: [{ delta: { content: p } }] })),
  { choices: [{ delta: {}, finish_reason: finish }] },
  ...(usage ? [{ choices: [], usage }] : []),
  '[DONE]',
]);
const compat = (fetch, over = {}) => new OpenAiCompatibleSuggester({ getKey: () => 'k-123', fetch, pageProtocol: 'https:', ...over });

test('OpenAI-style: streams text, sends the bearer key to the provider address, and splits cached input from new input', async () => {
  const fetch = scriptedFetch([chat()]);
  const usage = [];
  const s = settingsFor(Provider.OpenAi);
  const out = await collect(compat(fetch).stream(request(s, { onUsage: (u) => usage.push(u) })));
  assert.equal(out, 'SAY\n• Hi there');
  assert.equal(fetch.calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(fetch.calls[0].init.headers.authorization, 'Bearer k-123');
  const body = bodyOf(fetch.calls[0]);
  assert.equal(body.model, 'gpt-6.1-sol');
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.max_completion_tokens, 4096);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.messages[0].role, 'system');
  assert.ok(body.messages[0].content.startsWith('You are a live conversation assistant'));
  assert.equal(body.messages[1].content.length, 2); // no picture: just the two text parts
  assert.deepEqual(usage, [{ model: 'gpt-6.1-sol', input: 400, cacheWrite: 0, cacheRead: 600, output: 30, provider: 'OpenAi' }]);
});

test('OpenAI-style: thinking first raises the effort; a picture goes between the two text parts', () => {
  const think = buildBody('m', 'front', 'tail', null, true, new Quirks(Provider.OpenAi), 100);
  assert.equal(think.reasoning_effort, 'medium');
  const body = buildBody('m', 'front', 'tail', FAKE_IMAGE, false, new Quirks(Provider.OpenAi), 100);
  const c = body.messages[1].content;
  assert.deepEqual(c.map((p) => p.type), ['text', 'image_url', 'text']);
  assert.equal(c[1].image_url.url, `data:image/png;base64,${FAKE_IMAGE.data}`);
});

for (const [provider, limit, reasoning] of [[Provider.OpenAi, 'max_completion_tokens', true], [Provider.Grok, 'max_completion_tokens', true], [Provider.Gemini, 'max_tokens', true], [Provider.Nvidia, 'max_tokens', false], [Provider.Other, 'max_tokens', false]])
  test(`OpenAI-style: ${provider} gets the limit name (${limit}) and reasoning setting (${reasoning}) it is known to accept`, async () => {
    const fetch = scriptedFetch([chat()]);
    await collect(compat(fetch).stream(request({ ...settingsFor(provider), model: 'some-model', baseUrl: 'https://svc.example/v1' })));
    const body = bodyOf(fetch.calls[0]);
    assert.ok(limit in body, limit);
    assert.equal('reasoning_effort' in body, reasoning);
  });

test('OpenAI-style: another service uses the address and model the user typed, and "no-key" sends no Authorization header', async () => {
  const fetch = scriptedFetch([chat()]);
  await collect(compat(fetch, { getKey: () => 'no-key' }).stream(request({ ...settingsFor(Provider.Other), model: 'llama3', baseUrl: 'http://localhost:11434/v1/' })));
  assert.equal(fetch.calls[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(fetch.calls[0].init.headers.authorization, undefined);
  assert.equal(bodyOf(fetch.calls[0]).model, 'llama3');
});

test('OpenAI-style: when no counts come back the use is estimated rather than lost', async () => {
  const usage = [];
  await collect(compat(scriptedFetch([chat(['x'.repeat(400)], { usage: null })])).stream(request(settingsFor(Provider.Grok), { onUsage: (u) => usage.push(u) })));
  assert.equal(usage.length, 1);
  assert.equal(usage[0].output, 100);
  assert.ok(usage[0].input > 1000); // the system prompt alone is ~5,200 characters
});

test('OpenAI-style: a provider that refuses the reasoning setting is asked again without it, and remembered', async () => {
  const fetch = scriptedFetch((n) => (n === 0 ? jsonResponse({ error: { message: "Unknown parameter: 'reasoning_effort'" } }, 400) : chat()));
  const s = compat(fetch);
  await collect(s.stream(request(settingsFor(Provider.OpenAi))));
  await collect(s.stream(request(settingsFor(Provider.OpenAi))));
  const sent = fetch.calls.map(bodyOf);
  assert.equal(sent.length, 3);
  assert.ok('reasoning_effort' in sent[0] && !('reasoning_effort' in sent[1]) && !('reasoning_effort' in sent[2]));
});

test('OpenAI-style: the other limit name and the token-count request are each retried once', async () => {
  const f1 = scriptedFetch((n) => (n === 0 ? jsonResponse({ error: { message: "Unsupported parameter: 'max_completion_tokens'. Use 'max_tokens' instead." } }, 400) : chat()));
  await collect(compat(f1).stream(request(settingsFor(Provider.OpenAi))));
  assert.ok('max_completion_tokens' in bodyOf(f1.calls[0]) && 'max_tokens' in bodyOf(f1.calls[1]) && !('max_completion_tokens' in bodyOf(f1.calls[1])));
  const f2 = scriptedFetch((n) => (n === 0 ? jsonResponse({ error: { message: 'stream_options is not supported' } }, 400) : chat()));
  await collect(compat(f2).stream(request(settingsFor(Provider.OpenAi))));
  assert.ok('stream_options' in bodyOf(f2.calls[0]) && !('stream_options' in bodyOf(f2.calls[1])));
});

test('OpenAI-style: a 400 that names nothing it can change is reported, with what the provider said', async () => {
  const fetch = scriptedFetch([jsonResponse({ error: { message: 'Something else is wrong' } }, 400)]);
  await assert.rejects(collect(compat(fetch).stream(request(settingsFor(Provider.OpenAi)))), /ChatGPT error \(400\): Something else is wrong/);
  assert.equal(fetch.calls.length, 1);
});

test('OpenAI-style: failures are explained in plain words', async () => {
  for (const [status, expected] of [[401, "didn't accept that key"], [403, "doesn't have permission"], [404, "couldn't find the model"], [429, 'rate-limiting'], [500, 'had a problem'], [402, 'needs credit']])
    await assert.rejects(collect(compat(scriptedFetch([jsonResponse({ error: { message: 'x' } }, status)])).stream(request(settingsFor(Provider.OpenAi)))),
      (e) => e instanceof ProviderApiError && e.message.includes(expected) && e.message.includes('ChatGPT') && e.status === status && describe(e) === e.message, String(status));
});

test('OpenAI-style: running out of credit, NVIDIA free limits and a model that cannot see pictures are named', async () => {
  await assert.rejects(collect(compat(scriptedFetch([jsonResponse({ error: { message: 'You exceeded your current quota' } }, 429)])).stream(request(settingsFor(Provider.OpenAi)))), /out of quota or credit/);
  await assert.rejects(collect(compat(scriptedFetch([jsonResponse({ error: { message: 'slow down' } }, 429)])).stream(request(settingsFor(Provider.Nvidia)))), /NVIDIA's free tier is rate limited/);
  await assert.rejects(collect(compat(scriptedFetch([jsonResponse({ error: { message: 'model does not support image input' } }, 400)])).stream(request(settingsFor(Provider.OpenAi), { regionImage: FAKE_IMAGE }))), /can't read pictures, so Type can't use it/);
});

test('OpenAI-style: NVIDIA is free (counted in tokens) and a network failure names CORS and the desktop app', async () => {
  await assert.rejects(collect(compat(scriptedFetch([new TypeError('Failed to fetch')])).stream(request(settingsFor(Provider.Nvidia)))),
    (e) => /Couldn't reach NVIDIA/.test(e.message) && /NVIDIA may not allow web pages to call its API directly/.test(e.message) && /desktop app is the sure option/.test(e.message));
  await assert.rejects(collect(compat(scriptedFetch([new TypeError('Failed to fetch')])).stream(request({ ...settingsFor(Provider.Other), model: 'm', baseUrl: 'https://svc.example/v1' }))),
    /Couldn't reach the service at svc\.example.*may not allow web pages/);
});

test('OpenAI-style: an error in the middle of a reply, and replies that hit their limit or were filtered, say so', async () => {
  const mid = sseResponse([{ choices: [{ delta: { content: 'SAY\n• a' } }] }, { error: { message: 'upstream failed' } }]);
  await assert.rejects(collect(compat(scriptedFetch([mid])).stream(request(settingsFor(Provider.OpenAi)))), /ChatGPT stopped the reply: upstream failed/);
  assert.ok((await collect(compat(scriptedFetch([chat(['hi'], { finish: 'length' })])).stream(request(settingsFor(Provider.OpenAi))))).endsWith(' …'));
  assert.match(await collect(compat(scriptedFetch([chat([], { finish: 'length' })])).stream(request(settingsFor(Provider.OpenAi)))), /used up its room while thinking/);
  assert.match(await collect(compat(scriptedFetch([chat(['x'], { finish: 'content_filter' })])).stream(request(settingsFor(Provider.OpenAi)))), /declined to suggest a reply/);
});

test('OpenAI-style: the stream is read whole however it is chopped into network packets', async () => {
  const fetch = scriptedFetch(() => sseResponse([{ choices: [{ delta: { content: 'SAY\n• héllo wörld ✓' } }] }, '[DONE]'], { splitEvery: 7 }));
  assert.equal(await collect(compat(fetch).stream(request(settingsFor(Provider.OpenAi)))), 'SAY\n• héllo wörld ✓');
});

test('OpenAI-style: missing pieces are reported before anything is sent', async () => {
  const fetch = scriptedFetch([chat()]);
  await assert.rejects(collect(compat(fetch, { getKey: () => null }).stream(request(settingsFor(Provider.OpenAi)))), (e) => /ChatGPT API key/.test(e.message) && /Settings/.test(e.message));
  await assert.rejects(collect(compat(fetch).stream(request({ ...settingsFor(Provider.Other), model: '  ', baseUrl: 'https://x.example/v1' }))), /model name/);
  await assert.rejects(collect(compat(fetch).stream(request({ ...settingsFor(Provider.Other), model: 'm', baseUrl: '' }))), /address/);
  await assert.rejects(collect(compat(fetch).stream(request({ ...settingsFor(Provider.Other), model: 'm', baseUrl: 'ftp://nope' }))), /doesn't look right/);
  await assert.rejects(collect(compat(fetch).stream(request({ ...settingsFor(Provider.Other), model: 'm', baseUrl: 'http://example.com/v1' }))), /unencrypted/);
  await assert.rejects(collect(compat(fetch).stream(request({ ...settingsFor(Provider.Other), model: 'm', baseUrl: 'http://192.168.1.9:1234/v1' }))), /browser blocks pages served over https/);
  assert.equal(fetch.calls.length, 0);
});

test('OpenAI-style: the key goes only to the provider address (never elsewhere)', async () => {
  const fetch2 = scriptedFetch((n, url) => (url.includes('anthropic') ? claudeStream() : chat()));
  const s2 = createSuggester({ getKey: () => 'secret-key-1', fetch: fetch2, pageProtocol: 'https:' });
  for (const p of [Provider.OpenAi, Provider.Gemini, Provider.Grok, Provider.Nvidia, Provider.Claude]) await collect(s2.stream(request(settingsFor(p))));
  const hosts = fetch2.calls.map((c) => new URL(c.url).host);
  assert.deepEqual(hosts.sort(), ['api.anthropic.com', 'api.openai.com', 'api.x.ai', 'generativelanguage.googleapis.com', 'integrate.api.nvidia.com'].sort());
});

test('OpenAI-style: key checks ask for the model list; NVIDIA, whose list is public, is asked for one word', async () => {
  const ok = scriptedFetch([jsonResponse({ data: [] })]);
  assert.deepEqual(await validateOpenAiKey(Provider.OpenAi, ' k ', '', { fetch: ok }), { ok: true, message: '' });
  assert.equal(ok.calls[0].url, 'https://api.openai.com/v1/models');
  assert.equal(ok.calls[0].init.headers.authorization, 'Bearer k');
  const bad = await validateOpenAiKey(Provider.Grok, 'bad', '', { fetch: scriptedFetch([jsonResponse({ error: 'Incorrect API key' }, 401)]) });
  assert.equal(bad.ok, false); assert.match(bad.message, /Grok didn't accept that key/);
  const noList = await validateOpenAiKey(Provider.Other, 'k', 'https://svc.example/v1', { fetch: scriptedFetch([new Response('', { status: 404 })]) });
  assert.equal(noList.ok, true); // no model list to ask: let it through
  const nv = scriptedFetch([jsonResponse({ data: [] }), jsonResponse({ error: 'Unauthorized' }, 401)]);
  const nvBad = await validateOpenAiKey(Provider.Nvidia, 'nvapi-bad', '', { fetch: nv });
  assert.equal(nvBad.ok, false);
  assert.equal(nv.calls.length, 2);
  assert.match(nv.calls[1].url, /chat\/completions$/);
  const probe = bodyOf(nv.calls[1]);
  assert.equal(probe.max_tokens, 1);
  assert.equal(probe.model, 'meta/llama-3.3-70b-instruct');
  const nvOk = await validateOpenAiKey(Provider.Nvidia, 'nvapi-good', '', { fetch: scriptedFetch([jsonResponse({ data: [] }), jsonResponse({ choices: [] }, 200)]) });
  assert.equal(nvOk.ok, true);
  const nvBusy = await validateOpenAiKey(Provider.Nvidia, 'nvapi-good', '', { fetch: scriptedFetch([jsonResponse({ data: [] }), jsonResponse({}, 429)]) });
  assert.equal(nvBusy.ok, true); // only a refused key counts as wrong
  assert.match((await validateOpenAiKey(Provider.Other, 'k', '', { fetch: ok })).message, /Enter the service's address first/);
  assert.match((await validateOpenAiKey(Provider.Other, 'k', 'http://example.com', { fetch: ok })).message, /unencrypted/);
  const cors = await validateOpenAiKey(Provider.Nvidia, 'k', '', { fetch: scriptedFetch([new TypeError('Failed to fetch')]) });
  assert.match(cors.message, /may not allow web pages/);
});

test('the router sends each request and key check to the provider the settings name', async () => {
  const fetch = scriptedFetch((n, url) => (url.includes('anthropic') ? claudeStream(['claude says hi']) : chat(['gpt says hi'])));
  const s = createSuggester({ getKey: () => 'k', fetch, pageProtocol: 'https:' });
  assert.equal(await collect(s.stream(request(settingsFor(Provider.Claude)))), 'claude says hi');
  assert.equal(await collect(s.stream(request(settingsFor(Provider.OpenAi)))), 'gpt says hi');
  await validateKey(Provider.Claude, 'k', '', { fetch });
  await validateKey(Provider.Gemini, 'k', '', { fetch });
  assert.deepEqual(fetch.calls.map((c) => new URL(c.url).host), ['api.anthropic.com', 'api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com']);
});

test('extractMessage reads the provider\'s own words from error JSON in all the shapes seen', () => {
  assert.equal(extractMessage('{"error":{"message":"nope"}}'), 'nope');
  assert.equal(extractMessage('{"error":"plain"}'), 'plain');
  assert.equal(extractMessage('[{"error":{"message":"in array"}}]'), 'in array');
  assert.equal(extractMessage('{"message":"top"}'), 'top');
  assert.equal(extractMessage('<html>gateway</html>'), '<html>gateway</html>');
  assert.equal(extractMessage('x'.repeat(300)).length, 241);
});
