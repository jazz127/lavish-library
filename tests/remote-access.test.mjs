import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedHost, apiBase, hostAuthority, remoteAccessConfig } from '../scripts/remote-access.mjs';

test('remote access defaults to the existing loopback origins and hosts', () => {
  const config = remoteAccessConfig({});
  assert.equal(config.bindHost, '127.0.0.1');
  assert.deepEqual([...config.origins].sort(), ['http://127.0.0.1:3000', 'http://localhost:3000']);
  assert.equal(allowedHost('127.0.0.1:4318', config), true);
  assert.equal(allowedHost('127.0.0.1:9999', config), false);
  assert.equal(allowedHost('library.example.ts.net:4318', config), false);
});

test('an explicit origin allowlist permits configured private-network origins only', () => {
  const config = remoteAccessConfig({
    LAVISH_TRACKER_BIND_HOST: '0.0.0.0',
    LAVISH_TRACKER_ALLOWED_ORIGINS: 'https://library.example.ts.net',
  });
  assert.equal(config.origins.has('https://library.example.ts.net'), true);
  assert.equal(config.origins.has('https://other.example.ts.net'), false);
  assert.equal(allowedHost('library.example.ts.net', config), true);
  assert.equal(allowedHost('other.example.ts.net', config), false);
});

test('refuses an exposed bind without an explicit origin allowlist or with a wildcard', () => {
  assert.throws(() => remoteAccessConfig({ LAVISH_TRACKER_BIND_HOST: '0.0.0.0' }), /without LAVISH_TRACKER_ALLOWED_ORIGINS/);
  assert.throws(() => remoteAccessConfig({ LAVISH_TRACKER_BIND_HOST: '0.0.0.0', LAVISH_TRACKER_ALLOWED_ORIGINS: '*' }), /Invalid allowed origin|exact http/);
  for (const origins of ['https://*.example.com', 'https://library.*.example.com', ',', ' , , ']) {
    assert.throws(() => remoteAccessConfig({ LAVISH_TRACKER_BIND_HOST: '0.0.0.0', LAVISH_TRACKER_ALLOWED_ORIGINS: origins }), /exact http/);
    assert.throws(() => remoteAccessConfig({ LAVISH_TRACKER_ALLOWED_ORIGINS: origins }), /exact http/);
  }
});

test('normalizes IPv6 socket addresses and brackets their authorities', () => {
  for (const bindHost of ['::1', '[::1]']) {
    const config = remoteAccessConfig({ LAVISH_TRACKER_BIND_HOST: bindHost });
    assert.equal(config.bindHost, '::1');
    assert.equal(config.isLoopback, true);
    assert.equal(config.origins.has('http://[::1]:3000'), true);
    assert.equal(hostAuthority(config.bindHost), '[::1]');
    assert.equal(allowedHost('[::1]:4318', config), true);
    assert.equal(allowedHost('[::1]:9999', config), false);
  }
  const config = remoteAccessConfig({ LAVISH_TRACKER_BIND_HOST: '[::]', LAVISH_TRACKER_ALLOWED_ORIGINS: 'http://[::1]:3000' });
  assert.equal(config.bindHost, '::');
  assert.equal(config.isLoopback, false);
  assert.equal(allowedHost('[::1]:4318', config), true);
});

test('uses one resolved UI port and accepts only absolute browser-facing API bases', () => {
  assert.equal(remoteAccessConfig({ LAVISH_TRACKER_UI_PORT: '3007' }).uiPort, 3007);
  for (const port of ['0', '-1', '65536', 'invalid']) {
    assert.equal(remoteAccessConfig({ LAVISH_TRACKER_UI_PORT: port }).uiPort, 3000);
  }
  assert.equal(apiBase({}), 'http://127.0.0.1:4318');
  assert.equal(apiBase({ LAVISH_TRACKER_API_BASE: 'https://library.example.com:8443/' }), 'https://library.example.com:8443');
  assert.equal(apiBase({ LAVISH_TRACKER_API_BASE: 'http://[::1]:4318' }), 'http://[::1]:4318');
  for (const base of ['/companion-api', '//library.example.com:8443', 'file:///companion', 'https://owner:secret@library.example.com', 'https://library.example.com?mode=api', 'https://library.example.com#api']) {
    assert.throws(() => apiBase({ LAVISH_TRACKER_API_BASE: base }), /absolute http/);
  }
});
