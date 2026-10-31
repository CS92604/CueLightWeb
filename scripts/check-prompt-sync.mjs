// Compares the text the AI is given with the desktop app's: the system prompt, the task lines, the style wording and the
// model lists. They are copies, kept in sync by hand; this finds the drift.
//   node scripts/check-prompt-sync.mjs <path to a checkout of cs92604/CueLight>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.resolve(process.argv[2] ?? '../CueLight');
const core = path.join(desktop, 'src', 'Cuelight.Core');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n');

if (!fs.existsSync(path.join(core, 'Prompting.cs'))) {
  console.error(`No desktop checkout at ${desktop} (looked for src/Cuelight.Core/Prompting.cs).`);
  process.exit(2);
}

const problems = [];
const prompting = read(core, 'Prompting.cs');
const settingsCs = read(core, 'Settings.cs');
const providersCs = read(core, 'Providers.cs');

// 1. The system prompt, character for character.
const m = prompting.match(/SystemPrompt = """\n([\s\S]*?)\n\s*""";/);
if (!m) problems.push('Could not find SystemPrompt in Prompting.cs');
else {
  const expected = m[1].split('\n').map((l) => (l.startsWith('        ') ? l.slice(8) : l)).join('\n');
  const { SYSTEM_PROMPT } = await import(pathToFileURL(path.join(root, 'src/js/core/systemPrompt.js')).href);
  if (SYSTEM_PROMPT !== expected) {
    let i = 0; while (i < expected.length && expected[i] === SYSTEM_PROMPT[i]) i++;
    problems.push(`The system prompt differs from the desktop app's, first at character ${i}: web "${SYSTEM_PROMPT.slice(Math.max(0, i - 20), i + 40)}" / desktop "${expected.slice(Math.max(0, i - 20), i + 40)}"`);
  }
}

// 2. Every plain string the desktop builds the task lines, style wording and model texts from must be in the web code.
const noComments = (source) => source.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const between = (source, from, to) => source.slice(source.indexOf(from), to ? source.indexOf(to) : undefined);
const literals = (source) => [...noComments(source).matchAll(/"([^"\n]{13,})"/g)].map((x) => x[1]).filter((s) => !s.includes('{') && !s.includes('\\'));
const web = (f) => fs.readFileSync(path.join(root, 'src', 'js', 'core', f), 'utf8');
const checks = [
  ['Prompting.cs task lines', literals(between(prompting, 'private static string TaskLine', 'public enum SectionKind')), web('prompting.js')],
  ['Prompting.cs screen text block', literals(between(prompting, 'public static string ScreenTextBlock', 'public static string BuildUserText')), web('prompting.js')],
  ['Settings.cs style wording', literals(between(settingsCs, 'public string ToPrompt', 'public sealed record ModelChoice')), web('settings.js')],
  ['Settings.cs Claude models', literals(between(settingsCs, 'public static class Models', 'public sealed class SettingsStore')), web('providers.js')],
  ['Providers.cs models and blurbs', literals(providersCs), web('providers.js')],
];
for (const [name, strings, target] of checks) {
  const t = target.replace(/\\'/g, "'");
  for (const s of new Set(strings)) {
    if (/^https?:\/\//.test(s)) continue;
    if (!t.includes(s) && !t.includes(s.replace(/'/g, "\\'"))) problems.push(`${name}: not found in the web code: “${s.slice(0, 90)}${s.length > 90 ? '…' : ''}”`);
  }
}

if (problems.length) {
  console.error(`The web prompts have drifted from the desktop app (${desktop}):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('The prompts, style wording and model lists match the desktop app.');
