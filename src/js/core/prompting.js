// Port of Prompting.cs (cs92604/CueLight): builds the message the AI is sent and parses what it writes back.
// The prompt text is a duplicate of the desktop app's and must be kept in sync with it.
import { SYSTEM_PROMPT } from './systemPrompt.js';
import { toPrompt } from './settings.js';

export { SYSTEM_PROMPT };

/** Which channel(s) triggered a request. Forced is the Panic button; Pause is a follow-up sent after several quiet
 *  seconds, when the first look at what was said found nothing to reply to. These are bit flags. */
export const Trigger = Object.freeze({ None: 0, Speech: 1, Text: 2, Manual: 4, Forced: 8, Pause: 16 });

/**
 * One request for suggestions.
 * @typedef {object} SuggestionRequest
 * @property {string} transcript
 * @property {import('./settings.js').Settings} settings
 * @property {number} trigger  Trigger flags
 * @property {string|null} [hint]
 * @property {{mediaType:string,data:string}|null} [regionImage]  the watched region or photo, base64 (no data: prefix)
 * @property {string[]|null} [rejected]
 * @property {string|null} [regionText]  words read from the region (Fast screen reading); then regionImage is null
 * @property {(usage:import('./usage.js').TokenUsage)=>void} [onUsage]
 */

/** Something from the watched region goes with this request, as a picture or as text. */
export function hasScreen(r) {
  return Boolean(r.regionImage) || (r.regionText !== null && r.regionText !== undefined);
}

/** About this many characters of conversation go into each cacheable block. */
export const CHUNK_CHARS = 2000;

/** The most read-out screen text that goes into one request. */
export const MAX_SCREEN_TEXT_CHARS = 8000;

/**
 * Everything that goes before the screen picture, in the order Claude reads it. The front of the conversation never
 * changes between requests (only the newest turn is still being added to), so it is cut into blocks and a cache marker
 * goes after the last complete one. Returns [{ text, cacheAfter }].
 */
export function frontBlocks(r) {
  const blocks = [
    { text: `<style_settings>\n${toPrompt(r.settings)}\n</style_settings>\n\n<conversation_so_far>\n`, cacheAfter: false },
  ];
  if (r.transcript.length === 0) {
    blocks.push({ text: '(no speech yet)\n', cacheAfter: false });
    return blocks;
  }

  const lines = r.transcript.split('\n');
  let chunk = '';
  let cacheIndex = -1;
  for (let i = 0; i < lines.length - 1; i++) { // every line but the newest is final
    chunk += lines[i] + '\n';
    if (chunk.length < CHUNK_CHARS) continue;
    blocks.push({ text: chunk, cacheAfter: false });
    cacheIndex = blocks.length - 1;
    chunk = '';
  }
  chunk += lines[lines.length - 1] + '\n'; // the newest line can still grow, so it is never cached
  blocks.push({ text: chunk, cacheAfter: false });
  if (cacheIndex >= 0) blocks[cacheIndex] = { ...blocks[cacheIndex], cacheAfter: true };
  return blocks;
}

/** Everything that goes after the screen picture: what changed, the direction, the task. */
export function tailText(r) {
  const t = r.trigger ?? Trigger.None;
  const changed = [];
  if ((t & Trigger.Speech) || (t & Trigger.Pause)) changed.push('spoken');
  if (t & Trigger.Text) changed.push('written');
  if (changed.length === 0) {
    changed.push('spoken');
    if (hasScreen(r)) changed.push('written');
  }

  const parts = ['</conversation_so_far>'];
  if (r.regionImage) parts.push("The attached image is the region of my screen I'm watching for written messages.");
  else if (r.regionText !== null && r.regionText !== undefined) parts.push(screenTextBlock(r.regionText));
  if (r.rejected && r.rejected.length > 0)
    parts.push('<rejected_suggestions>\n' + r.rejected.join('\n---\n') + '\n</rejected_suggestions>');
  parts.push(`<changed>${changed.join(', ')}</changed>`);
  parts.push(taskLine(t, hasScreen(r)) + (r.hint && r.hint.length > 0 ? `\nExtra direction from me: ${r.hint}` : ''));
  return parts.join('\n\n');
}

/** The words read from the watched region, in a tag the AI can tell from the conversation. Over-long text keeps its
 *  end, which is where the newest message is. */
export function screenTextBlock(text) {
  text = text.trim().replace(/<\/screen_text>/gi, '< /screen_text>');
  if (text.length > MAX_SCREEN_TEXT_CHARS) text = '… ' + text.slice(text.length - MAX_SCREEN_TEXT_CHARS);
  return "Below is the text read from the region of my screen I'm watching for written messages. It was read automatically, "
    + "line by line from the top, so it may contain mistakes and doesn't show who wrote what.\n<screen_text>\n" + text + '\n</screen_text>';
}

/** The whole message as one piece of text (the picture, if any, is sent separately). */
export function buildUserText(r) {
  return frontBlocks(r).map((b) => b.text).join('') + tailText(r);
}

export function taskLine(t, hasImage) {
  if (t & Trigger.Forced)
    return 'I pressed the panic button because I need to reply right now. Read the attached region of my screen as it is at this moment, find the newest message not written by me, and give me what to TYPE. If the last thing said out loud also needs an answer, give me what to SAY too.';
  if ((t & Trigger.Pause) && !(t & Trigger.Text))
    return 'It has been quiet for several seconds since they last spoke, so they are probably waiting for me. Give me what to SAY: if what they last said was a question, a riddle or a sentence left hanging, start with the answer or the most likely way to finish it.';
  t &= Trigger.Speech | Trigger.Text;
  switch (t) {
    case Trigger.Speech: return 'Something new was just said out loud. Give me what to SAY.';
    case Trigger.Text: return 'The written text in the attached region just changed. Give me what to TYPE.';
    case Trigger.Speech | Trigger.Text: return 'Both the spoken conversation and the written text just changed. Give me what to SAY and what to TYPE.';
    default:
      return hasImage
        ? 'I asked for suggestions. Give me SAY and/or TYPE, whichever have something to reply to.'
        : 'I asked for suggestions. No text area is being watched, so give me what to SAY only.';
  }
}

export const SectionKind = Object.freeze({ Say: 'Say', Type: 'Type', Answer: 'Answer', Note: 'Note' });

const HEADING = /^\s*(?:#+\s*)?\**\s*(SAY|TYPE|ANSWER)\s*:?\s*\**\s*$/i;
const BULLET = /^\s*(?:[•\-*]|\d+[.)])\s+(\S.*)$/;

/** Split the AI's reply into SAY / ANSWER / TYPE sections of copy-pasteable options. Returns [{ kind, options }]. */
export function parseSuggestion(text) {
  const sections = [];
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;

    const heading = HEADING.exec(line);
    if (heading) {
      const word = heading[1].toUpperCase();
      current = { kind: word === 'SAY' ? SectionKind.Say : word === 'ANSWER' ? SectionKind.Answer : SectionKind.Type, options: [] };
      sections.push(current);
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      if (current === null) {
        current = { kind: SectionKind.Say, options: [] };
        sections.push(current);
      }
      current.options.push(bullet[1].trim());
    } else if (current !== null && current.options.length > 0) {
      current.options[current.options.length - 1] += ' ' + line; // wrapped continuation of the previous option
    } else {
      if (current === null || current.kind !== SectionKind.Note) {
        current = { kind: SectionKind.Note, options: [] };
        sections.push(current);
      }
      current.options.push(line);
    }
  }
  return sections.filter((s) => s.options.length > 0);
}
