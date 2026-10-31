// Port of ServiceAddress.cs: checks the address of an OpenAI-style service before the conversation (and an API key) is
// sent to it. https:// is always fine. Plain http:// is only accepted for a service on this device or on your own
// network (Ollama and the like), because anywhere else it would send the transcript and the key across the internet
// unencrypted.

export const DOESNT_LOOK_RIGHT =
  "That address doesn't look right. It should start with https:// (or http:// for a service on this device or your own network).";

export const PLAIN_HTTP =
  'That address starts with http://, which would send your key and the conversation unencrypted. Use https:// instead (http:// is only accepted for a service on this device or your own network).';

export const BROWSER_BLOCKS_HTTP =
  'Your browser blocks pages served over https:// from talking to a plain http:// address (other than localhost). Use an https:// address, or open this page from http://localhost.';

/** Null when the address is fine to use; otherwise a plain-language reason it isn't. */
export function problem(address) {
  const uri = parse(address);
  if (!uri) return DOESNT_LOOK_RIGHT;
  if (uri.protocol === 'http:' && !isOnThisDeviceOrNetwork(uri.hostname)) return PLAIN_HTTP;
  return null;
}

function parse(address) {
  try {
    const uri = new URL(String(address ?? '').trim());
    return uri.protocol === 'http:' || uri.protocol === 'https:' ? uri : null;
  } catch {
    return null;
  }
}

/** This device, or a machine on a home or office network: not reachable from the open internet. */
export function isOnThisDeviceOrNetwork(host) {
  host = String(host ?? '').trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host.length === 0) return false;
  const v4 = parseIPv4(host);
  if (v4) return isPrivateV4(v4);
  if (host.includes(':')) {
    const v6 = parseIPv6(host);
    return v6 ? isPrivateV6(v6) : false;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (!host.includes('.')) return true; // a bare machine name such as "gaming-pc" only resolves on a local network
  return host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal') || host.endsWith('.home.arpa');
}

/** True when the browser treats the address as a secure context, so an https page may call it over plain http. */
export function isBrowserLocalhost(host) {
  host = String(host ?? '').trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  const v4 = parseIPv4(host);
  return Boolean(v4 && v4[0] === 127);
}

/** Null when the browser will allow the call; otherwise why it won't. pageProtocol is location.protocol. */
export function browserBlocks(address, pageProtocol) {
  const uri = parse(address);
  if (!uri || pageProtocol !== 'https:' || uri.protocol !== 'http:') return null;
  return isBrowserLocalhost(uri.hostname) ? null : BROWSER_BLOCKS_HTTP;
}

function parseIPv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((n) => n <= 255) ? b : null;
}

function isPrivateV4(b) {
  return b[0] === 127 || b[0] === 10 || (b[0] === 172 && b[1] >= 16 && b[1] <= 31)
    || (b[0] === 192 && b[1] === 168) || (b[0] === 169 && b[1] === 254);
}

/** Expands an IPv6 literal to eight 16-bit groups, or null if it isn't one. */
function parseIPv6(s) {
  if (s.includes('%')) s = s.slice(0, s.indexOf('%')); // a zone id
  let tail = [];
  const v4 = parseIPv4(s.slice(s.lastIndexOf(':') + 1));
  if (v4) { // an embedded IPv4 address stands for the last two groups
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = s.slice(0, s.lastIndexOf(':') + 1);
    if (!s.endsWith('::')) s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (part) => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const fill = 8 - head.length - rest.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const hex = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...rest];
  const nums = hex.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  const all = [...nums, ...tail];
  return all.length === 8 && all.every((n) => Number.isInteger(n)) ? all : null;
}

function isPrivateV6(g) {
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) // IPv4-mapped
    return isPrivateV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]);
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local fec0::/10
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7, the IPv6 private range
  return false;
}
