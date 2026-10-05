import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Synthetic only: every data directory, CLI and upstream port is overridden.
export async function diagnosticsFixture(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lavish-diagnostics-'));
  const project = path.join(directory, 'Demo project');
  const lavishDir = path.join(project, '.lavish');
  const stateDir = path.join(directory, 'state');
  const configDir = path.join(directory, 'config');
  const archiveRoot = path.join(directory, 'archive');
  await Promise.all([lavishDir, stateDir, configDir, archiveRoot].map((dir) => mkdir(dir, { recursive: true })));
  const file = path.join(lavishDir, 'plan.html');
  const session = { file, status: 'open', updated_at: '2026-10-02T00:00:00Z', ...options.session };
  const writeState = async (value) => writeFile(path.join(stateDir, 'state.json'), JSON.stringify({ sessions: { demo: { file, ...value } } }));
  await writeFile(file, options.html || '<title>Launch review</title><h1>Launch review</h1><p>A synthetic review artifact.</p>');
  await writeState(session);
  await writeFile(path.join(configDir, 'config.json'), JSON.stringify({ projects: [], archiveRoot }));
  if (options.log) await writeFile(path.join(stateDir, 'server.log'), '2026-10-02T00:00:00Z synthetic diagnostic entry\n');
  const upstream = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(options.health || { app: 'lavish-axi', ok: true }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const service = spawn(process.execPath, ['scripts/local-api.mjs'], {
    env: { ...process.env, LAVISH_TRACKER_API_PORT: String(port), LAVISH_TRACKER_UI_PORT: '3000', LAVISH_AXI_PORT: String(upstream.address().port), LAVISH_AXI_STATE_DIR: stateDir, LAVISH_TRACKER_CONFIG_DIR: configDir, LAVISH_AXI_BIN: '/usr/bin/true', LAVISH_TRACKER_BROWSER: '/nonexistent/synthetic-browser' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  service.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => service.once('exit', resolve));
  const api = `http://127.0.0.1:${port}/api`;
  const close = async () => {
    service.kill('SIGTERM');
    await exited;
    await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i += 1) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { /* Starting. */ }
      if (ready) break;
      if (service.exitCode !== null) throw new Error(output || 'Companion exited.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!ready) throw new Error(`Companion did not start: ${output}`);
    return { api, file, session, writeState, stateDir, directory, close };
  } catch (error) { await close(); throw error; }
}
