# Security

## Reporting a problem

If you find a security problem in CueLight Web (for example, a way for an API key, or what was said or shown, to leak,
or a way to make the page run a script it shouldn't), please report it **privately**: use **Security > Report a
vulnerability** on this repository's GitHub page. Please don't open a public issue with the details until it's fixed.

This is a small hobby project maintained in spare time, so there is no guaranteed response time and no bounty, but
reports are taken seriously. **Never paste an API key anywhere in a report**, and revoke any key that was exposed.

## What the page does with your data

- API keys stay in this browser: `localStorage` with "Remember my keys on this device" on, `sessionStorage` (this tab
  only) with it off. A key is only ever sent to the AI provider it belongs to (for "Other", the address you typed).
  **Forget my keys** deletes them all.
- Speech is turned into words in this browser (Whisper, in a Web Worker). The AI provider receives the transcript text
  and, only if you add a photo or pick a text area, a picture of it (or its words, with Fast screen reading). Photos are
  re-drawn on a canvas before sending, which removes their camera and location data, and are dropped from memory after use.
- The page connects to the AI provider you choose and, once, to huggingface.co to download the speech model. With
  "Use the browser's built-in speech recognition" turned on (off by default), your browser sends microphone audio to its
  maker's servers. There is no analytics and nothing is sent to the author.
- Plain `http://` addresses are refused unless they point at this device or your own network.
- A strict Content Security Policy (no inline script or style, scripts only from this site) is set in the page.

## Known limits

- All pages under one `github.io` account share a single browser storage origin, so another page published by the same
  account could read what this one stores. A custom domain avoids that (see the README).
- GitHub Pages can't set HTTP headers, so there is no `frame-ancestors`, no `Permissions-Policy` and no cross-origin
  isolation (which would allow multi-threaded WebAssembly) for this page.
- The speech model is downloaded from huggingface.co and checked by the library's own cache logic, not against a
  published checksum.
