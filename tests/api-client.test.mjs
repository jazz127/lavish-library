import assert from 'node:assert/strict';
import { test } from 'node:test';

test('bootstraps a browser token and renews it once after a service restart', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const responses = [
    new Response(JSON.stringify({ token: 'first-token' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ error: 'stale token' }), { status: 401, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ token: 'second-token' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
  ];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), token: new Headers(init.headers).get('x-lavish-token') });
    return responses.shift();
  };

  try {
    const { apiFetch } = await import(`../app/api-client.ts?test=${Date.now()}`);
    const response = await apiFetch('/library');
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [
      { url: 'http://127.0.0.1:4318/api/session', token: null },
      { url: 'http://127.0.0.1:4318/api/library', token: 'first-token' },
      { url: 'http://127.0.0.1:4318/api/session', token: null },
      { url: 'http://127.0.0.1:4318/api/library', token: 'second-token' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
