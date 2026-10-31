import { test } from 'node:test';
import assert from 'node:assert/strict';
import { problem, isOnThisDeviceOrNetwork, browserBlocks, DOESNT_LOOK_RIGHT, PLAIN_HTTP, BROWSER_BLOCKS_HTTP } from '../src/js/core/serviceAddress.js';

test('https is always fine', () => {
  for (const a of ['https://api.openai.com/v1', 'https://openrouter.ai/api/v1', 'https://8.8.8.8/v1', 'https://localhost:8443'])
    assert.equal(problem(a), null, a);
});

test('http is only for this device or a private network', () => {
  for (const a of ['http://localhost:11434/v1', 'http://127.0.0.1:8080', 'http://192.168.1.20:1234/v1', 'http://10.0.0.5', 'http://172.16.0.1', 'http://172.31.255.255',
    'http://169.254.1.1', 'http://[::1]:8000', 'http://[fe80::1]', 'http://[fd12:3456::1]', 'http://[::ffff:192.168.1.1]', 'http://gaming-pc:11434',
    'http://nas.local', 'http://box.lan', 'http://svc.internal', 'http://x.home.arpa', 'http://foo.localhost'])
    assert.equal(problem(a), null, a);
  for (const a of ['http://example.com', 'http://8.8.8.8', 'http://172.32.0.1', 'http://172.15.0.1', 'http://192.169.0.1', 'http://[2001:db8::1]', 'http://[::ffff:8.8.8.8]', 'http://api.openai.com/v1'])
    assert.equal(problem(a), PLAIN_HTTP, a);
});

test('anything that is not an http or https address is rejected with the plain-language reason', () => {
  for (const a of ['', 'notaurl', 'ftp://example.com', 'javascript:alert(1)', 'file:///etc/passwd', '//example.com', null, undefined])
    assert.equal(problem(a), DOESNT_LOOK_RIGHT, String(a));
});

test('isOnThisDeviceOrNetwork handles brackets, a trailing dot and case', () => {
  assert.equal(isOnThisDeviceOrNetwork('LOCALHOST.'), true);
  assert.equal(isOnThisDeviceOrNetwork('[::1]'), true);
  assert.equal(isOnThisDeviceOrNetwork(''), false);
  assert.equal(isOnThisDeviceOrNetwork('example.org'), false);
});

test('an https page cannot call plain http except localhost: the browser blocks it, so say so up front', () => {
  assert.equal(browserBlocks('http://localhost:11434/v1', 'https:'), null);
  assert.equal(browserBlocks('http://127.0.0.1:11434/v1', 'https:'), null);
  assert.equal(browserBlocks('http://[::1]:11434/v1', 'https:'), null);
  assert.equal(browserBlocks('http://192.168.1.20:1234/v1', 'https:'), BROWSER_BLOCKS_HTTP);
  assert.equal(browserBlocks('http://my-pc:1234/v1', 'https:'), BROWSER_BLOCKS_HTTP);
  assert.equal(browserBlocks('http://192.168.1.20:1234/v1', 'http:'), null); // a page served over http may call it
  assert.equal(browserBlocks('https://api.openai.com/v1', 'https:'), null);
});
