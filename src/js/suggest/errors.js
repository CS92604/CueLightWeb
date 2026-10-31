// Plain-language errors for provider calls (ports of ProviderApiException, SuggesterErrors and ClaudeSuggester.Describe).
import { getProvider } from '../core/providers.js';

/** A provider's "no" (or "can't reach it"), already in words the user can act on. */
export class ProviderApiError extends Error {
  constructor(message, status = null, cause = undefined) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ProviderApiError';
    this.status = status;
  }
}

const where = (info) => (info.isCustom ? 'the service' : info.name);

export function short(body) {
  body = String(body ?? '').trim();
  return body.length > 240 ? body.slice(0, 240) + '…' : body;
}

/** The provider's own explanation, from the error JSON it sent (or the start of whatever it sent). */
export function extractMessage(body) {
  try {
    let el = JSON.parse(body);
    if (Array.isArray(el) && el.length > 0) el = el[0];
    if (el && typeof el === 'object') {
      const e = el.error;
      if (e && typeof e === 'object' && typeof e.message === 'string' && e.message.length > 0) return e.message;
      if (typeof e === 'string') return e;
      if (typeof el.message === 'string' && el.message.length > 0) return el.message;
    }
  } catch { /* not JSON */ }
  return short(body);
}

/** A failed HTTP status, in plain words. */
export function failure(info, model, status, body, hadImage) {
  const who = where(info);
  const said = extractMessage(body);
  const lower = said.toLowerCase();
  let text;
  if (info.isClaude) {
    if (status === 401) text = "Claude didn't accept that key. Check it and try again.";
    else if (status === 403) text = "That key doesn't have permission to use the Claude API.";
    else if (status === 429) text = 'Claude is rate-limiting this key right now. Try again in a moment.';
    else if (status >= 500) text = "Claude's service had a problem. Try again in a moment.";
    else if (status === 404) text = "Claude couldn't find that model for this key. Pick another model in Settings.";
    else text = `Claude API error: ${said}`;
    return new ProviderApiError(text, status);
  }
  if (status === 401) text = `${who} didn't accept that key. Check it and try again.`;
  else if (status === 402) text = `${who} says the account needs credit before it can answer.`;
  else if (status === 403) text = `That key doesn't have permission to use ${who}'s API. ${short(said)}`.trim();
  else if (status === 404)
    text = info.isCustom
      ? `The service couldn't find the model “${model}”, or the address is wrong. Check both in Settings.`
      : `${who} couldn't find the model “${model}” for this key. Pick another model in Settings.`;
  else if (status === 429 && (lower.includes('quota') || lower.includes('credit') || lower.includes('billing')))
    text = `${who} says this account is out of quota or credit. Add credit with them, or try another key.`;
  else if (status === 429 && info.id === 'Nvidia')
    text = "NVIDIA's free tier is rate limited (about 40 requests a minute, and NVIDIA doesn't publish exact limits). Wait a moment, or turn Auto-suggest off so it asks less often.";
  else if (status === 429)
    text = `${who} is rate-limiting this key right now. Try again in a moment. (A free key has small limits; turning Auto-suggest off makes fewer requests.)`;
  else if (status >= 500) text = `${who}'s service had a problem. Try again in a moment.`;
  else if (status === 400 && hadImage && (lower.includes('image') || lower.includes('vision') || lower.includes('multimodal')))
    text = `“${model}” can't read pictures, so Type can't use it. Pick another model in Settings, switch “Reading the text area” to Fast (which sends only words), or turn Type off.`;
  else text = `${who} error (${status}): ${said}`;
  return new ProviderApiError(text, status);
}

/** What a failed fetch() means. A TypeError is how browsers report every network failure, including a service that
 *  doesn't allow web pages to call it (CORS), so the message says both. */
export function network(info, root, err) {
  const who = where(info);
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError'))
    return new ProviderApiError(`${who} took too long to answer. Check your connection and try again.`, null, err);
  let host = root;
  try { host = new URL(root).host; } catch { /* keep as typed */ }
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (offline) return new ProviderApiError("You're offline. Check your internet connection and try again.", null, err);
  const cors = info.id === 'Nvidia'
    ? ' NVIDIA may not allow web pages to call its API directly (a browser rule called CORS). The CueLight desktop app is the sure option.'
    : ` ${info.isCustom ? 'The service' : info.name} may not allow web pages to call it directly (a browser rule called CORS). The CueLight desktop app is the sure option.`;
  return new ProviderApiError(info.isCustom
    ? `Couldn't reach the service at ${host}. Check the address and your internet connection.${cors}`
    : `Couldn't reach ${info.name}. Check your internet connection.${cors}`, null, err);
}

/** The words shown for a failure of any kind of provider. */
export function describe(err) {
  if (err instanceof ProviderApiError) return err.message;
  if (err && err.name === 'AbortError') return 'The request was cancelled.';
  return err && err.message ? err.message : String(err);
}

export { getProvider };
