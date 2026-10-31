// Port of Engine.cs: holds the conversation and turns it into streamed suggestions.
//
// Two things can trigger a suggestion: new speech from "Them", and the watched region (or a new photo) changing.
// Requests are coalesced: a newer trigger supersedes one still waiting or streaming, and the channels that triggered
// are merged, so if speech and on-screen text change together the AI is asked for both a SAY and a TYPE reply.
//
// Two switches gate everything: paused (recording off: nothing is watched and nothing is sent) and textEnabled (TYPE
// off: the region is ignored and only speech is used).
//
// Each request carries the recent conversation but only the current picture of the watched region; earlier pictures are
// never kept or resent. panic() forces an immediate re-read of the region, and regenerate() redoes the last reply with
// a different take.
import { Conversation, Speaker } from './core/conversation.js';
import { Trigger, hasScreen } from './core/prompting.js';
import { normalized } from './core/settings.js';
import { canSeePictures } from './core/providers.js';
import { UsageMeter } from './core/usage.js';
import { describe as describeError } from './suggest/errors.js';

export const EngineEventKind = Object.freeze({
  Turn: 'Turn', SuggestStart: 'SuggestStart', Chunk: 'Chunk', SuggestEnd: 'SuggestEnd', Status: 'Status', Error: 'Error',
  RegionChanged: 'RegionChanged', ModeChanged: 'ModeChanged', Recovered: 'Recovered', Usage: 'Usage', Hearing: 'Hearing', Live: 'Live',
});

export const defaultEngineOptions = () => ({
  autoSuggest: true,
  /** Ignore short backchannels ("mm-hmm", "okay") for automatic suggestions. */
  autoMinWords: 4,
  /** Wait this long after the last trigger before asking. Speech has already been cut at a pause and takes a moment to
   *  transcribe, so this only needs to merge triggers that arrive almost together. */
  debounceMs: 400,
  /** If the AI found nothing to reply to after the other person spoke, and then nobody says anything for this long, ask
   *  once more, telling it the pause is long: they are probably waiting for an answer. 0 or Infinity turns this off. */
  pauseFollowUpMs: 4000,
  /** Max time to hold a spoken request while the watched text is still changing. */
  mergeHoldMs: 3000,
  /** How much conversation, at most, goes with each request (about 5,000 words: over half an hour of talk). */
  transcriptChars: 30_000,
  /** When the conversation passes transcriptChars the oldest turns are dropped until about this much is left. Trimming
   *  in a jump keeps the start of what is sent the same for many requests in a row, so the prompt cache keeps working. */
  transcriptKeepChars: 20_000,
});

const MAX_REJECTED = 3;
const MAX_REJECTED_CHARS = 1500;

export const CANT_READ_PICTURES = (model) =>
  `“${model}” can't read pictures, so Type can't use it. Pick another model in Settings, or turn Type off.`;

const sameWords = (a, b) => b !== null && b !== undefined
  && a.split(/\s+/).filter(Boolean).join(' ') === b.split(/\s+/).filter(Boolean).join(' ');

export class Engine {
  #suggester; #capture; #textReader; #watcherFactory;
  #listeners = new Set();
  #kinds = Trigger.None;
  #hint = null;
  #immediate = false; // skip the merge hold (Panic / Regenerate)
  #redo = false; // the pending run redoes the last reply
  #lastKinds = Trigger.None; // what the most recent run was asked, for Regenerate
  #lastHint = null;
  #lastReply = '';
  #turnSeq = 0; // counts turns added, so a follow-up can tell whether anything was said since
  #rejected = []; // replies the user has regenerated away
  #deadline = null; // seconds on the clock
  #queuedAt = 0;
  #runAbort = null;
  #clearEpoch = 0;
  #lastScreenText = null; // the words last sent from the watched region (Fast screen reading), to skip a repeat
  #warnedNoReader = false;
  #watcher = null;
  #speaking = new Set();
  #liveText = new Map();
  #stopped = false;
  #loopPromise = null;
  #signalled = false;
  #wake = null;
  #followUpTimers = new Set();

  /**
   * @param {object} o
   * @param {object} o.options  see defaultEngineOptions()
   * @param {{stream:(request:object, signal:AbortSignal)=>AsyncIterable<string>}} o.suggester
   * @param {{capture:(region:any)=>Promise<{mediaType:string,data:string}|null>, grab?:(region:any)=>Promise<{rgba:Uint8ClampedArray,width:number,height:number}>, release?:(region:any)=>void}} o.capture
   * @param {(region:any, onChange:()=>void, onError:(m:string)=>void)=>({pending:boolean,start:()=>void,dispose:()=>void}|null)} [o.watcherFactory]
   * @param {{isAvailable:boolean, read:(rgba:any,width:number,height:number,signal:AbortSignal)=>Promise<string>}} [o.textReader]
   * @param {()=>number} [o.now]  seconds; replaceable in tests
   */
  constructor({ options, suggester, capture, watcherFactory = null, textReader = null, now = () => performance.now() / 1000 }) {
    this.options = { ...defaultEngineOptions(), ...(options ?? {}) };
    this.#suggester = suggester;
    this.#capture = capture;
    this.#textReader = textReader;
    this.#watcherFactory = watcherFactory;
    this.#now = now;
    this.settings = normalized(null);
    this.conversation = new Conversation();
    this.usage = new UsageMeter();
    this.region = null;
    /** Recording is off: nothing is watched, nothing triggers, nothing is sent. */
    this.paused = false;
    /** TYPE is on: the selected region is watched and included in requests. */
    this.textEnabled = true;
  }

  #now;
  get #clock() { return this.#now(); }

  /** Subscribe to events; returns the unsubscribe function. Listeners are called synchronously. */
  on(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  #emit(kind, extra = {}) {
    const e = { kind, text: null, speaker: null, region: null, ...extra };
    for (const l of [...this.#listeners]) { try { l(e); } catch (err) { console.error(err); } }
  }

  start() { this.#loopPromise ??= this.#loop(); }

  // -- state shown by the UI --------------------------------------------------------------------------------------

  /** Someone is speaking right now (on the speakers, or into the microphone if it is on). */
  get isHearingSpeech() { return !this.paused && this.#speaking.size > 0; }

  /** Who is speaking right now, if anyone: the other person when both are. */
  get hearingWho() {
    return this.paused || this.#speaking.size === 0 ? null : this.#speaking.has(Speaker.Them) ? Speaker.Them : Speaker.Me;
  }

  /** The words of what `who` is saying right now, as far as they are known (a preview that the real transcript replaces). */
  liveText(who) { return this.#liveText.get(who) ?? null; }

  /** True while the screen region is actually being polled. */
  get isWatching() { return this.region !== null && this.textEnabled && !this.paused; }

  /** Show the words so far of what someone is saying (null or empty: nothing to show). Called by the audio side. */
  setLive(who, text) {
    text = text == null || text.trim() === '' ? null : text.trim();
    if (this.paused) text = null;
    const old = this.#liveText.get(who) ?? null;
    const changed = old !== text;
    if (text === null) this.#liveText.delete(who); else this.#liveText.set(who, text);
    if (changed) this.#emit(EngineEventKind.Live, { text, speaker: who });
  }

  /** Called by the audio side when a person starts or stops speaking. */
  setSpeaking(who, speaking) {
    const before = !this.paused && this.#speaking.size > 0;
    if (speaking) this.#speaking.add(who); else this.#speaking.delete(who);
    const after = !this.paused && this.#speaking.size > 0;
    if (before !== after) this.#emit(EngineEventKind.Hearing, { speaker: who });
  }

  // -- watched region ---------------------------------------------------------------------------------------------

  setRegion(region) {
    this.region = region ?? null;
    this.#lastScreenText = null;
    this.#emit(EngineEventKind.RegionChanged, { region: this.region });
    this.#reconcileWatcher();
  }

  /** Recording on/off. Pausing cancels anything in flight, drops anything pending and stops watching. */
  setPaused(paused) {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this.#speaking.clear();
      this.#liveText.clear();
      this.#clearEpoch++; // the cancelled run must not hand its debt to the next one
      this.#runAbort?.abort();
      this.#deadline = null;
      this.#kinds = Trigger.None;
      this.#hint = null;
      this.#immediate = this.#redo = false;
    }
    this.#reconcileWatcher();
    this.#emit(EngineEventKind.ModeChanged);
    this.#emit(EngineEventKind.Hearing); // the "listening" display follows recording
    if (paused) this.#emit(EngineEventKind.Live);
  }

  /** TYPE on/off. Off ignores the region entirely; the region itself is kept for when it's switched back on. */
  setTextEnabled(enabled) {
    if (this.textEnabled === enabled) return;
    this.textEnabled = enabled;
    if (!enabled) {
      this.#kinds &= ~(Trigger.Text | Trigger.Forced);
      if (this.#kinds === Trigger.None) { this.#deadline = null; this.#hint = null; this.#immediate = this.#redo = false; }
    }
    this.#reconcileWatcher();
    this.#emit(EngineEventKind.ModeChanged);
  }

  /** Make the running watcher match what should be watched right now. */
  #reconcileWatcher() {
    const old = this.#watcher;
    this.#watcher = null;
    old?.dispose();
    if (!this.isWatching || !this.#watcherFactory) return;
    const watcher = this.#watcherFactory(this.region, () => this.onScreenChanged(), (msg) => this.#emit(EngineEventKind.Error, { text: msg }));
    if (!watcher) return;
    this.#watcher = watcher;
    watcher.start();
  }

  /** Surface a problem from a background component (audio device, speech model, ...). */
  raiseError(message) { this.#emit(EngineEventKind.Error, { text: message }); }

  /** The thing that reported `failedMessage` works again; the UI clears that message. */
  raiseRecovered(failedMessage) { this.#emit(EngineEventKind.Recovered, { text: failedMessage }); }

  onScreenChanged() {
    if (this.options.autoSuggest && this.isWatching) this.request(Trigger.Text, null, this.options.debounceMs);
  }

  // -- inputs ----------------------------------------------------------------------------------------------------

  addTurn(speaker, text) {
    text = text.trim();
    if (text.length === 0) return;
    this.conversation.add(speaker, text);
    this.#turnSeq++;
    this.#emit(EngineEventKind.Turn, { text, speaker });
    if (speaker === Speaker.Them && this.options.autoSuggest
      && text.split(/\s+/).filter(Boolean).length >= this.options.autoMinWords)
      this.request(Trigger.Speech, null, this.options.debounceMs);
  }

  /** Ask for a suggestion. With Trigger.None this is a manual request. `delayMs` waits that long first. */
  request(kinds = Trigger.None, hint = null, delayMs = 0, immediate = false) {
    if (this.paused) return;
    this.#runAbort?.abort(); // supersedes anything in flight
    this.#kinds |= kinds === Trigger.None ? Trigger.Manual : kinds;
    if (this.#deadline === null) this.#queuedAt = this.#clock;
    this.#deadline = this.#clock + delayMs / 1000;
    this.#hint = hint ?? this.#hint;
    this.#immediate ||= immediate;
    this.#signal();
  }

  /**
   * The Panic button: right now, re-read the watched region (or photo) and reply to it (and to the last thing said, if it
   * needs an answer). Skips the debounce, the settle wait and the auto-suggest switch. Returns false, and says why, when
   * there is nothing to read.
   */
  panic(hint = null) {
    if (this.paused) { this.#emit(EngineEventKind.Status, { text: 'Recording is off. Turn it on to use Panic.' }); return false; }
    if (!this.textEnabled) { this.#emit(EngineEventKind.Status, { text: 'Turn Type on and pick a text area or add a photo, then Panic can read it.' }); return false; }
    if (this.region === null) { this.#emit(EngineEventKind.Status, { text: 'Pick a text area or add a photo first, then Panic can read it.' }); return false; }
    this.request(Trigger.Manual | Trigger.Forced, hint, 0, true);
    return true;
  }

  /**
   * Redo the last reply: the same kind of request, with the current transcript and settings, and the replies already
   * thrown away passed along so the AI takes a different angle. A new `hint` replaces the previous one; without one the
   * previous hint carries over.
   */
  regenerate(hint = null) {
    if (this.paused) return;
    this.#runAbort?.abort();
    // Aborting takes effect before the reset below, so a stale chunk can't overwrite it.
    if (this.#lastReply.length > 0 && !this.#lastReply.startsWith('(')) {
      this.#rejected.push(this.#lastReply.length > MAX_REJECTED_CHARS ? this.#lastReply.slice(0, MAX_REJECTED_CHARS) : this.#lastReply);
      while (this.#rejected.length > MAX_REJECTED) this.#rejected.shift();
    }
    this.#lastReply = '';
    this.#kinds |= this.#lastKinds === Trigger.None ? Trigger.Manual : this.#lastKinds;
    this.#hint = hint ?? this.#hint ?? this.#lastHint;
    this.#redo = true;
    this.#immediate = true;
    if (this.#deadline === null) this.#queuedAt = this.#clock;
    this.#deadline = this.#clock;
    this.#signal();
  }

  clearConversation() {
    this.#clearEpoch++;
    this.#runAbort?.abort();
    this.#deadline = null;
    this.#kinds = Trigger.None;
    this.#hint = null;
    this.#immediate = this.#redo = false;
    this.#lastKinds = Trigger.None;
    this.#lastHint = null;
    this.#lastReply = '';
    this.#lastScreenText = null;
    this.#rejected.length = 0;
    this.conversation.clear();
  }

  // -- worker ----------------------------------------------------------------------------------------------------

  #signal() {
    this.#signalled = true;
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  #waitSignal(seconds) {
    if (this.#signalled) { this.#signalled = false; return Promise.resolve(); }
    return new Promise((resolve) => {
      let timer = null;
      const done = () => { if (timer !== null) clearTimeout(timer); this.#wake = null; this.#signalled = false; resolve(); };
      this.#wake = done;
      if (Number.isFinite(seconds)) timer = setTimeout(done, Math.max(0, seconds * 1000));
    });
  }

  async #loop() {
    while (!this.#stopped) {
      let kinds = Trigger.None, hint = null, redo = false, rejected = [], epoch = 0, run = false, runSignal = null;
      let wait = Infinity;

      if (this.#deadline !== null) {
        const remaining = this.#deadline - this.#clock;
        if (remaining > 0) wait = remaining;
        else if (!this.#immediate && this.#watcher?.pending && this.#clock - this.#queuedAt < this.options.mergeHoldMs / 1000)
          wait = 0.2; // let the watched text settle so SAY and TYPE arrive together
        else {
          kinds = this.#kinds; hint = this.#hint; redo = this.#redo;
          this.#kinds = Trigger.None; this.#hint = null; this.#deadline = null;
          this.#immediate = this.#redo = false;
          if (!redo) this.#rejected.length = 0; // a new moment: nothing here was thrown away yet
          rejected = [...this.#rejected];
          this.#lastKinds = kinds; this.#lastHint = hint; this.#lastReply = '';
          this.#runAbort = new AbortController();
          runSignal = this.#runAbort.signal;
          epoch = this.#clearEpoch;
          run = true;
        }
      }

      if (run) {
        try { await this.#runAsync(kinds, hint, redo, rejected, runSignal, epoch); }
        catch (err) {
          if (this.#stopped) return;
          // Whatever went wrong, the engine must keep serving later requests.
          console.error('Suggestion run failed', err);
          this.#emit(EngineEventKind.Error, { text: describeError(err) });
          this.#emit(EngineEventKind.SuggestEnd);
        }
      } else {
        await this.#waitSignal(wait);
      }
    }
  }

  async #runAsync(kinds, hint, redo, rejected, signal, epoch) {
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      this.#emit(EngineEventKind.SuggestStart, { text: redo ? 'Trying another take…' : (kinds & Trigger.Forced) ? 'Reading the text area…' : null });
    };

    const settings = normalized(this.settings);
    let image = null;
    let screenText = null;
    const region = this.region;
    let sentImage = false;
    if (region !== null && this.textEnabled && (kinds & ~(Trigger.Speech | Trigger.Pause)) !== Trigger.None) {
      // Spoken-only triggers skip the screen; any other trigger includes what's on screen now.
      const readAsText = this.#readsScreenAsText(settings, region);
      // Only the watched text changed: if its words are the same as the last time, there is nothing new to answer.
      const mayRepeat = !redo && (kinds & ~Trigger.Text) === Trigger.None;
      if (!readAsText && !canSeePictures(settings.provider, settings.model)) {
        // A model that can't read pictures: say so instead of sending one it can't use.
        this.#emit(EngineEventKind.Error, { text: CANT_READ_PICTURES(settings.model) });
        this.#capture.release?.(region);
        if ((kinds & (Trigger.Speech | Trigger.Pause)) === 0) return;
      } else {
        if (!(readAsText && mayRepeat)) start();
        if (readAsText) {
          screenText = await this.#readScreenText(region, signal);
          if (screenText !== null && mayRepeat && sameWords(screenText, this.#lastScreenText)) return;
          start();
          if (screenText !== null) this.#lastScreenText = screenText;
        }
        if (screenText === null) {
          try {
            image = await this.#capture.capture(region);
            sentImage = image !== null && image !== undefined;
          } catch (err) {
            this.#emit(EngineEventKind.Status, { text: `Couldn't capture the text area (${err?.message ?? err}); continuing without it.` });
          }
        }
      }
    }
    start();

    const request = {
      transcript: this.conversation.window(this.options.transcriptChars, this.options.transcriptKeepChars),
      settings, trigger: kinds, hint,
      regionImage: image ?? null,
      rejected: rejected.length > 0 ? rejected : null,
      regionText: screenText,
      onUsage: (u) => { this.usage.add(u); this.#emit(EngineEventKind.Usage); },
    };
    let reply = '';
    let failed = false;
    const seq = this.#turnSeq;
    try {
      for await (const chunk of this.#suggester.stream(request, signal)) {
        if (signal.aborted) throw abortError();
        reply += chunk;
        this.#lastReply = reply; // an aborted run never gets here: the check above ran first
        this.#emit(EngineEventKind.Chunk, { text: chunk });
      }
    } catch (err) {
      if (signal.aborted) {
        // Superseded by a newer trigger: hand what this run owed to the one that replaced it.
        if (!this.#stopped && epoch === this.#clearEpoch) {
          this.#kinds |= kinds;
          this.#hint ??= hint;
        }
        return;
      }
      failed = true;
      this.#emit(EngineEventKind.Error, { text: describeError(err) });
    }
    // The picture was used: it is not kept (a new one replaces it, and nothing old is ever sent again).
    if (sentImage) this.#capture.release?.(region);
    this.#emit(EngineEventKind.SuggestEnd);

    // Spoken words that the AI saw nothing to answer: if the quiet goes on, look again with that in mind.
    if (!failed && (kinds & Trigger.Speech) && !(kinds & Trigger.Pause) && /^\(nothing/i.test(reply.trimStart()))
      this.#scheduleFollowUp(seq, epoch);
  }

  /** Fast screen reading is chosen (or the model can't read pictures) and this device can read text from the screen. */
  #readsScreenAsText(settings, region) {
    if (!this.#textReader || region?.kind === 'photo') return false;
    const wanted = settings.screenReading === 'Fast' || !canSeePictures(settings.provider, settings.model);
    if (!wanted) return false;
    if (this.#textReader.isAvailable) return true;
    if (!this.#warnedNoReader) {
      this.#warnedNoReader = true;
      this.#emit(EngineEventKind.Status, { text: "This browser can't read text from the screen, so the text area is sent as a picture." });
    }
    return false;
  }

  /** The words in the watched region, read here; null if they can't be read, in which case a picture is sent instead. */
  async #readScreenText(region, signal) {
    try {
      const { rgba, width, height } = await this.#capture.grab(region);
      const text = (await this.#textReader.read(rgba, width, height, signal)).trim();
      if ([...text].filter((c) => /[\p{L}\p{N}]/u.test(c)).length >= 2) return text;
      this.#emit(EngineEventKind.Status, { text: 'No words could be read in the text area, so it is sent as a picture.' });
    } catch (err) {
      if (signal.aborted) throw err;
      this.#emit(EngineEventKind.Status, { text: `Couldn't read the words in the text area (${err?.message ?? err}), so it is sent as a picture.` });
    }
    return null;
  }

  #scheduleFollowUp(seq, epoch) {
    const wait = this.options.pauseFollowUpMs;
    if (!(wait > 0) || !Number.isFinite(wait)) return;
    const timer = setTimeout(() => {
      this.#followUpTimers.delete(timer);
      if (this.#stopped) return;
      // Only if the quiet really went on: nothing was said or cleared since, nobody is speaking now, recording is still
      // on, and no other request is already waiting.
      if (this.paused || epoch !== this.#clearEpoch || seq !== this.#turnSeq || this.#speaking.size > 0 || this.#deadline !== null) return;
      this.request(Trigger.Pause);
    }, wait);
    this.#followUpTimers.add(timer);
  }

  dispose() {
    this.#stopped = true;
    this.#runAbort?.abort();
    for (const t of this.#followUpTimers) clearTimeout(t);
    this.#followUpTimers.clear();
    this.#signal();
    this.#watcher?.dispose();
    this.#watcher = null;
  }
}

function abortError() {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

export { Speaker, Trigger, hasScreen };
