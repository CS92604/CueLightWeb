// Port of TranscriptCleaner (Audio.cs): removes the non-speech annotations Whisper emits for noise, music and silence.

const ANNOTATION = /[[({][^\])}]*[\])}]|[♪♫🎵]+/g;
// Phrases Whisper invents out of near-silence and music (it was trained on video subtitles).
const INVENTED = /thank(?:s| you) for watching[.!]?|subtitles? by the amara\.org community|(?:please (?:like and )?|like and )subscribe(?: to (?:my|the|our) channel)?[.!]?|subscribe to (?:my|the|our) channel[.!]?|transcribed by [\w .]+?(?=[.!]|$)/gi;

export function cleanTranscript(text) {
  const t = String(text ?? '').replace(ANNOTATION, ' ').replace(INVENTED, ' ').replace(/\s+/g, ' ').trim();
  // Only punctuation left (e.g. "..." or "-"): nothing was actually said.
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}
