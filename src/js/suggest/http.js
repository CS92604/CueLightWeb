// A fetch with a time limit that covers only the wait for the answer to start (a stream that has begun is not cut off).

export const REQUEST_TIMEOUT_MS = 120_000;
export const CHECK_TIMEOUT_MS = 20_000;

/**
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Response>} rejects with the caller's abort reason if `signal` aborts, with a TimeoutError if the
 *   limit passes first, and with whatever fetch throws otherwise (a TypeError for network failures).
 */
export async function fetchWithin(fetchImpl, url, init, timeoutMs, signal) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) throw signal.reason ?? abortError();
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      const e = new Error('The request timed out');
      e.name = 'TimeoutError';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function abortError() {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

/** Up to 4,000 characters of an error body. */
export async function readBody(response) {
  try {
    const text = await response.text();
    return text.length > 4000 ? text.slice(0, 4000) : text;
  } catch {
    return '';
  }
}
