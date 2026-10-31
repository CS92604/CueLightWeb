// What kind of device and browser this is, for choosing phone mode and a first-run speech model.

/** The page address can force a mode for testing: ?mode=phone or ?mode=desktop. */
export function forcedMode(search = globalThis.location?.search ?? '') {
  const m = new URLSearchParams(search).get('mode');
  return m === 'phone' || m === 'desktop' ? m : null;
}

/**
 * Phone mode: phones can't share a screen or a tab, so there the page listens through the microphone only. Also used for
 * tablets and anything touch-first that can't share a screen.
 */
export function isPhoneMode({ nav = globalThis.navigator, search = globalThis.location?.search, coarse } = {}) {
  const forced = forcedMode(search);
  if (forced) return forced === 'phone';
  if (!nav) return false;
  const ua = nav.userAgent ?? '';
  const mobileUa = /Android|iPhone|iPad|iPod|Mobile|CriOS|FxiOS/i.test(ua) || nav.userAgentData?.mobile === true
    || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1); // iPadOS says it is a Mac
  const canShare = typeof nav.mediaDevices?.getDisplayMedia === 'function';
  const touchFirst = coarse ?? Boolean(globalThis.matchMedia?.('(pointer: coarse) and (hover: none)').matches);
  return mobileUa || (touchFirst && !canShare);
}

/** WebGPU is there (not necessarily usable: the adapter request can still fail). */
export function hasWebGpu(nav = globalThis.navigator) { return Boolean(nav && 'gpu' in nav && nav.gpu); }

export function hasBrowserSpeech(g = globalThis) { return Boolean(g.SpeechRecognition || g.webkitSpeechRecognition); }

/** Whether this browser can share a tab or screen with its sound. Firefox and Safari share the picture but not audio. */
export function browserFamily(ua = globalThis.navigator?.userAgent ?? '') {
  if (/Firefox|FxiOS/i.test(ua)) return 'firefox';
  if (/Edg\//i.test(ua)) return 'edge';
  if (/Chrome|Chromium|CriOS/i.test(ua)) return 'chrome';
  if (/Safari/i.test(ua)) return 'safari';
  return 'other';
}

export function canShareTabAudio(ua = globalThis.navigator?.userAgent ?? '') {
  const f = browserFamily(ua);
  return f === 'chrome' || f === 'edge';
}
