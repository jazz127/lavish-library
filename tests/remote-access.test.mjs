import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedHost, remoteAccessConfig } from '../scripts/remote-access.mjs';

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
});
