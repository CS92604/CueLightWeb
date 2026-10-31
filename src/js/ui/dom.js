// Tiny DOM helpers. Text always goes in as text (never as HTML), and there are no inline styles or event attributes: the
// page's Content Security Policy forbids both.

export const byId = (id) => document.getElementById(id);

/** h('button', { class: 'btn', title: '…', onClick: fn }, 'Label', childElement) */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'hidden') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }

let uid = 0;
export const nextId = (prefix = 'f') => `${prefix}${++uid}`;

/** A group of radio buttons drawn as a segmented control. options: [{ value, label, title }]. */
export function segmented({ name, label, options, value, onChange }) {
  const group = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  for (const o of options) {
    const input = h('input', { type: 'radio', name, value: o.value, checked: o.value === value });
    input.addEventListener('change', () => { if (input.checked) onChange(o.value); });
    group.append(h('label', { title: o.title ?? null }, input, h('span', {}, o.label)));
  }
  return group;
}

/** A labelled field wrapper. */
export function field(labelText, control, { caption, forId } = {}) {
  return h('div', { class: 'field' },
    forId ? h('label', { for: forId }, labelText) : h('span', { class: 'legend' }, labelText),
    control,
    caption ? h('p', { class: 'caption' }, caption) : null);
}

export function checkbox({ label, help, checked, onChange, title }) {
  const input = h('input', { type: 'checkbox', checked: Boolean(checked) });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'check', title: title ?? null }, input, h('div', {}, h('b', {}, label), help ? h('span', {}, help) : null));
}

/** Copy text to the clipboard; resolves true on success. Falls back to a hidden textarea where the async API is missing. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h('textarea', { class: 'visually-hidden', 'aria-hidden': 'true', tabindex: '-1' });
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* not allowed */ }
    area.remove();
    return ok;
  }
}
