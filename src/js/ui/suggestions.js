// Draws the AI's reply as SAY / ANSWER / TYPE sections, each option with a Copy button.
import { SectionKind } from '../core/prompting.js';
import { h, clear, copyText } from './dom.js';

const KINDS = {
  [SectionKind.Say]: { tag: 'SAY', css: 'say', sub: 'out loud', tip: 'SAY: something to say out loud in the conversation.' },
  [SectionKind.Answer]: { tag: 'ANSWER', css: 'answer', sub: 'a fuller answer', tip: 'ANSWER: a fuller answer to the question that was just asked, to say in your own words or draw from. SAY is the quick, conversational reply; this is the explanation behind it.' },
  [SectionKind.Type]: { tag: 'TYPE', css: 'type', sub: 'reply to the text on screen', tip: 'TYPE: a reply to type or paste into the text area you selected.' },
};

/**
 * @param {HTMLElement} container
 * @param {Array<{kind:string, options:string[]}>} sections
 * @param {{final:boolean, typeEnabled:boolean}} o  while streaming, the option being written has no Copy yet
 */
export function renderSections(container, sections, { final, typeEnabled }) {
  clear(container);
  const shown = sections.filter((s) => typeEnabled || s.kind !== SectionKind.Type);
  shown.forEach((section, si) => {
    const kind = KINDS[section.kind];
    const list = h('div', { class: 'group' });
    if (kind) list.append(h('div', { class: 'section-head' }, h('span', { class: `tag ${kind.css}`, title: kind.tip }, kind.tag), h('span', {}, kind.sub)));
    section.options.forEach((text, oi) => {
      const writing = !final && si === shown.length - 1 && oi === section.options.length - 1;
      const note = section.kind === SectionKind.Note;
      const copy = h('button', { class: 'copy', type: 'button', title: 'Copy this suggestion to the clipboard, ready to paste.', 'aria-label': `Copy: ${text.slice(0, 40)}`, hidden: note || writing }, 'Copy');
      copy.addEventListener('click', async () => {
        const ok = await copyText(text);
        copy.textContent = ok ? 'Copied' : 'Couldn’t copy';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
      });
      list.append(h('div', { class: `option${note ? ' note' : ''}${writing ? ' streaming' : ''}` }, h('p', {}, text), copy));
    });
    container.append(list);
  });
  return shown.length > 0;
}
