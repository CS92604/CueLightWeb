# CueLight Web

> **Built with Claude Code.** The code, the tests, the build setup and this documentation were made with
> [Claude Code](https://claude.com/claude-code), Anthropic's AI coding tool. This is an independent project with no
> affiliation with Claude or Anthropic.

A web page that listens to a conversation and uses an AI to tell you what to **say**, a fuller **answer** when a
question was asked, and what to **type**, in words that sound like a person. It is the browser version of the
[CueLight desktop app for Windows](https://github.com/CS92604/CueLight), and it is built for the case the desktop app
can't cover: **your phone**. Bring your own API key for **Claude, ChatGPT, Gemini, Grok or NVIDIA** (which has a free
key), or for any other service that speaks the OpenAI chat API.

[![Test and deploy](https://github.com/CS92604/CueLightWeb/actions/workflows/pages.yml/badge.svg)](https://github.com/CS92604/CueLightWeb/actions/workflows/pages.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Get started](#get-started) · [Using it](#using-it) · [Browsers and devices](#browsers-and-devices) ·
[Privacy and your keys](#privacy-and-your-keys) · [What it costs](#what-it-costs) ·
[Speech recognition](#speech-recognition) · [What is not verified](#what-is-not-verified) ·
[Hosting it](#hosting-it) · [Build and test](#build-and-test) · [Keeping in step with the desktop app](#keeping-in-step-with-the-desktop-app)

It is a plain static site: plain JavaScript modules, no framework, no build-time bundler and no server. Every library
is copied into the site from npm; nothing is loaded from a CDN.

## Get started

1. Open the page (<https://cs92604.github.io/CueLightWeb/> once it is [published](#hosting-it)). On a phone you can
   add it to the home screen: it installs like an app.
2. Choose your AI and paste its API key. The welcome screen links to the page where each provider creates one.
3. Tap **Start listening** on a phone, or **Share a tab or screen** on a computer. The first time, the page downloads a
   speech model (roughly 40 to 250 MB depending on the accuracy you choose; once, then your browser keeps it).

## Using it

Two switches sit at the top, as in the desktop app.

- **Recording ON / OFF.** On, the page listens. Off, it releases the microphone, hears nothing, watches nothing and
  sends nothing to the AI. Whatever was already transcribed stays on screen.
- **Type ON / OFF.** Off, the page only listens and gives you things to **say**. On, a **Text area** card appears: on a
  computer you can **Select area** (a box drawn on a still of the shared screen, watched for changes), and on any device
  you can **Add a photo** of the text you want a reply to.

Then:

- The status line says **LISTENING** while someone is speaking and **Waiting for speech** the rest of the time. While
  someone speaks, the **Conversation** box shows the words as they are said, and the finished transcript replaces them.
- When the other person pauses you get options to **SAY**, each with a **Copy** button. When they asked a question, set a
  riddle or left a sentence hanging, a pink **ANSWER** box gives a fuller answer to put in your own words. **TYPE**
  options reply to the text area or photo.
- **Panic** reads the text area or photo right now and replies to it, even with Auto-suggest off. **Regenerate** redoes the
  reply and tells the AI which replies you threw away. Type a direction ("shorter") in the box at the bottom and press
  Enter. **Auto-suggest** off means it only answers when you ask. **Clear chat** forgets the conversation.
- **Settings** has Professionalism, Proficiency, Tone, Length, options per section, reply language, About me, the
  provider and model (or an "Other" service's address), Think first, speech accuracy and the browser-speech switch.
  Every control has a hover or long-press description.

The wording of the prompts, styles, model lists and prices is the desktop app's. See its README for what each setting
does.

### On a phone

Phones can't share a screen or a tab, so on a phone the page hides those buttons and works like this:

- It listens through the **microphone only**, with echo cancellation, noise suppression and auto gain all **off**, so a
  far-end voice from a speakerphone, or from a second device, isn't treated as noise. Put the call on speaker, or hold
  the phone near the voice you want it to hear. Everything it hears is shown as **Them**.
- It asks the browser to **keep the screen on** (a Wake Lock) while listening. When the page goes to the background or
  the microphone is cut, a **paused** notice appears, and listening carries on when you come back.
- **Add a photo** replaces the text area. Your phone offers the camera or your photos. The photo is resized (long edge at
  most 1568 px), turned upright and **re-drawn on a canvas, which removes its camera and location data (EXIF)**, then sent
  as the picture for the TYPE reply. The newest photo replaces the old one, it is sent with the next reply only, and then it
  is **dropped from memory**: nothing old is kept or sent again. A model that can't read pictures (such as NVIDIA's
  Llama 3.3 70B) gets the same "can't read pictures" message as in the desktop app.

### On a computer

Chrome and Edge can share a **tab with its sound**: choose the tab and tick "Share tab audio". Sharing a whole screen
includes the computer's sound on **Windows only**. Firefox and Safari share the picture but **not audio**, so use the
microphone or a photo there. The sound of the shared tab is **Them**; the optional microphone is **You**. The page shows
the same honest note next to the button.

**Reading the text area** (Settings, computers only) is how the box reaches the AI. **Detailed** (the default) sends a
picture of the box each time it changes. **Fast** reads the words in the box in your browser, with Tesseract running as
WebAssembly from files copied into the site, and sends only that text: no picture leaves the device, it costs less, and it
works with models that can't read pictures. It loads about 16 MB from the site the first time it is used. A photo is always
sent as a picture.

## Browsers and devices

| | Chrome / Edge (computer) | Firefox (computer) | Safari (Mac) | Chrome (Android) | Safari (iPhone, iPad) |
|---|---|---|---|---|---|
| Hears a shared tab's sound | Yes (a whole screen: Windows only) | No | No | n/a (phone mode) | n/a (phone mode) |
| Watches a box on a shared screen | Yes | Picture only, no sound | Picture only, no sound | n/a | n/a |
| Microphone | Yes | Yes | Yes | Yes | Yes |
| Photo upload | Yes | Yes | Yes | Camera or library | Camera or library |
| Speech on WebGPU, else WebAssembly | WebGPU if the browser has it | Depends on version | Depends on version | WebGPU if present | Depends on version |
| Keeps the screen awake | Not needed | Not needed | Not needed | Yes | Yes (iOS 16.4 and later) |
| Install as an app | Yes | No | No | Yes | Add to Home Screen |

Honest limits:

- **The microphone stops when a page is in the background or the screen locks**, on most phones. Keep the page open and
  the screen on. The page can't change that; it shows a notice and resumes.
- **Hearing a call on a phone through its microphone depends on the room**: a speakerphone close by works best; a far
  voice or a noisy room gives poor words.
- **On-device speech is slow on weak phones.** Fast (the default on a phone, and wherever WebGPU is missing) uses the
  smallest model. The page keeps up by skipping the oldest speech when it can't, and says so.
- **WebAssembly runs on one thread.** GitHub Pages can't send the headers that allow more (cross-origin isolation), so
  without WebGPU speech recognition is slower than in the desktop app.
- **Some AI providers may refuse calls from a web page** (a browser rule called CORS). When a call fails in a way that
  looks like that, the page says the service may not allow web pages and that the desktop app is the sure option.
- **Plain `http://` addresses** are accepted only for `localhost`, `127.0.0.1` or a private network, and a page served over
  `https://` is blocked by the browser from calling an `http://` address that isn't `localhost`.
- **System audio isn't available to a web page** (other than the Windows whole-screen share above).

## Privacy and your keys

- **Keys stay in this browser.** One per provider, in `localStorage` when **Remember my keys on this device** is on, and
  in `sessionStorage` (this tab only, gone when it closes) when it is off, which is the default. A key is only ever read to
  be sent to **its own provider's address** (for "Other", the address you typed). **Forget my keys** deletes every saved key.
- **Nothing is sent to the author.** No analytics, no telemetry, no error reporting, no cookies. The only network traffic
  is: this site's own files (from GitHub Pages, which sees ordinary web-server logs such as your IP address), the AI
  provider you chose, and, once, `huggingface.co` for the speech model. The page sets `Referrer-Policy: no-referrer` so
  those requests don't carry its address.
- **What the AI provider receives:** the transcript text, your style settings, and (only if you add a photo or pick a text
  area) a picture of it, or its words with Fast screen reading. Audio never leaves your device, except with the opt-in
  below.
- **Browser speech recognition is off by default.** Turning on "Use the browser's built-in speech recognition (sends your
  audio to Google or Apple)" hands the microphone audio to your browser's maker to be turned into words. The warning is shown
  beside the switch. It listens to the microphone only; a shared tab's sound still uses the on-device model.
- **A strict Content Security Policy** is set in the page: scripts only from this site (plus WebAssembly), no inline script or
  style, `connect-src` limited to `https:` and `localhost`, workers from this site. Tests check it, and the smoke test
  checks that it is never violated.

> **Warning: pages under one `github.io` account share one browser storage.** Every site published as
> `cs92604.github.io/<anything>` has the **same origin**, so they share `localStorage` and `sessionStorage`. A script on any
> other page under the same account could read the keys saved here. If you keep other projects under that account, serve this
> page from **its own custom domain** (Settings > Pages > Custom domain), or leave "Remember my keys on this device" off.
> With the default (off) a key lives only in the tab's `sessionStorage`, which is not shared between tabs.

Use a key with a **spending limit** set at your provider's console, and revoke any key you think was exposed.

## What it costs

AI providers bill API use **separately from a chat subscription**, and the cost of a suggestion is the same as in the
desktop app, because the requests are the same. See the desktop app's
[**What it costs**](https://github.com/CS92604/CueLight#what-it-costs) section and its table of prices per model. The
corner of the page shows a running estimate from the providers' list prices (NVIDIA's free API shows **Free**; a model with
no listed price is counted in tokens). Speech recognition costs nothing: it runs on your device.

## Speech recognition

On-device, by default: [Whisper](https://github.com/openai/whisper) running in a Web Worker with
[Transformers.js](https://github.com/huggingface/transformers.js). Audio comes from an AudioWorklet (served from the
site), is brought down to 16 kHz mono and cut into sentences by the same voice-activity detector as the desktop app; each
finished sentence is transcribed, and a live preview of the words as they are spoken runs on snapshots of the speech so
far (the newest wins and a finished sentence always goes first).

| Speech accuracy | Model | Notes |
|---|---|---|
| Fast | `onnx-community/whisper-tiny.en` | The default on a phone, and wherever WebGPU is missing. Roughly a 40 MB download. |
| Balanced | `onnx-community/whisper-base.en` | The default on a computer with WebGPU. Roughly 80 MB. |
| Accurate | `onnx-community/whisper-small.en` | The most accurate and the slowest. Roughly 250 MB. |

The models are English-only (`.en`). They download from `huggingface.co` on first use and are cached by the library in your
browser. WebGPU is used when the browser has it, otherwise WebAssembly. The ONNX Runtime files it needs are copied into
the site (`vendor/ort/`), not loaded from a CDN. Whisper sometimes writes "(music)" or invents a line such as "Thanks for
watching!" out of silence: the page filters those out, as the desktop app does.

## What is not verified

Things that were tested, and things that were **not**:

- **Tested** (unit tests and a smoke test in headless Chromium on Linux, with a fake microphone, a fake screen share and a
  local fake AI service): the prompt text, parsing and settings; both suggesters' streaming, retry and error handling
  against scripted responses; the engine's timing and supersede logic; the audio pipeline; the key store; photo EXIF
  removal, resizing and orientation; the region picker and watcher; the phone-mode flow with the microphone filters off,
  the Wake Lock request and the paused notice; the Content Security Policy never being violated; and that no request goes
  anywhere except this site and the AI service.
- **Not tested: real AI providers.** No request was sent to Anthropic, OpenAI, Google, xAI or NVIDIA. Whether each allows
  calls from a web page (CORS), and what exactly each accepts, is untested. NVIDIA may well refuse them.
- **Not tested: the Anthropic extras.** The desktop app uses Anthropic's SDK; here the same request is written by hand.
  The browser-access header `anthropic-dangerous-direct-browser-access: true` and the `x-api-key` and
  `anthropic-version: 2023-06-01` headers are the documented way. The **extras** the desktop app sends (the thinking
  override, `output_config` effort, the server-side fallback beta) are **unverified over raw HTTP**, including how they are
  spelled in the JSON body. On a `400` the page retries without them, one at a time, and remembers what a model refuses.
- **Not tested: the real Whisper models.** The build environment could not reach `huggingface.co`. The model ids above are
  the expected `onnx-community` ids but were **not checked to exist**; the download sizes are approximate; the order of
  ONNX precisions tried (`q4`/`fp32` on WebGPU, `q8`/`fp32` on WebAssembly, with fallbacks) is untested; and **speech speed
  on a real phone is unmeasured**. Only a stand-in transcriber was used in the smoke test.
- **Not tested: WebGPU speech and real phones.** The ONNX Runtime was checked in Chromium (WebGPU on a software adapter, and
  WebAssembly) with a tiny model, which is how it was found that the `jsep` build does not run WebGPU with this version of
  Transformers.js while the `asyncify` build does. No iPhone, Android phone, Firefox, Safari or Windows full-screen share
  was tried.
- **Not tested: the browser's built-in speech recognition** (headless Chromium has no speech service), **installing as an
  app**, and **Fast screen reading** on anything but one rendered sample message (it did read that correctly, with every
  file served from the site).
- **A flaky smoke test, once**: while building this, one step of the smoke test failed now and then. The cause was a wrong
  assertion (it didn't allow for the engine merging a photo with a sentence heard at the same moment), which is fixed;
  it has since passed repeatedly, but it was timing-dependent.

## Hosting it

This is built for **GitHub Pages**, deployed by `.github/workflows/pages.yml` (`npm ci`, tests, `npm run build`, upload the
`_site` folder, deploy).

**The one manual step:** in the repository, go to **Settings > Pages > Build and deployment > Source** and choose
**GitHub Actions**. Then re-run the workflow (or push again). The page appears at `https://cs92604.github.io/CueLightWeb/`.

The workflow deploys the **`main`** branch, which should be the repository's default branch (Settings > Branches). GitHub only
lets the default branch deploy to the `github-pages` environment unless told otherwise; if the deploy job is refused with an
"environment protection rules" message, check the rule under **Settings > Environments > github-pages > Deployment branches and tags**.

For a custom domain (recommended; see [the warning above](#privacy-and-your-keys)) add it under Settings > Pages and put a
`CNAME` file in `src/`.

## Build and test

You need Node 22 or later.

```bash
npm ci            # install the pinned dependencies
npm test          # unit tests (node:test), including the repository checks
npm run build     # build the site into _site/ (copies src/ and vendors the libraries)
npm run serve     # serve _site/ at http://127.0.0.1:8080/
```

The smoke test drives the built site in Chromium and needs Playwright (it is not a dependency of the site):

```bash
npm install --no-save --no-package-lock playwright@1.63.0
npx playwright install chromium
npm run build && npm run smoke
```

Add `?mode=phone` to the address to see phone mode on a computer.

### How it is put together

| Folder | What is in it |
|---|---|
| `src/js/core/` | Ports of the desktop app's core: `prompting`, `providers`, `settings`, `usage`, `conversation`, `segmenter`, `changeDetector`, `serviceAddress` |
| `src/js/suggest/` | The two suggesters (Claude and OpenAI-style), streaming over `fetch`, the retry rules, plain-language errors, key checks |
| `src/js/engine.js` | The engine: debounce, merge hold, supersede and coalesce, Panic, Regenerate, the quiet-pause follow-up |
| `src/js/audio/`, `src/js/stt/` | The AudioWorklet, listening sources, Wake Lock, the audio pipeline, the Whisper worker, browser speech |
| `src/js/screen/` | The region picker and watcher, photo preparation, the photo slot |
| `src/js/ui/`, `src/js/main.js` | The page |
| `scripts/` | The build, a static server, the icon maker and the prompt-sync check |
| `tests/`, `smoke/` | Unit tests and the browser smoke test |

## Keeping in step with the desktop app

The prompts are **duplicated**, not shared. `src/js/core/systemPrompt.js` is the desktop app's `SystemPrompt` word for word,
and the task lines, style wording, model lists and prices in `src/js/core/` copy `Prompting.cs`, `Settings.cs`, `Providers.cs`
and `Usage.cs` in [cs92604/CueLight](https://github.com/CS92604/CueLight) (`src/Cuelight.Core/`). **When one changes, change
the other.** A test pins the system prompt by hash, and

```bash
node scripts/check-prompt-sync.mjs ../CueLight
```

compares the web copy with a checkout of the desktop app. The `Prompt sync` workflow runs it on every push and every Monday.
(A matching note for the desktop repository is suggested in the pull request or hand-over; this repository does not change
that one.)

## License

[MIT](LICENSE). The libraries and fonts bundled with the site, and the models it downloads, have their own licenses, listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Disclaimer

An independent project, not affiliated with or endorsed by Anthropic, OpenAI, Google, xAI, NVIDIA, Hugging Face or anyone
else named here. Speech recognition and AI replies make mistakes: check anything that matters. Use it where recording or
transcribing a conversation is allowed and the people in it know, and don't use it to pretend to expertise or experience you
don't have.
