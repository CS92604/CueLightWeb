// Port of Conversation.cs: the rolling transcript, with the windowed view that trims in jumps so the start of what the
// AI is sent stays the same from one request to the next (which keeps the provider's prompt cache useful).

export const Speaker = Object.freeze({ Them: 'Them', Me: 'Me' });

/** The longest stretch of one person's talk that is sent whole. A monologue past this keeps only its latest part. */
export const MAX_TURN_CHARS = 5000;

const OMITTED_NOTICE = '[earlier conversation omitted]';

const line = (t) => `${t.speaker}: ${t.text.length > MAX_TURN_CHARS ? '… ' + t.text.slice(t.text.length - MAX_TURN_CHARS) : t.text}`;

export class Conversation {
  #turns = [];
  #floor = 0; // the first turn that is still sent; only ever moves forward, and in jumps

  add(speaker, text) {
    text = text.trim();
    if (text.length === 0) return;
    const last = this.#turns[this.#turns.length - 1];
    // Merge consecutive turns by the same speaker (one person, several pauses).
    if (last && last.speaker === speaker) last.text = last.text + ' ' + text;
    else this.#turns.push({ speaker, text });
  }

  clear() { this.#turns = []; this.#floor = 0; }

  get isEmpty() { return this.#turns.length === 0; }

  get turns() { return this.#turns.map((t) => ({ ...t })); }

  /**
   * The recent conversation for a request, oldest first, whole turns only. Unlike render() this trims in jumps: once
   * the text passes maxChars the oldest turns are dropped until about keepChars remain, and then nothing more is
   * dropped for a good while.
   */
  window(maxChars, keepChars) {
    const turns = this.#turns;
    if (this.#floor > turns.length) this.#floor = 0;
    let total = 0;
    for (let i = this.#floor; i < turns.length; i++) total += line(turns[i]).length + 1;
    const size = () => total + (this.#floor > 0 ? OMITTED_NOTICE.length + 1 : 0);
    if (size() > maxChars)
      while (this.#floor < turns.length - 1 && size() > keepChars) // trim well below the limit, not just under it
        total -= line(turns[this.#floor++]).length + 1;

    const lines = [];
    if (this.#floor > 0) lines.push(OMITTED_NOTICE);
    for (let i = this.#floor; i < turns.length; i++) lines.push(line(turns[i]));
    return lines.join('\n');
  }

  /** Newest turns that fit in maxChars, oldest first. Whole turns only. */
  render(maxChars) {
    const turns = this.#turns;
    const lines = [];
    let used = 0;
    let dropped = false;
    for (let i = turns.length - 1; i >= 0; i--) {
      const l = `${turns[i].speaker}: ${turns[i].text}`;
      if (lines.length > 0 && used + l.length > maxChars) { dropped = true; break; }
      lines.push(l);
      used += l.length + 1;
    }
    lines.reverse();
    if (dropped) lines.unshift(OMITTED_NOTICE);
    return lines.join('\n');
  }
}
