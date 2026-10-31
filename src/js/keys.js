// Where API keys live: this browser only, one per provider. With "remember on this device" on they are kept in
// localStorage; with it off they are kept in sessionStorage and vanish when the tab closes. A key is only ever read to be
// sent to its own provider's address. Nothing is sent to the author of this page, and there is no analytics.
import { PROVIDERS } from './core/providers.js';

const KEY_PREFIX = 'cuelight.key.';
const REMEMBER = 'cuelight.remember';

/** A Storage that can't fail: used when the browser refuses storage (private windows, blocked site data). */
export function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

/** Wraps a Storage so that every call is safe: a throwing browser storage falls back to memory for the rest of the page. */
function safe(storage) {
  const fallback = memoryStorage();
  let broken = false;
  const run = (fn, fb) => {
    if (!broken) { try { return fn(storage); } catch { broken = true; } }
    return fb(fallback);
  };
  return {
    getItem: (k) => run((s) => s.getItem(k), (f) => f.getItem(k)),
    setItem: (k, v) => run((s) => s.setItem(k, v), (f) => f.setItem(k, v)),
    removeItem: (k) => run((s) => s.removeItem(k), (f) => f.removeItem(k)),
  };
}

function browserStorage(name) {
  try { return globalThis[name]; } catch { return undefined; }
}

export class KeyStore {
  #local; #session;

  /** @param {{local?:Storage, session?:Storage}} [o] storages, replaceable in tests */
  constructor({ local = browserStorage('localStorage'), session = browserStorage('sessionStorage') } = {}) {
    this.#local = safe(local ?? memoryStorage());
    this.#session = safe(session ?? memoryStorage());
  }

  /** "Remember on this device": keys go in localStorage. Off (the default) keeps them for this tab only. */
  get remember() { return this.#local.getItem(REMEMBER) === '1'; }

  /** Changing the choice moves the keys already saved to the matching storage, so none is left behind in the other. */
  setRemember(on) {
    const from = this.remember ? this.#local : this.#session;
    const to = on ? this.#local : this.#session;
    const moved = PROVIDERS.map((p) => [p.id, from.getItem(KEY_PREFIX + p.id)]);
    this.#local.setItem(REMEMBER, on ? '1' : '0');
    if (from === to) return;
    for (const [id, key] of moved) {
      if (key !== null) to.setItem(KEY_PREFIX + id, key);
      from.removeItem(KEY_PREFIX + id);
    }
  }

  get #active() { return this.remember ? this.#local : this.#session; }

  get(provider) {
    const v = this.#active.getItem(KEY_PREFIX + provider);
    return v && v.length > 0 ? v : null;
  }

  has(provider) { return this.get(provider) !== null; }

  set(provider, key) {
    key = String(key ?? '').trim();
    if (key.length === 0) { this.remove(provider); return; }
    this.#active.setItem(KEY_PREFIX + provider, key);
  }

  remove(provider) {
    this.#local.removeItem(KEY_PREFIX + provider);
    this.#session.removeItem(KEY_PREFIX + provider);
  }

  /** The "Forget my keys" button: every saved key, from both storages. */
  forgetAll() { for (const p of PROVIDERS) this.remove(p.id); }

  /** Which providers have a key. */
  providersWithKeys() { return PROVIDERS.filter((p) => this.has(p.id)).map((p) => p.id); }
}

/** A key shown on screen: only the ends. */
export function maskKey(key) {
  key = String(key ?? '');
  if (key.length <= 8) return '•'.repeat(key.length);
  return key.slice(0, 4) + '…' + key.slice(-4);
}

const SETTINGS = 'cuelight.settings';

/** Preferences (not secret) are kept in localStorage; a missing or unreadable value means defaults. */
export class SettingsStore {
  #storage;
  constructor(storage = browserStorage('localStorage')) { this.#storage = safe(storage ?? memoryStorage()); }
  get exists() { return this.#storage.getItem(SETTINGS) !== null; }
  load() {
    try { const v = JSON.parse(this.#storage.getItem(SETTINGS)); return v && typeof v === 'object' ? v : null; } catch { return null; }
  }
  save(settings) { try { this.#storage.setItem(SETTINGS, JSON.stringify(settings)); return true; } catch { return false; } }
  clear() { this.#storage.removeItem(SETTINGS); }
}
