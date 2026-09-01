import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const port = 44_000 + (process.pid % 1_000);
const api = `http://127.0.0.1:${port}/api`;
let service;
let fixture;
let lavishFile;
let outsideFile;

async function waitForApi() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch { /* Service is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Test API did not start.');
}

async function post(route, value) {
  const response = await fetch(`${api}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const result = await response.json();
  assert.equal(response.ok, true, result.error);
  return result;
}

before(async () => {
  fixture = await mkdtemp(path.join(os.tmpdir(), 'lavish-tracker-test-'));
  const project = path.join(fixture, 'Signal Project');
  const lavishDir = path.join(project, '.lavish');
  const stateDir = path.join(fixture, 'lavish-state');
  const configDir = path.join(fixture, 'tracker-state');
  await Promise.all([mkdir(lavishDir, { recursive: true }), mkdir(stateDir, { recursive: true }), mkdir(configDir, { recursive: true })]);
  lavishFile = path.join(lavishDir, 'identity-plan.html');
  outsideFile = path.join(fixture, 'untracked.html');
  await writeFile(lavishFile, '<!doctype html><html><head><title>Identity migration plan</title><meta name="description" content="Entra access architecture and delivery decisions"></head><body><h1>Identity migration</h1></body></html>');
  await writeFile(outsideFile, '<!doctype html><title>Not a Lavish</title>');
  await writeFile(path.join(stateDir, 'state.json'), JSON.stringify({ sessions: { demo: { file: lavishFile, status: 'open', updated_at: '2026-08-30T00:00:00.000Z', chat: [{ at: '2026-08-30T00:00:00.000Z' }] } } }));
  await writeFile(path.join(configDir, 'config.json'), JSON.stringify({ projects: [{ path: project, name: 'Signal Project' }], archiveRoot: null }));
  service = spawn(process.execPath, [path.join(root, 'scripts/local-api.mjs')], {
    cwd: root,
    env: { ...process.env, LAVISH_TRACKER_API_PORT: String(port), LAVISH_TRACKER_CONFIG_DIR: configDir, LAVISH_AXI_STATE_DIR: stateDir, LAVISH_AXI_BIN: '/usr/bin/true' },
    stdio: 'ignore',
  });
  await waitForApi();
});

after(() => service?.kill('SIGTERM'));

test('builds a local library with known session activity', async () => {
  const response = await fetch(`${api}/library`);
  const library = await response.json();
  assert.equal(library.artifacts.length, 1);
  assert.equal(library.artifacts[0].title, 'Identity migration plan');
  assert.equal(library.artifacts[0].sessionMessages, 1);
});

test('records search, value, and outcome signals in insights', async () => {
  const library = await (await fetch(`${api}/library`)).json();
  const artifact = library.artifacts[0];
  await post('/events', { type: 'search', query: 'identity', resultCount: 1, projectId: artifact.projectId });
  await post('/artifacts/feedback', { file: lavishFile, value: 'useful', outcome: 'shipped', note: 'Turned into delivery work.' });
  const insights = await (await fetch(`${api}/insights?days=3650`)).json();
  assert.equal(insights.summary.totalArtifacts, 1);
  assert.equal(insights.summary.trackedSearches, 1);
  assert.equal(insights.summary.outcomes, 1);
  assert.equal(insights.searches[0].query, 'identity');
  assert.equal(insights.feedbackQueue.length, 0);
});

test('never enables foreground-time tracking', async () => {
  const result = await post('/insights/settings', { cadence: 'tunable', manual: true, weekly: true, monthly: true, contextual: true, foregroundTime: true });
  assert.equal(result.settings.foregroundTime, false);
});

test('rejects hostile browser origins and requires a session token', async () => {
  const searchesBefore = (await (await fetch(`${api}/insights?days=3650`)).json()).summary.trackedSearches;
  const hostilePost = await fetch(`${api}/events`, {
    method: 'POST',
    headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'search', query: 'should-not-record', resultCount: 0 }),
  });
  assert.equal(hostilePost.status, 403);
  const searchesAfter = (await (await fetch(`${api}/insights?days=3650`)).json()).summary.trackedSearches;
  assert.equal(searchesAfter, searchesBefore);

  const hostile = await fetch(`${api}/archive/disable`, {
    method: 'OPTIONS',
    headers: { origin: 'https://attacker.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  assert.equal(hostile.status, 403);
  assert.equal(hostile.headers.get('access-control-allow-origin'), null);

  const nullOrigin = await fetch(`${api}/archive/disable`, { method: 'POST', headers: { origin: 'null' } });
  assert.equal(nullOrigin.status, 403);
  const originlessBrowser = await fetch(`${api}/library`, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(originlessBrowser.status, 403);

  const origin = 'http://localhost:3000';
  const preflight = await fetch(`${api}/library`, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-lavish-token' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.match(preflight.headers.get('access-control-allow-headers'), /x-lavish-token/);
  const sessionResponse = await fetch(`${api}/session`, { headers: { origin } });
  const session = await sessionResponse.json();
  assert.equal(sessionResponse.status, 200);
  assert.equal(sessionResponse.headers.get('access-control-allow-origin'), origin);
  assert.equal(typeof session.token, 'string');

  const unauthorized = await fetch(`${api}/library`, { headers: { origin } });
  assert.equal(unauthorized.status, 401);
  const authorized = await fetch(`${api}/library`, { headers: { origin, 'x-lavish-token': session.token } });
  assert.equal(authorized.status, 200);

  const ipOrigin = 'http://127.0.0.1:3000';
  const ipSession = await fetch(`${api}/session`, { headers: { origin: ipOrigin } });
  assert.equal(ipSession.status, 200);
  assert.equal(ipSession.headers.get('access-control-allow-origin'), ipOrigin);
});

test('rejects HTML files outside the known Lavish library', async () => {
  const response = await fetch(`${api}/artifacts/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file: outsideFile }),
  });
  const result = await response.json();
  assert.equal(response.status, 400);
  assert.match(result.error, /not a known Lavish artifact/i);

  const versionsResponse = await fetch(`${api}/artifacts/versions?file=${encodeURIComponent(outsideFile)}`);
  const versionsResult = await versionsResponse.json();
  assert.equal(versionsResponse.status, 400);
  assert.match(versionsResult.error, /not a known Lavish artifact/i);
});
