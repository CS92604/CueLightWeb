// Entering and checking an API key. Used by the first-run dialog and by Settings.
import { getProvider } from '../core/providers.js';
import { NO_KEY } from '../core/providers.js';
import { maskKey } from '../keys.js';
import { validateKey } from '../suggest/router.js';
import { h, clear, checkbox } from './dom.js';

const CORS_HINT = /may not allow web pages/;

/**
 * Draws the key box for one provider into `container`.
 * @param {object} o
 * @param {HTMLElement} o.container
 * @param {import('../keys.js').KeyStore} o.keys
 * @param {()=>{provider:string, baseUrl:string}} o.current  what is selected right now
 * @param {()=>void} o.onChange  a key was saved or removed
 * @param {boolean} [o.compact]  first-run layout: no change/remove row
 */
export function renderKeyEditor({ container, keys, current, onChange, validate = validateKey }) {
  const { provider } = current();
  const info = getProvider(provider);
  const saved = keys.get(provider);
  clear(container);

  const message = h('p', { class: 'msg', role: 'status' });
  const setMessage = (text, kind = '') => { message.textContent = text; message.className = `msg ${kind}`.trim(); };

  const keyHelp = info.hasKeyPage
    ? h('p', { class: 'caption' }, 'Get a key at ', h('a', { href: info.keyUrl, target: '_blank', rel: 'noopener noreferrer' }, info.keyHost))
    : h('p', { class: 'caption' }, 'Only if the service asks for one. A model running on your own network needs none.');

  if (saved) {
    container.append(
      h('div', { class: 'keybox' },
        h('input', { class: 'input', type: 'text', readonly: true, value: saved === NO_KEY ? 'No key needed' : maskKey(saved), 'aria-label': `${info.name} API key (hidden)` }),
        h('button', { class: 'btn small', type: 'button', title: 'Replace this key with another one.', onClick: () => { keys.remove(provider); onChange(); renderKeyEditor({ container, keys, current, onChange, validate }); } }, 'Change'),
        h('button', { class: 'btn small quiet', type: 'button', title: 'Forget this key. It is deleted from this browser.', onClick: () => { keys.remove(provider); onChange(); renderKeyEditor({ container, keys, current, onChange, validate }); } }, 'Remove')),
      message);
    return;
  }

  const input = h('input', { class: 'input', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: info.keyHint, 'aria-label': `${info.name} API key` });
  const reveal = h('button', { class: 'btn small', type: 'button', title: 'Show or hide the key', 'aria-pressed': 'false', onClick: () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    reveal.setAttribute('aria-pressed', String(show));
    reveal.textContent = show ? 'Hide' : 'Show';
  } }, 'Show');
  const save = h('button', { class: 'btn primary', type: 'button', title: 'Check the key with the provider (this costs nothing) and keep it in this browser.' }, 'Check and save');
  const anyway = h('button', { class: 'linkish', type: 'button', hidden: true }, 'Save it anyway');

  const store = (key) => { keys.set(provider, key); onChange(); renderKeyEditor({ container, keys, current, onChange, validate }); };

  const run = async () => {
    let key = input.value.trim();
    if (key.length === 0) {
      if (provider !== 'Other') { setMessage('Paste your key first.', 'bad'); return; }
      key = NO_KEY; // a service that needs no key
    }
    save.disabled = true; anyway.hidden = true;
    setMessage('Checking your key…');
    const result = await validate(provider, key, current().baseUrl); // the address as typed just now, not as it was when this box was drawn
    save.disabled = false;
    if (result.ok) { store(key); return; }
    setMessage(result.message, 'bad');
    // A browser can't tell "the service blocks web pages" from "no connection"; let the user keep the key and try.
    if (CORS_HINT.test(result.message)) anyway.hidden = false; // only for "couldn't reach it", never for a key that was refused
    anyway.onclick = () => store(key);
  };
  save.addEventListener('click', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });

  container.append(h('div', { class: 'keybox' }, input, reveal), keyHelp, h('div', { class: 'row wrap' }, save, anyway), message);
}

/** The "Remember on this device" switch, shared by both dialogs. */
export function rememberToggle(keys, onChange = () => {}) {
  return checkbox({
    label: 'Remember my keys on this device',
    help: keys.remember
      ? 'Keys stay in this browser until you press “Forget my keys”.'
      : 'Off: a key is kept for this tab only and disappears when the tab closes.',
    checked: keys.remember,
    title: 'Where keys are kept. Always in this browser only, and only ever sent to the AI provider you chose. Nothing goes to the author of this page.',
    onChange: (on) => { keys.setRemember(on); onChange(on); },
  });
}
