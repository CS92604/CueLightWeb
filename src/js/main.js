// CueLight Web: wires the engine, the audio and the page together. Everything runs in this browser; the only network
// traffic is to the AI provider you chose (with your key) and, once, to huggingface.co for the speech model.
import { Engine, EngineEventKind as K } from './engine.js';
import { Speaker } from './core/conversation.js';
import { Trigger, parseSuggestion, SectionKind } from './core/prompting.js';
import { normalized, forFirstRun } from './core/settings.js';
import { getProvider, NO_KEY } from './core/providers.js';
import { costLabel, costTip } from './core/usage.js';
import { KeyStore, SettingsStore } from './keys.js';
import { createSuggester } from './suggest/router.js';
import { AudioPipeline } from './audio/pipeline.js';
import { ListeningSession } from './audio/session.js';
import { BrowserSpeech } from './stt/webspeech.js';
import { SpeechService } from './speech.js';
import { PhotoSlot } from './screen/photoSlot.js';
import { makeCapture } from './screen/capture.js';
import { VideoRegionSource } from './screen/videoSource.js';
import { RegionWatcher } from './screen/watcher.js';
import { regionLabel } from './screen/region.js';
import { preparePhoto } from './screen/photo.js';
import { TesseractReader } from './screen/ocr.js';
import { isPhoneMode, hasWebGpu, hasBrowserSpeech, canShareTabAudio } from './device.js';
import { byId as $, h, clear } from './ui/dom.js';
import { renderSections } from './ui/suggestions.js';
import { createSettingsDialog } from './ui/settingsDialog.js';
import { createWelcome } from './ui/welcome.js';
import { pickRegion } from './ui/picker.js';

const PAUSED_TEXT = 'Recording is off. Nothing is being heard, watched or sent.';
const WAITING_TEXT = 'Waiting for speech';

const phone = isPhoneMode();
const webGpu = hasWebGpu();
const keys = new KeyStore();
const store = new SettingsStore();
let settings = normalized(store.load() ?? forFirstRun({ isPhone: phone, hasWebGpu: webGpu }));
const photo = new PhotoSlot();
const photoRegion = Object.freeze({ kind: 'photo' });

// -- the engine -----------------------------------------------------------------------------------------------------

let session = null; let pipeline = null; let webSpeech = null; let regionSource = null;
let micWanted = false;

const ocr = new TesseractReader();
const engine = new Engine({
  options: { autoSuggest: settings.autoSuggest }, textReader: ocr,
  suggester: createSuggester({ getKey: (p) => keys.get(p) }),
  capture: makeCapture({ video: () => regionSource, photo }),
  watcherFactory: (region, onChange, onError) => {
    if (region?.kind !== 'region' || !regionSource) return null; // a photo is never watched
    let lastError = null;
    return new RegionWatcher({
      sample: () => regionSource.frameGray(region), onChange,
      onError: (m) => { lastError = m; onError(m); },
      onRecovered: () => { if (lastError) engine.raiseRecovered(lastError); lastError = null; },
    });
  },
});
engine.settings = settings;
engine.setTextEnabled(settings.typeEnabled);
engine.setPaused(true); // nothing is heard until the user starts listening
engine.start();
photo.onReleased = () => { if (engine.region === photoRegion) engine.setRegion(null); };

// -- the speech model -----------------------------------------------------------------------------------------------

const speech = new SpeechService({
  getSettings: () => settings, webGpu,
  onProgress: ({ text }) => setStatus('preparing', text),
  onReady: () => { if (statusKind === 'preparing') setStatus('listening', WAITING_TEXT); },
  onFailed: (err) => showNotice(`Couldn't load the speech model (${err.message}). It is downloaded once from huggingface.co, so this needs a connection to it.`,
    { source: 'speech', kind: 'error', action: { label: 'Try again', run: () => speech.warmUp({ retry: true }) } }),
});

// -- small state for the page ---------------------------------------------------------------------------------------

let statusKind = 'idle'; let statusText = PAUSED_TEXT; let hearing = false; let raw = ''; let thinking = false;
let noticeSource = null;

function setStatus(kind, text) { statusKind = kind; statusText = text; renderStatus(); }

function renderStatus() {
  const recording = !engine.paused;
  const el = $('status');
  let kind = statusKind; let text = statusText;
  if (!recording) { kind = 'idle'; text = PAUSED_TEXT; }
  else if (hearing && (statusKind === 'listening' || statusKind === 'thinking')) { kind = 'hearing'; text = 'LISTENING'; }
  el.dataset.kind = kind;
  $('status-text').textContent = text;
}

function showNotice(text, { kind = 'warn', source = null, action = null } = {}) {
  noticeSource = source;
  const box = $('notice');
  box.dataset.kind = kind;
  $('notice-text').textContent = text;
  const btn = $('notice-action');
  btn.hidden = !action;
  btn.onclick = action ? () => { hideNotice(); action.run(); } : null;
  if (action) btn.textContent = action.label;
  box.hidden = false;
}
function hideNotice(source) { if (source && noticeSource !== source) return; $('notice').hidden = true; noticeSource = null; }
$('notice-close').addEventListener('click', () => hideNotice());

// -- rendering ------------------------------------------------------------------------------------------------------

function renderChips() {
  const rec = !engine.paused;
  $('chip-rec').setAttribute('aria-pressed', String(rec));
  $('rec-state').textContent = rec ? 'ON' : 'OFF';
  $('chip-type').setAttribute('aria-pressed', String(settings.typeEnabled));
  $('type-state').textContent = settings.typeEnabled ? 'ON' : 'OFF';
}

function renderCost() {
  const snap = engine.usage.snapshot();
  $('cost').textContent = costLabel(snap);
  $('cost').title = costTip(snap, getProvider(settings.provider));
}

function listeningSummary() {
  const bits = [];
  if (session?.hasDisplay) bits.push(session.displayHasAudio ? 'the shared tab or screen (with sound)' : 'the shared tab or screen (no sound shared)');
  if (micWanted && !session?.paused) bits.push(webSpeech ? 'the microphone (browser speech recognition)' : 'the microphone');
  if (bits.length === 0) return phone ? 'Not listening yet.' : 'Not listening yet. Share a tab or screen, or use the microphone.';
  return `${session?.paused ? 'Paused. Was listening to' : 'Listening to'} ${bits.join(' and ')}.`;
}

function renderListening() {
  const active = Boolean(session?.hasDisplay || micWanted);
  $('listen-state').textContent = listeningSummary();
  $('btn-share').hidden = phone;
  $('btn-share').textContent = session?.hasDisplay ? 'Share a different tab or screen' : 'Share a tab or screen';
  $('btn-share').classList.toggle('primary', !session?.hasDisplay);
  $('btn-mic').textContent = phone ? (micWanted ? 'Listening through the microphone' : 'Start listening') : (micWanted ? 'Microphone is on' : 'Use the microphone');
  $('btn-mic').classList.toggle('primary', phone && !micWanted);
  $('btn-mic').disabled = micWanted && !session?.paused;
  $('btn-stop').hidden = !active;
  $('listen-help').textContent = phone
    ? 'Put the call on speaker, or hold the phone near the voice you want it to hear. Keep this page open and the screen on: phones stop the microphone for pages in the background. Nothing is recorded: sound is turned into words on this phone and thrown away.'
    : canShareTabAudio()
      ? 'Chrome and Edge can share a tab with its sound: choose the tab and tick “Share tab audio”. Sharing a whole screen includes the computer’s sound on Windows only. Firefox and Safari don’t share audio at all, so use the microphone or a photo there.'
      : 'This browser can’t share the sound of a tab or screen (only Chrome and Edge do, and a whole screen only on Windows). Use the microphone, or add a photo for the Type side.';
}

function renderArea() {
  const on = settings.typeEnabled;
  $('card-area').hidden = !on;
  if (!on) return;
  const region = engine.region;
  const canPick = !phone && Boolean(session?.hasDisplay);
  $('area-title').textContent = region?.kind === 'photo' ? 'Photo' : 'Text area to watch';
  $('area-sub').textContent = region?.kind === 'photo' ? 'Sent with the next reply, then dropped from memory.'
    : region ? `Watching ${regionLabel(region)}` : 'None chosen';
  $('btn-area').hidden = !canPick;
  $('btn-area').textContent = region?.kind === 'region' ? 'Reselect' : 'Select area';
  $('btn-area-clear').hidden = !region;
  $('btn-photo').textContent = phone || !canPick ? 'Add a photo' : 'Or add a photo';
  $('area-help').textContent = phone
    ? 'Phones can’t share a screen, so take a photo of the message you want a reply to, or choose one from your photos. It’s resized here, its camera and location details are removed, it is sent with the next reply only, and then it is dropped from memory.'
    : 'Share a tab or screen above to draw a box around a chat or document, or add a photo. A photo is resized here, its camera and location details are removed, and it is dropped from memory after use.';
}

function renderButtons() {
  const rec = !engine.paused;
  const canPanic = rec && settings.typeEnabled && engine.region !== null;
  $('btn-panic').disabled = !canPanic;
  $('btn-regen').disabled = !rec;
  $('btn-regen').title = rec ? 'Regenerate: redo the current suggestions with a different take.' : 'Recording is off. Turn it on to use Regenerate.';
  $('btn-panic').title = !rec ? 'Recording is off. Turn it on to use Panic.'
    : !settings.typeEnabled ? 'Turn Type on and add a photo or pick a text area, then Panic can read it.'
      : engine.region === null ? 'Add a photo or pick a text area first, then Panic can read it.'
        : 'Panic: right now, read the text area or photo and reply to it.';
  $('btn-send').title = rec ? 'Get suggestions now' : 'Recording is off. Turn it on to get suggestions.';
  $('auto').checked = settings.autoSuggest;
}

function renderSuggestions(final) {
  const sections = raw.length > 0 ? parseSuggestion(raw) : [];
  const any = renderSections($('sections'), sections, { final, typeEnabled: settings.typeEnabled });
  $('sug-empty').hidden = any || thinking;
}

function renderTurn(speaker, text) {
  const me = speaker === Speaker.Me;
  $('turns').append(h('div', { class: 'turn' }, h('span', { class: `who${me ? ' me' : ''}` }, me ? 'You' : 'Them'), h('span', { class: 'said' }, text)));
  $('empty-conv').hidden = true;
  const turns = $('turns'); turns.scrollTop = turns.scrollHeight;
}

function renderAll() { renderChips(); renderStatus(); renderCost(); renderListening(); renderArea(); renderButtons(); }

// -- engine events --------------------------------------------------------------------------------------------------

engine.on((e) => {
  switch (e.kind) {
    case K.Turn:
      // A merged turn: show it as the conversation holds it.
      $('turns').textContent = '';
      for (const t of engine.conversation.turns) renderTurn(t.speaker, t.text);
      break;
    case K.SuggestStart:
      raw = ''; thinking = true; hideNotice('engine');
      setStatus('thinking', e.text ?? 'Thinking…');
      renderSuggestions(false);
      break;
    case K.Chunk:
      raw += e.text; renderSuggestions(false);
      break;
    case K.SuggestEnd:
      thinking = false; renderSuggestions(true);
      setStatus('listening', WAITING_TEXT);
      break;
    case K.Status:
      setStatus('idle', e.text ?? '');
      break;
    case K.Error: {
      const missingKey = /API key is set/.test(e.text ?? '');
      showNotice(e.text, { kind: 'error', source: 'engine', action: missingKey ? { label: 'Open Settings', run: () => settingsDialog.open() } : null });
      thinking = false; renderSuggestions(true);
      if (statusKind === 'thinking') setStatus('listening', WAITING_TEXT);
      break;
    }
    case K.Recovered:
      hideNotice();
      break;
    case K.RegionChanged: case K.ModeChanged:
      renderAll();
      break;
    case K.Usage:
      renderCost();
      break;
    case K.Hearing:
      hearing = engine.isHearingSpeech;
      renderStatus();
      break;
    case K.Live: {
      const who = engine.liveText(Speaker.Them) ? Speaker.Them : engine.liveText(Speaker.Me) ? Speaker.Me : null;
      const text = who ? engine.liveText(who) : null;
      $('live').hidden = !text;
      if (text) { $('live-who').textContent = who === Speaker.Me ? 'You' : 'Them'; $('live-who').className = `who${who === Speaker.Me ? ' me' : ''}`; $('live-text').textContent = text; }
      break;
    }
    default: break;
  }
});

// -- listening ------------------------------------------------------------------------------------------------------

function ensureKey() {
  if (keys.has(settings.provider) || settings.provider === 'Other') return true;
  welcome.open();
  return false;
}

function ensureSession() {
  if (session) return session;
  pipeline = new AudioPipeline({ engine, transcriber: Promise.resolve(speech.transcriber) });
  pipeline.start();
  session = new ListeningSession({
    pipeline, phone,
    onNotice: (n) => { if (n) showNotice(n, { source: 'session' }); else hideNotice('session'); },
    onChange: () => { regionSource = session.displayVideo ? new VideoRegionSource(session.displayVideo) : null; if (!regionSource && engine.region?.kind === 'region') engine.setRegion(null); renderAll(); },
  });
  return session;
}

function setRecording(on) {
  engine.setPaused(!on);
  if (!on) { session?.pause(); webSpeech?.stop(); setStatus('idle', PAUSED_TEXT); }
  else setStatus(speech.failed ? 'error' : 'listening', session?.hasDisplay || micWanted ? WAITING_TEXT : 'Nothing is connected yet. Share a tab or use the microphone below. Photos still work.');
  renderAll();
}

const userCancelled = (err) => err?.name === 'NotAllowedError' || err?.name === 'AbortError';

async function startShare() {
  if (!ensureKey()) return;
  try {
    const { hasAudio } = await ensureSession().startDisplay();
    setRecording(true);
    if (hasAudio) speech.warmUp();
  } catch (err) { if (!userCancelled(err)) showNotice(err.message, { kind: 'error' }); }
}

async function startMic() {
  if (!ensureKey()) return;
  const useBrowser = settings.useBrowserSpeech && hasBrowserSpeech();
  try {
    const s = ensureSession();
    await s.startMic({ viaBrowserSpeech: useBrowser });
    micWanted = true;
    if (useBrowser) {
      webSpeech = new BrowserSpeech({ engine, who: s.micSpeaker, onError: (m) => showNotice(m, { kind: 'error', source: 'speech' }) });
      webSpeech.start();
    } else speech.warmUp();
    setRecording(true);
  } catch (err) { micWanted = false; showNotice(err.message, { kind: 'error' }); renderAll(); }
}

function stopListening() {
  session?.stopAll(); webSpeech?.stop(); webSpeech = null; micWanted = false;
  setRecording(false);
}

async function toggleRecording() {
  if (!engine.paused) { setRecording(false); return; }
  if (!ensureKey()) return;
  if (session?.hasDisplay || micWanted) {
    try {
      const useBrowser = settings.useBrowserSpeech && hasBrowserSpeech();
      await session.resume({ wantMic: micWanted, viaBrowserSpeech: useBrowser });
      if (webSpeech && micWanted) webSpeech.start();
      setRecording(true);
    } catch (err) { showNotice(err.message, { kind: 'error' }); }
    return;
  }
  if (phone) await startMic(); else setRecording(true); // a computer with nothing shared yet: Recording on, photos work
}

$('chip-rec').addEventListener('click', toggleRecording);
$('btn-share').addEventListener('click', startShare);
$('btn-mic').addEventListener('click', startMic);
$('btn-stop').addEventListener('click', stopListening);

// -- Type: the text area and photos ---------------------------------------------------------------------------------

$('chip-type').addEventListener('click', () => applySettings({ typeEnabled: !settings.typeEnabled }));

$('btn-area').addEventListener('click', async () => {
  if (!regionSource) return;
  let still;
  try { still = regionSource.still(); } catch { showNotice('The shared picture isn’t ready yet. Try again in a moment.'); return; }
  const region = await pickRegion({ dialog: $('dlg-picker'), canvas: $('picker-canvas'), stage: $('picker-stage'), box: $('picker-box'), ok: $('picker-ok'), cancel: $('picker-cancel') }, still);
  if (region) { photo.clear(); engine.setRegion(region); }
});
$('btn-area-clear').addEventListener('click', () => { photo.clear(); engine.setRegion(null); });

$('btn-photo').addEventListener('click', () => $('photo-input').click());
$('photo-input').addEventListener('change', async (e) => {
  const input = e.target;
  const file = input.files?.[0];
  input.value = ''; // so choosing the same picture again still fires
  if (!file) return;
  try {
    setStatus('preparing', 'Preparing the photo…');
    const prepared = await preparePhoto(file);
    photo.set(prepared); // the newest photo replaces the old one
    if (!settings.typeEnabled) applySettings({ typeEnabled: true });
    engine.setPaused(false);
    engine.setRegion(photoRegion);
    setRecording(true);
    engine.request(Trigger.Text | Trigger.Manual, null, 0, true);
  } catch (err) {
    setStatus('listening', engine.paused ? PAUSED_TEXT : WAITING_TEXT);
    showNotice(err.message, { kind: 'error' });
  }
});

// -- the dock -------------------------------------------------------------------------------------------------------

$('direction').addEventListener('submit', (e) => {
  e.preventDefault();
  if (engine.paused) { setStatus('idle', 'Recording is off. Turn it on to get suggestions.'); return; }
  if (!ensureKey()) return;
  const hint = $('hint').value.trim() || null;
  engine.request(Trigger.None, hint, 0, true);
});
$('btn-regen').addEventListener('click', () => { if (!ensureKey()) return; engine.regenerate($('hint').value.trim() || null); });
$('btn-panic').addEventListener('click', () => { if (ensureKey()) engine.panic($('hint').value.trim() || null); });
$('btn-clear').addEventListener('click', () => {
  engine.clearConversation();
  photo.clear();
  if (engine.region?.kind === 'photo') engine.setRegion(null);
  raw = ''; thinking = false;
  $('turns').textContent = ''; $('empty-conv').hidden = false; $('live').hidden = true;
  renderSuggestions(true);
  setStatus(engine.paused ? 'idle' : 'listening', engine.paused ? PAUSED_TEXT : WAITING_TEXT);
});
$('auto').addEventListener('change', () => applySettings({ autoSuggest: $('auto').checked }));

// -- settings -------------------------------------------------------------------------------------------------------

function applySettings(patch) {
  const before = settings;
  settings = normalized({ ...settings, ...patch });
  store.save(settings);
  engine.settings = settings;
  engine.options.autoSuggest = settings.autoSuggest;
  if (before.typeEnabled !== settings.typeEnabled) engine.setTextEnabled(settings.typeEnabled);
  if (before.useBrowserSpeech !== settings.useBrowserSpeech && micWanted) {
    // Switching how the microphone is turned into words takes effect the next time listening starts.
    showNotice('Stop listening and start again for the speech setting to take effect.', { source: 'session' });
  }
  if (before.speechAccuracy !== settings.speechAccuracy && (session?.hasDisplay || micWanted)) speech.warmUp();
  renderAll(); renderSuggestions(!thinking);
}

const welcome = createWelcome({
  dialog: $('dlg-welcome'), fields: $('welcome-fields'), keys, phone,
  getSettings: () => settings, update: (s) => { settings = s; store.save(s); engine.settings = s; renderCost(); },
  onDone: () => { store.save(settings); renderAll(); },
});
const settingsDialog = createSettingsDialog({
  dialog: $('dlg-settings'), fields: $('settings-fields'), keys,
  getSettings: () => settings, update: (s) => applySettings(s),
  env: { webGpu, browserSpeech: hasBrowserSpeech(), phone, ocr: ocr.isAvailable, onForgetKeys: () => { keys.forgetAll(); showNotice('Every saved key was deleted from this browser.', { source: 'keys' }); } },
});
$('btn-settings').addEventListener('click', () => settingsDialog.open());
$('dlg-settings').addEventListener('close', () => renderAll());

// -- installing -----------------------------------------------------------------------------------------------------

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; $('btn-install').hidden = false; });
$('btn-install').addEventListener('click', async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice.catch(() => {}); installPrompt = null; $('btn-install').hidden = true; });
window.addEventListener('appinstalled', () => { $('btn-install').hidden = true; });

// -- start ----------------------------------------------------------------------------------------------------------

renderAll();
renderSuggestions(true);
if (!keys.has(settings.provider) && settings.provider !== 'Other') welcome.open();

// For the smoke tests only: with ?test=1 in the address, a handle to the engine (it holds no keys).
if (new URLSearchParams(location.search).get('test') === '1') globalThis.__cuelight = { engine, get settings() { return settings; }, phone, photo, speech, ocr };
