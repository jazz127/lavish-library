import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReadFailure } from './read-failure.mjs';

export async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function backupFixture(run, { uiPort = 3000, readFailures = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lavish-backup-'));
  const source = path.join(directory, 'project', '.lavish');
  const configDir = path.join(directory, 'config');
  const stateDir = path.join(directory, 'state');
  const archiveRoot = path.join(directory, 'archive');
  await Promise.all([source, configDir, stateDir].map((dir) => mkdir(dir, { recursive: true })));
  const file = path.join(source, 'plan.html');
  await writeFile(file, '<title>Synthetic backup plan</title><h1>First revision</h1>');
  await writeFile(path.join(stateDir, 'state.json'), JSON.stringify({ sessions: { demo: { file } } }));
  const configure = async (enabled) => writeFile(path.join(configDir, 'config.json'), JSON.stringify({ projects: [], archiveRoot: enabled ? archiveRoot : null }));
  await configure(false);
  const port = await freePort();
  const readFailure = readFailures ? await createReadFailure(directory) : null;
  const service = spawn(process.execPath, [...(readFailure ? ['--import', readFailure.preload] : []), 'scripts/local-api.mjs'], {
    env: { ...process.env, LAVISH_TRACKER_CONFIG_DIR: configDir, LAVISH_AXI_STATE_DIR: stateDir, LAVISH_TRACKER_API_PORT: String(port), LAVISH_TRACKER_UI_PORT: String(uiPort), LAVISH_AXI_PORT: String(await freePort()), LAVISH_AXI_BIN: '/usr/bin/true' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  service.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => service.once('exit', resolve));
  const api = `http://127.0.0.1:${port}/api`;
  const library = async () => (await fetch(`${api}/library`)).json();
  const snapshot = async () => fetch(`${api}/artifacts/snapshot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file }) });
  const archiveDirectory = async () => {
    const home = path.join(archiveRoot, 'Lavish Library Archive');
    const [project] = await readdir(home);
    const [artifact] = await readdir(path.join(home, project));
    return path.join(home, project, artifact);
  };
  const blockFirst = async () => { await writeFile(archiveRoot, 'Synthetic unavailable archive'); await configure(true); };
  const unblockFirst = async () => { await rm(archiveRoot); await mkdir(archiveRoot); };
  const blockNext = async () => {
    const versions = path.join(await archiveDirectory(), 'versions');
    await rename(versions, `${versions}-saved`);
    await writeFile(versions, 'Synthetic write failure');
    await writeFile(file, '<title>Synthetic backup plan</title><h1>Latest unprotected revision</h1>');
  };
  const unblockNext = async () => {
    const versions = path.join(await archiveDirectory(), 'versions');
    await rm(versions);
    await rename(`${versions}-saved`, versions);
  };
  try {
    for (let i = 0; i < 60; i += 1) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* Starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await run({ api, file, configure, library, snapshot, blockFirst, unblockFirst, blockNext, unblockNext, setUnreadableFiles: readFailure?.setUnreadableFiles, readManifest: async () => JSON.parse(await readFile(path.join(await archiveDirectory(), 'manifest.json'), 'utf8')) });
  } catch (error) { error.message += `\nCompanion stderr: ${stderr}`; throw error; }
  finally { service.kill('SIGTERM'); await exited; await rm(directory, { recursive: true, force: true }); }
}
