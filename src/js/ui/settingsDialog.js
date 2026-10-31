// The Settings dialog: provider and key, how replies sound, speech recognition, privacy.
import { PROVIDERS, getProvider, Provider } from '../core/providers.js';
import {
  Professionalism, Proficiency, Tone, ReplyLength, SpeechAccuracy, ScreenReading, captionProficiency, useProvider, normalized,
} from '../core/settings.js';
import { h, clear, segmented, field, checkbox, nextId } from './dom.js';
import { renderKeyEditor, rememberToggle } from './keyEditor.js';
import { WEB_SPEECH_WARNING } from '../stt/webspeech.js';

const opts = (map) => Object.entries(map).map(([value, label]) => ({ value, label }));

export const SPEECH_CAPTIONS = Object.freeze({
  [SpeechAccuracy.Fast]: 'Fast: the quickest. A small download (roughly 40 MB the first time) and the best choice on a phone.',
  [SpeechAccuracy.Balanced]: 'Balanced: a good middle (roughly 80 MB the first time).',
  [SpeechAccuracy.Accurate]: 'Accurate: the most accurate, slower, and a large download (roughly 250 MB the first time). Best on a computer with WebGPU.',
});

/**
 * @param {object} o
 * @param {HTMLDialogElement} o.dialog
 * @param {HTMLElement} o.fields
 * @param {import('../keys.js').KeyStore} o.keys
 * @param {()=>object} o.getSettings
 * @param {(s:object)=>void} o.update  called with the new settings after every change
 * @param {{webGpu:boolean, browserSpeech:boolean, phone:boolean, onForgetKeys:()=>void}} o.env
 */
export function createSettingsDialog({ dialog, fields, keys, getSettings, update, env }) {
  function build() {
    clear(fields);
    const s = normalized(getSettings());
    const info = getProvider(s.provider);
    const change = (patch) => { update(normalized({ ...getSettings(), ...patch })); };

    // -- provider, key, model
    fields.append(h('h3', { class: 'section-title' }, 'AI provider'));
    fields.append(segmented({
      name: 'provider', label: 'AI provider', value: s.provider,
      options: PROVIDERS.map((p) => ({ value: p.id, label: p.name, title: p.blurb })),
      onChange: (id) => { update(normalized(useProvider(getSettings(), id))); build(); },
    }));
    fields.append(h('p', { class: 'caption' }, info.blurb));

    const keyBox = h('div', {});
    fields.append(h('h3', { class: 'section-title' }, `${info.isCustom ? 'Service' : info.name} API key`), keyBox);
    renderKeyEditor({ container: keyBox, keys, current: () => ({ provider: getSettings().provider, baseUrl: getSettings().baseUrl }), onChange: () => update(normalized(getSettings())) });
    fields.append(rememberToggle(keys, () => build()));

    if (info.isCustom) {
      const addr = h('input', { class: 'input', id: nextId('addr'), type: 'url', inputmode: 'url', autocapitalize: 'off', spellcheck: 'false', placeholder: 'https://openrouter.ai/api/v1', value: s.baseUrl });
      addr.addEventListener('change', () => change({ baseUrl: addr.value.trim() }));
      fields.append(field('Service address', addr, { forId: addr.id,
        caption: 'https:// always works. http:// only for this device or your own network. A browser also blocks a page served over https from calling an http:// address other than localhost.' }));
    }
    fields.append(h('h3', { class: 'section-title' }, 'Model'));
    if (info.models.length > 0) {
      fields.append(segmented({
        name: 'model', label: 'Model', value: s.model,
        options: info.models.map((m) => ({ value: m.id, label: m.name, title: m.tip || m.blurb })),
        onChange: (id) => { change({ model: id }); build(); },
      }));
      const chosen = info.models.find((m) => m.id === s.model);
      if (chosen) fields.append(h('p', { class: 'caption' }, `${chosen.blurb}. ${chosen.tip}`.replace(/\.\s*\./g, '.')));
    }
    if (!info.isClaude) {
      const model = h('input', { class: 'input', id: nextId('model'), type: 'text', autocapitalize: 'off', spellcheck: 'false', placeholder: info.isCustom ? 'a model name, e.g. llama3' : info.defaultModel, value: s.model });
      model.addEventListener('change', () => { change({ model: model.value.trim() }); build(); });
      fields.append(field(info.isCustom ? 'Model name' : 'Or type any model name', model, { forId: model.id,
        caption: 'A model with no listed price is still counted, in tokens.' }));
    }
    const think = checkbox({ label: 'Think first', help: 'Let the AI think before it replies: better on hard questions, slower to start. Off is best for a live conversation.', checked: s.thinkFirst, onChange: (v) => change({ thinkFirst: v }) });
    fields.append(think);

    // -- how replies sound
    fields.append(h('h3', { class: 'section-title' }, 'How replies sound'));
    fields.append(field('Professionalism', segmented({ name: 'prof', label: 'Professionalism', value: s.professionalism, onChange: (v) => change({ professionalism: v }),
      options: [{ value: Professionalism.VeryCasual, label: 'Very casual' }, { value: Professionalism.Casual, label: 'Casual' }, { value: Professionalism.Professional, label: 'Professional' }, { value: Professionalism.Formal, label: 'Formal' }] })));
    const cap = h('p', { class: 'caption' }, captionProficiency(s.proficiency));
    fields.append(h('div', { class: 'field' }, h('span', { class: 'legend' }, 'Proficiency'),
      segmented({ name: 'skill', label: 'Proficiency', value: s.proficiency, options: opts({ [Proficiency.Simple]: 'Simple', [Proficiency.Everyday]: 'Everyday', [Proficiency.Fluent]: 'Fluent', [Proficiency.Advanced]: 'Advanced' }),
        onChange: (v) => { change({ proficiency: v }); cap.textContent = captionProficiency(v); } }),
      cap, h('p', { class: 'caption faint' }, 'How much jargon replies use and how deeply they explain things.')));
    fields.append(field('Tone', segmented({ name: 'tone', label: 'Tone', value: s.tone, onChange: (v) => change({ tone: v }),
      options: opts({ [Tone.Warm]: 'Warm', [Tone.Neutral]: 'Neutral', [Tone.Direct]: 'Direct', [Tone.Diplomatic]: 'Diplomatic', [Tone.Confident]: 'Confident' }) })));
    fields.append(h('div', { class: 'two' },
      field('Length', segmented({ name: 'len', label: 'Length', value: s.length, onChange: (v) => change({ length: v }), options: opts({ [ReplyLength.Brief]: 'Brief', [ReplyLength.Short]: 'Short', [ReplyLength.Detailed]: 'Detailed' }) })),
      field('Options per section', segmented({ name: 'opts', label: 'Options per section', value: String(s.options), onChange: (v) => change({ options: Number(v) }), options: [{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }] }))));
    const lang = h('input', { class: 'input', id: nextId('lang'), type: 'text', placeholder: 'Same as the other person', value: s.replyLanguage, maxlength: 60 });
    lang.addEventListener('input', () => change({ replyLanguage: lang.value }));
    fields.append(field('Reply language', lang, { forId: lang.id }));
    const about = h('textarea', { class: 'input', id: nextId('about'), placeholder: 'Who you are, words to avoid, background for the conversation. Nothing here is shared except with your AI provider.', maxlength: 1500 });
    about.value = s.customInstructions;
    about.addEventListener('input', () => change({ customInstructions: about.value }));
    fields.append(field('About me', about, { forId: about.id, caption: 'The AI never claims expertise or experience you haven’t written here.' }));

    // -- speech
    fields.append(h('h3', { class: 'section-title' }, 'Speech recognition'));
    const speechCap = h('p', { class: 'caption' }, SPEECH_CAPTIONS[s.speechAccuracy]);
    fields.append(h('div', { class: 'field' }, h('span', { class: 'legend' }, 'Speech accuracy'),
      segmented({ name: 'speech', label: 'Speech accuracy', value: s.speechAccuracy, options: opts({ [SpeechAccuracy.Fast]: 'Fast', [SpeechAccuracy.Balanced]: 'Balanced', [SpeechAccuracy.Accurate]: 'Accurate' }),
        onChange: (v) => { change({ speechAccuracy: v }); speechCap.textContent = SPEECH_CAPTIONS[v]; } }),
      speechCap,
      h('p', { class: 'caption faint' }, `Speech is turned into words on this device with Whisper (${env.webGpu ? 'WebGPU is available here' : 'no WebGPU here, so it runs on the processor, which is slower'}). The model downloads once from huggingface.co and is then kept by your browser.`)));
    const browserBox = checkbox({
      label: 'Use the browser’s built-in speech recognition (sends your audio to Google or Apple)',
      help: env.browserSpeech ? 'Quicker to start and no download, but it listens to the microphone only. Off by default.' : 'This browser has no built-in speech recognition.',
      checked: s.useBrowserSpeech && env.browserSpeech, onChange: (v) => { change({ useBrowserSpeech: v }); build(); },
      title: 'Off keeps the sound on this device. On, your browser sends the microphone audio to its maker’s servers (Google for Chrome and Edge, Apple for Safari) to be turned into words.',
    });
    if (!env.browserSpeech) browserBox.querySelector('input').disabled = true;
    fields.append(browserBox);
    if (s.useBrowserSpeech && env.browserSpeech) fields.append(h('p', { class: 'warn' }, WEB_SPEECH_WARNING));

    // -- privacy
    fields.append(h('h3', { class: 'section-title' }, 'Privacy'));
    fields.append(h('p', { class: 'caption' }, 'Your keys live in this browser only and are sent only to the provider you chose. There is no analytics and nothing is sent to the author of this page.'));
    fields.append(h('div', { class: 'row wrap' },
      h('button', { class: 'btn', type: 'button', title: 'Delete every saved API key from this browser.', onClick: () => { env.onForgetKeys(); build(); } }, 'Forget my keys')));
    fields.append(h('h3', { class: 'section-title' }, 'About'));
    fields.append(h('p', { class: 'caption' }, 'CueLight Web is the web version of the ',
      h('a', { href: 'https://github.com/CS92604/CueLight', target: '_blank', rel: 'noopener noreferrer' }, 'CueLight desktop app for Windows'),
      '. The prompts are duplicated from it and kept in sync by hand. Source: ',
      h('a', { href: 'https://github.com/CS92604/CueLightWeb', target: '_blank', rel: 'noopener noreferrer' }, 'CueLightWeb'), '.'));
  }

  return {
    open() { build(); if (!dialog.open) dialog.showModal(); },
    close() { dialog.close(); },
    rebuild: build,
  };
}
