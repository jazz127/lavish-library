import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freePort } from './helpers/backup-fixture.mjs';

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

async function startupFixture(t, settings, host, port, { mode = 'start', envFiles = {} } = {}) {
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
    writeFile(path.join(fixture, 'package.json'), JSON.stringify({ type: 'module', scripts: { start: 'node scripts/run-local.mjs start', dev: 'node scripts/run-local.mjs dev' } })),
    writeFile(path.join(fixture, 'dist', 'server', 'index.js'), 'export default () => new Response("production-start-fixture");\n'),
    writeFile(path.join(fixture, 'vite.config.ts'), `
      import projectConfig from ${JSON.stringify(path.join(root, 'vite.config.ts'))};
      export default async (env) => ({
        ...await projectConfig(env),
        plugins: [{ name: 'startup-fixture', configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/') return next();
            res.end('production-start-fixture');
          });
        } }],
      });
    `),
    copyFile(path.join(root, 'app', 'api-client.ts'), path.join(fixture, 'api-client.ts')),
    writeFile(path.join(configDir, 'config.json'), JSON.stringify({ projects: [], archiveRoot: null })),
    writeFile(path.join(stateDir, 'state.json'), JSON.stringify({ sessions: {} })),
    ...Object.entries({ '.env': `LAVISH_TRACKER_API_PORT=${configuredPort + 10}\n`, ...envFiles })
      .map(([file, contents]) => writeFile(path.join(fixture, file), contents)),
  ]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LAVISH_')));
  const child = spawn('npm', mode === 'start' ? ['start'] : ['run', 'dev'], {
    cwd: fixture,
    env: {
      ...env,
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
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`App launcher exited: ${output}`);
    try {
      const response = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(500) });
      if (response.ok && await response.text() === 'production-start-fixture') return;
    } catch { }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`App UI did not start: ${output}`);
}

test('npm start binds only loopback on an available UI port', { skip: networkUnavailable }, async (t) => {
  const port = await freePort();
  await startupFixture(t, { LAVISH_TRACKER_UI_PORT: String(port) }, '127.0.0.1', port);
  assert.equal(await canConnect(networkHost, port), false);
});

test('npm start honors an opted-in bind host and configured UI port', { skip: networkUnavailable }, async (t) => {
  await startupFixture(t, {
    LAVISH_TRACKER_BIND_HOST: '0.0.0.0',
    LAVISH_TRACKER_UI_PORT: String(configuredPort),
    LAVISH_TRACKER_ALLOWED_ORIGINS: 'https://library.example.com',
  }, networkHost, configuredPort);
  assert.equal(await canConnect('127.0.0.1', configuredPort), true);
});

test('npm start normalizes a bracketed IPv6 bind host', async (t) => {
  await startupFixture(t, {
    LAVISH_TRACKER_BIND_HOST: '[::1]',
    LAVISH_TRACKER_UI_PORT: String(configuredPort + 1),
  }, '[::1]', configuredPort + 1);
  assert.equal(await canConnect('127.0.0.1', configuredPort + 1), false);
});

for (const mode of ['dev', 'start']) {
  test(`npm ${mode === 'dev' ? 'run dev' : 'start'} shares mode-specific dotenv settings with the companion`, { skip: networkUnavailable }, async (t) => {
    const uiPort = configuredPort + (mode === 'dev' ? 2 : 3);
    const apiPort = configuredPort + 11;
    const origin = `http://${networkHost}:${uiPort}`;
    const api = `http://${networkHost}:${apiPort}`;
    const envMode = mode === 'dev' ? 'development' : 'production';
    const otherMode = mode === 'dev' ? 'production' : 'development';
    await startupFixture(t, {}, networkHost, uiPort, { mode, envFiles: {
      '.env': `LAVISH_TRACKER_API_PORT=${configuredPort + 10}\nLAVISH_TRACKER_UI_PORT=${configuredPort + 20}\n`,
      '.env.local': `LAVISH_TRACKER_BIND_HOST=0.0.0.0\nLAVISH_TRACKER_ALLOWED_ORIGINS=${origin}\nLAVISH_TRACKER_API_PORT=${apiPort}\nLAVISH_TRACKER_API_BASE=${api}\n`,
      [`.env.${envMode}`]: 'LAVISH_TRACKER_ALLOWED_ORIGINS=https://ignored.example.com\n',
      [`.env.${envMode}.local`]: `LAVISH_TRACKER_UI_PORT=${uiPort}\n`,
      [`.env.${otherMode}.local`]: 'LAVISH_TRACKER_BIND_HOST=invalid/host\n',
    } });
    await assertRemoteCompanion(api, origin);
    if (mode === 'dev') {
      const bootstrap = await fetch(`${origin}/@vite/env`);
      assert.equal(bootstrap.status, 200);
      const environmentModule = await bootstrap.text();
      const response = await fetch(`${origin}/api-client.ts`);
      assert.equal(response.status, 200);
      const clientModule = await response.text();
      const originalFetch = globalThis.fetch;
      const originalApiBase = globalThis.__LAVISH_TRACKER_API_BASE__;
      const calls = [];
      globalThis.fetch = async (url, init = {}) => {
        calls.push(String(url));
        return originalFetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), origin } });
      };
      try {
        await import(`data:text/javascript;base64,${Buffer.from(environmentModule).toString('base64')}`);
        const { apiFetch } = await import(`data:text/javascript;base64,${Buffer.from(clientModule).toString('base64')}`);
        assert.equal((await apiFetch('/library')).status, 200);
        assert.deepEqual(calls, [`${api}/api/session`, `${api}/api/library`]);
      } finally {
        globalThis.fetch = originalFetch;
        if (originalApiBase === undefined) delete globalThis.__LAVISH_TRACKER_API_BASE__;
        else globalThis.__LAVISH_TRACKER_API_BASE__ = originalApiBase;
      }
    }
  });
}

test('shell settings override dotenv for both production services', { skip: networkUnavailable }, async (t) => {
  const uiPort = configuredPort + 4;
  const apiPort = configuredPort + 12;
  const origin = `http://${networkHost}:${uiPort}`;
  const api = `http://${networkHost}:${apiPort}`;
  await startupFixture(t, {
    LAVISH_TRACKER_BIND_HOST: '0.0.0.0',
    LAVISH_TRACKER_UI_PORT: String(uiPort),
    LAVISH_TRACKER_API_PORT: String(apiPort),
    LAVISH_TRACKER_ALLOWED_ORIGINS: origin,
  }, networkHost, uiPort, { envFiles: {
    '.env.production.local': 'LAVISH_TRACKER_BIND_HOST=127.0.0.1\nLAVISH_TRACKER_UI_PORT=3000\nLAVISH_TRACKER_API_PORT=4318\nLAVISH_TRACKER_ALLOWED_ORIGINS=https://ignored.example.com\n',
  } });
  await assertRemoteCompanion(api, origin);
});

async function assertRemoteCompanion(api, origin) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${api}/health`, { signal: AbortSignal.timeout(500) })).ok) break; } catch { }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const session = await fetch(`${api}/api/session`, { headers: { origin } });
  assert.equal(session.status, 200);
  const { token } = await session.json();
  assert.equal(typeof token, 'string');
  const library = await fetch(`${api}/api/library`, { headers: { origin, 'x-lavish-token': token } });
  assert.equal(library.status, 200);
  assert.deepEqual((await library.json()).artifacts, []);
  const rejected = await fetch(`${api}/api/session`, { headers: { origin: 'https://ignored.example.com' } });
  assert.equal(rejected.status, 403);
}
