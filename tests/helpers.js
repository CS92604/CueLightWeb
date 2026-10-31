// Shared fakes for the tests: a suggester, a screen capture, a watcher and an event recorder.
import { Trigger } from '../src/js/core/prompting.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export class FakeSuggester {
  calls = [];
  gate = null; // a deferred: block after the first chunk until it is resolved
  firstChunkSent = deferred();
  throwError = null;
  chunks = ['SAY\n• one', '\n• two'];
  report = null; // what the "API" says the request used

  async *stream(request, signal) {
    this.calls.push(request);
    if (this.throwError) throw this.throwError;
    for (let i = 0; i < this.chunks.length; i++) {
      yield this.chunks[i];
      if (i === 0 && this.gate) {
        this.firstChunkSent.resolve();
        await new Promise((resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort, { once: true });
          this.gate.promise.then(() => { signal.removeEventListener('abort', onAbort); resolve(); });
        });
      }
    }
    if (this.report) request.onUsage?.(this.report);
  }
}

export const FAKE_IMAGE = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };

export class FakeCapture {
  fail = false;
  released = 0;
  async capture() { if (this.fail) throw new Error('no display'); return FAKE_IMAGE; }
  async grab() { return { rgba: new Uint8ClampedArray(16), width: 2, height: 2 }; }
  release() { this.released++; }
}

export class FakeWatcher {
  static instances = [];
  pending = false; started = false; disposed = false;
  constructor(onChange) { this.onChange = onChange; }
  start() { this.started = true; }
  dispose() { this.disposed = true; }
}

export class Recorder {
  events = [];
  #waiters = [];
  add = (e) => { this.events.push(e); for (const w of [...this.#waiters]) w(); };
  count(kind) { return this.events.filter((e) => e.kind === kind).length; }

  waitFor(kind, count = 1, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.count(kind) >= count) { cleanup(); resolve(); }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${kind} x${count}: ${this.events.map((e) => e.kind).join(', ')}`));
      }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.#waiters = this.#waiters.filter((w) => w !== check); };
      this.#waiters.push(check);
      check();
    });
  }
}

export { Trigger };

/** A fetch() replacement that answers from a list of scripted responses and records what it was asked. */
export function scriptedFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = typeof responses === 'function' ? responses(calls.length - 1, String(url), init) : responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

/** A streamed text/event-stream Response from SSE `data:` payloads (objects are JSON-encoded; strings are sent as they are). */
export function sseResponse(payloads, { status = 200, splitEvery = 0 } = {}) {
  const text = payloads.map((p) => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream({
    start(controller) {
      if (splitEvery > 0) for (let i = 0; i < bytes.length; i += splitEvery) controller.enqueue(bytes.slice(i, i + splitEvery));
      else controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

export const jsonResponse = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
