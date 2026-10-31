// The first-run dialog: pick a provider and paste a key.
import { PROVIDERS, getProvider } from '../core/providers.js';
import { useProvider, normalized } from '../core/settings.js';
import { h, clear, segmented } from './dom.js';
import { renderKeyEditor, rememberToggle } from './keyEditor.js';

export function createWelcome({ dialog, fields, keys, getSettings, update, onDone, phone }) {
  function build() {
    clear(fields);
    const s = normalized(getSettings());
    const info = getProvider(s.provider);
    fields.append(h('p', { class: 'legend' }, 'Choose your AI'));
    fields.append(segmented({
      name: 'welcome-provider', label: 'Choose your AI', value: s.provider,
      options: PROVIDERS.map((p) => ({ value: p.id, label: p.name, title: p.blurb })),
      onChange: (id) => { update(normalized(useProvider(getSettings(), id))); build(); },
    }));
    fields.append(h('p', { class: 'caption' }, info.blurb));

    if (info.isCustom) {
      const addr = h('input', { class: 'input', type: 'url', inputmode: 'url', autocapitalize: 'off', spellcheck: 'false', placeholder: 'https://openrouter.ai/api/v1', 'aria-label': 'Service address', value: s.baseUrl });
      addr.addEventListener('change', () => update(normalized({ ...getSettings(), baseUrl: addr.value.trim() })));
      fields.append(h('div', { class: 'field' }, h('p', { class: 'legend' }, 'Service address'), addr, h('p', { class: 'caption' }, 'You can enter the model name in Settings.')));
    }
    const keyBox = h('div', { class: 'field' });
    fields.append(h('p', { class: 'legend' }, `${info.isCustom ? 'Service' : info.name} API key`), keyBox);
    renderKeyEditor({ container: keyBox, keys, current: () => ({ provider: getSettings().provider, baseUrl: getSettings().baseUrl }), onChange: () => { if (keys.has(getSettings().provider)) { dialog.close(); onDone(); } } });
    fields.append(rememberToggle(keys));
    fields.append(h('p', { class: 'caption faint' },
      'Your key stays in this browser and is only ever sent to ', info.isCustom ? 'the service you entered' : info.company,
      '. Speech is turned into text on this ', phone ? 'phone' : 'device', '; only text, and a picture if you add one, is sent to your AI. Nothing goes to the author of this page.'));
    fields.append(h('p', { class: 'caption faint' }, 'AI providers bill API use separately from any chat subscription. A suggestion costs a fraction of a cent to a few cents; the page shows the running total.'));
    fields.append(h('div', { class: 'dialog-foot' }, h('button', { class: 'btn quiet', type: 'button', onClick: () => { dialog.close(); onDone(); } }, 'Not now')));
  }
  return { open() { build(); if (!dialog.open) dialog.showModal(); } };
}
