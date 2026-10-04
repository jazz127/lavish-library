import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = process.cwd();
const configuredPort = 46_000 + (process.pid % 1_000);
const networkHost = Object.values(networkInterfaces()).flat().find((address) => !address.internal && address.family === 'IPv4')?.address;
const networkUnavailable = networkHost ? false : 'A non-loopback IPv4 interface is required to check network binding.';

async function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (connected) => { socket.destroy(); resolve(connected); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function productionFixture(t, settings, host, port) {
  const parent = path.join(root, '.lavish');
  await mkdir(parent, { recursive: true });
  const fixture = await mkdtemp(path.join(parent, 'production-start-test-'));
  const configDir = path.join(fixture, 'config');
  const stateDir = path.join(fixture, 'state');
  await Promise.all([
    mkdir(path.join(fixture, 'dist', 'server'), { recursive: true }),
    mkdir(path.join(fixture, 'dist', 'client'), { recursive: true }),
    mkdir(configDir),
    mkdir(stateDir),
    symlink(path.join(root, 'scripts'), path.join(fixture, 'scripts'), 'dir'),
    symlink(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'dir'),
  ]);
  await Promise.all([
    writeFile(path.join(fixture, 'package.json'), JSON.stringify({ type: 'module', scripts: { start: 'node scripts/run-local.mjs start' } })),
    writeFile(path.join(fixture, 'dist', 'server', 'index.js'), 'export default () => new Response("production-start-fixture");\n'),
    writeFile(path.join(configDir, 'config.json'), JSON.stringify({ projects: [], archiveRoot: null })),
    writeFile(path.join(stateDir, 'state.json'), JSON.stringify({ sessions: {} })),
  ]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LAVISH_')));
  const child = spawn('npm', ['start'], {
    cwd: fixture,
    env: {
      ...env,
      LAVISH_TRACKER_API_PORT: String(configuredPort + 10),
      LAVISH_TRACKER_CONFIG_DIR: configDir,
      LAVISH_AXI_STATE_DIR: stateDir,
      ...settings,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      process.kill(-child.pid, 'SIGTERM');
      await exited;
    }
    await rm(fixture, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Production launcher exited: ${output}`);
    try {
      const response = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(500) });
      if (response.ok && await response.text() === 'production-start-fixture') return;
    } catch { }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Production UI did not start: ${output}`);
}

test('npm start binds only loopback on the default UI port', { skip: networkUnavailable }, async (t) => {
  await productionFixture(t, {}, '127.0.0.1', 3000);
  assert.equal(await canConnect(networkHost, 3000), false);
});

test('npm start honors an opted-in bind host and configured UI port', { skip: networkUnavailable }, async (t) => {
  await productionFixture(t, {
    LAVISH_TRACKER_BIND_HOST: '0.0.0.0',
    LAVISH_TRACKER_UI_PORT: String(configuredPort),
    LAVISH_TRACKER_ALLOWED_ORIGINS: 'https://library.example.com',
  }, networkHost, configuredPort);
  assert.equal(await canConnect('127.0.0.1', configuredPort), true);
});

test('npm start normalizes a bracketed IPv6 bind host', async (t) => {
  await productionFixture(t, {
    LAVISH_TRACKER_BIND_HOST: '[::1]',
    LAVISH_TRACKER_UI_PORT: String(configuredPort + 1),
  }, '[::1]', configuredPort + 1);
  assert.equal(await canConnect('127.0.0.1', configuredPort + 1), false);
});
