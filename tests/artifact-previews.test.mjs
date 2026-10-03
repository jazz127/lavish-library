import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { browserExecutable, capturePreview, createPreviewCache } from '../scripts/artifact-previews.mjs';

async function eventually(read, predicate, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Preview did not reach the expected state');
}

// The hosted Linux runner is slower at serial Chrome launches than developer machines.
const previewTimeout = process.env.CI === 'true' ? 60_000 : 30_000;

async function fixture(run, { browser } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lavish-previews-'));
  const sourceDir = path.join(directory, 'project', '.lavish');
  const configDir = path.join(directory, 'config');
  const stateDir = path.join(directory, 'state');
  await Promise.all([sourceDir, configDir, stateDir].map((dir) => mkdir(dir, { recursive: true })));
  const red = path.join(sourceDir, 'red.html');
  const blue = path.join(sourceDir, 'blue.html');
  await writeFile(red, '<title>Red</title><link rel="stylesheet" href="red.css"><h1>Red artifact</h1>');
  await writeFile(path.join(sourceDir, 'red.css'), 'body { background: #ff0000; }');
  await writeFile(blue, '<title>Blue</title><style>body { background: #0000ff; }</style><h1>Blue artifact</h1>');
  await writeFile(path.join(stateDir, 'state.json'), JSON.stringify({ sessions: { red: { file: red }, blue: { file: blue } } }));
  await writeFile(path.join(configDir, 'config.json'), JSON.stringify({ projects: [], archiveRoot: path.join(directory, 'archive') }));
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const service = spawn(process.execPath, [process.env.LAVISH_PREVIEW_TEST_API || 'scripts/local-api.mjs'], {
    env: { ...process.env, LAVISH_TRACKER_CONFIG_DIR: configDir, LAVISH_AXI_STATE_DIR: stateDir, LAVISH_TRACKER_API_PORT: String(port), LAVISH_AXI_BIN: '/usr/bin/true', ...(browser ? { LAVISH_TRACKER_BROWSER: browser } : {}) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  service.stderr.on('data', (bytes) => { stderr += bytes; });
  const exited = new Promise((resolve) => service.once('exit', resolve));
  const api = `http://127.0.0.1:${port}/api`;
  const library = async () => (await fetch(`${api}/library`)).json();
  const preview = async (id, headers) => {
    const response = await fetch(`${api}/artifacts/preview?id=${id}`, { headers });
    return { response, png: response.headers.get('content-type')?.startsWith('image/png') ? Buffer.from(await response.arrayBuffer()) : null };
  };
  try {
    await eventually(async () => fetch(`http://127.0.0.1:${port}/health`).catch(() => null), (response) => response?.ok);
    await run({ api, library, preview, red, blue, sourceDir, configDir, service, exited });
  } catch (error) { error.message += `\nService stderr: ${stderr}`; throw error; }
  finally {
    service.kill('SIGTERM');
    const cleanup = setTimeout(() => service.kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(cleanup);
    await rm(directory, { recursive: true, force: true });
  }
}

test('companion exits on SIGTERM while a background capture is pending', async () => {
  await fixture(async ({ library, preview, service, exited }) => {
    const artifact = (await library()).artifacts[0];
    assert.equal((await preview(artifact.id)).response.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 250));
    service.kill('SIGTERM');
    let timeout;
    try {
      await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Companion ignored SIGTERM during capture')), 1500); })]);
    } finally { clearTimeout(timeout); }
  });
});

test('artifact preview API renders distinct local artifacts, caches, and refreshes CSS changes', async (t) => {
  // This is synthetic local browser validation, not installed-app evidence.
  try { await browserExecutable(); } catch { t.skip('Chrome/Chromium is not installed'); return; }
  await fixture(async ({ library, preview, sourceDir }) => {
    const artifacts = (await library()).artifacts;
    const [red, blue] = ['Red', 'Blue'].map((title) => artifacts.find((artifact) => artifact.title === title));
    const initial = await Promise.all([red, blue].map((artifact) => preview(artifact.id)));
    t.diagnostic(`Synthetic preview endpoint sample: 2 artifacts scanned; HTTP statuses ${initial.map((value) => value.response.status).join(', ')}.`);
    assert.equal(initial[0].response.status, 202);
    const redImage = await eventually(() => preview(red.id), (value) => value.png, previewTimeout);
    const blueImage = await eventually(() => preview(blue.id), (value) => value.png, previewTimeout);
    assert.deepEqual(redImage.png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.notDeepEqual(redImage.png, blueImage.png);
    assert.deepEqual((await preview(red.id)).png, redImage.png);
    await writeFile(path.join(sourceDir, 'red.css'), 'body { background: #00ff00; }');
    await library();
    const refreshed = await eventually(() => preview(red.id), (value) => value.png && !value.png.equals(redImage.png), previewTimeout);
    assert.notDeepEqual(refreshed.png, redImage.png);
  });
});

test('failed capture and missing source use fallback while opening and history retain their boundaries', async () => {
  await fixture(async ({ api, library, red }) => {
    const artifact = (await library()).artifacts.find((item) => item.file === red);
    await eventually(async () => (await fetch(`${api}/artifacts/preview?id=${artifact.id}`)).json(), (value) => value.status === 'failed');
    const open = () => fetch(`${api}/artifacts/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: red }) });
    assert.equal((await open()).status, 202);
    let history = await (await fetch(`${api}/artifacts/versions?file=${encodeURIComponent(red)}`)).json();
    assert.equal(history.versions.length, 1);
    await rm(red);
    const missing = (await library()).artifacts.find((item) => item.id === artifact.id);
    assert.equal(missing.exists, false);
    assert.equal((await (await fetch(`${api}/artifacts/preview?id=${artifact.id}`)).json()).status, 'missing');
    assert.equal((await open()).status, 400);
    history = await (await fetch(`${api}/artifacts/versions?file=${encodeURIComponent(red)}`)).json();
    assert.equal(history.versions.length, 1);
    assert.equal(history.sourceExists, false);
  }, { browser: '/nonexistent/preview-browser' });
});

test('preview endpoint rejects unknown IDs, hostile origins and missing tokens', async () => {
  await fixture(async ({ api, library, preview, sourceDir }) => {
    const artifact = (await library()).artifacts[0];
    assert.equal((await preview('../config/config.json')).response.status, 404);
    assert.equal((await preview('unknown')).response.status, 404);
    assert.equal((await preview(artifact.id, { origin: 'https://attacker.example' })).response.status, 403);
    assert.equal((await preview(artifact.id, { origin: 'http://localhost:3000' })).response.status, 401);
    const token = (await (await fetch(`${api}/session`, { headers: { origin: 'http://localhost:3000' } })).json()).token;
    assert.notEqual((await preview(artifact.id, { origin: 'http://localhost:3000', 'x-lavish-token': token })).response.status, 401);
    await rm(artifact.file);
    await symlink(path.join(sourceDir, artifact.title === 'Red' ? 'blue.html' : 'red.html'), artifact.file);
    assert.equal((await (await fetch(`${api}/artifacts/preview?id=${artifact.id}`)).json()).status, 'failed');
  }, { browser: '/nonexistent/preview-browser' });
});

test('cache serves stale bytes while capture is pending, persists, and recovers after failure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lavish-preview-cache-'));
  let revision = 'one';
  let captures = 0;
  let release;
  let fail = false;
  const options = { directory, collect: async () => ({ bundleSha256: revision }), capture: async () => {
    captures += 1;
    if (release) await new Promise((resolve) => { release.resolve = resolve; });
    if (fail) throw new Error('Capture failed');
    return Buffer.from(revision);
  } };
  const artifact = { id: 'fixture', file: 'fixture.html' };
  try {
    let cache = createPreviewCache(options);
    await cache.schedule(artifact); await cache.idle();
    assert.equal(captures, 1);
    cache = createPreviewCache(options);
    assert.equal((await cache.read(artifact.id)).png.toString(), 'one');
    await cache.schedule(artifact); await cache.idle();
    assert.equal(captures, 1, 'unchanged disk cache avoids capture after restart');
    revision = 'two'; release = {};
    await cache.schedule(artifact);
    await eventually(async () => release.resolve, Boolean);
    const stale = await cache.read(artifact.id);
    assert.equal(stale.png.toString(), 'one'); assert.equal(stale.stale, true);
    release.resolve(); release = null; await cache.idle();
    assert.equal((await cache.read(artifact.id)).png.toString(), 'two');
    revision = 'three'; fail = true;
    await cache.schedule(artifact); await cache.idle();
    assert.equal((await cache.read(artifact.id)).status, 'failed');
    assert.equal((await cache.read(artifact.id)).png, null);
    await cache.schedule(artifact); await cache.idle();
    assert.equal(captures, 3, 'failed content is throttled');
    revision = 'four'; fail = false;
    await cache.schedule(artifact); await cache.idle();
    assert.equal((await cache.read(artifact.id)).png.toString(), 'four');
    assert.equal(JSON.parse(await readFile(path.join(directory, 'fixture.json'), 'utf8')).key.length, 64);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('capture uses local CSS and scripts while blocking external, loopback, and file resources', async (t) => {
  try { await browserExecutable(); } catch { t.skip('Chrome/Chromium is not installed'); return; }
  let requests = 0;
  const trap = createServer((req, res) => { requests += 1; res.end('unreachable'); });
  await new Promise((resolve) => trap.listen(0, '127.0.0.1', resolve));
  const remote = `http://127.0.0.1:${trap.address().port}`;
  const html = `<link rel="stylesheet" href="style.css"><script src="local.js"></script><img src="${remote}/image"><iframe src="${remote}/frame"></iframe><img src="file:///etc/passwd"><script>fetch('${remote}/fetch'); new WebSocket('ws://127.0.0.1:${trap.address().port}');</script>`;
  const files = new Map([['index.html', Buffer.from(html)], ['style.css', Buffer.from('body { background: red; }')], ['local.js', Buffer.from("document.addEventListener('DOMContentLoaded', () => { document.body.style.background = 'blue'; });")]]);
  try {
    const scripted = await capturePreview({ file: 'index.html' }, { files });
    files.set('local.js', Buffer.from(''));
    const staticImage = await capturePreview({ file: 'index.html' }, { files });
    assert.notDeepEqual(scripted, staticImage, 'local script affects captured pixels');
    assert.equal(requests, 0, 'capture never contacts even a loopback server');
  } finally { await new Promise((resolve) => trap.close(resolve)); }
});
