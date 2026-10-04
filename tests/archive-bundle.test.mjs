import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

async function fixture(run, { pauseAfterVersion, pauseArchiveName = 'archive', pauseReason, pauseReadFile, pauseReadArchiveName = 'archive', pauseBeforePublication = false, pauseRestoreWrite = false, trackArchiveReads = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lavish-bundle-'));
  const sourceDir = path.join(directory, 'project', '.lavish');
  const stateDir = path.join(directory, 'state');
  const configDir = path.join(directory, 'config');
  const archiveRoot = path.join(directory, 'archive');
  await Promise.all([sourceDir, stateDir, configDir].map((dir) => mkdir(dir, { recursive: true })));
  const file = path.join(sourceDir, 'plan.html');
  const html = '<title>Bundle plan</title><link href="assets/style.css"><img src="assets/logo.png">';
  await mkdir(path.join(sourceDir, 'assets'));
  await writeFile(file, html);
  await writeFile(path.join(sourceDir, 'assets/style.css'), 'body { color: red; background: url("nested/icon.png"); }');
  await mkdir(path.join(sourceDir, 'assets/nested'));
  await writeFile(path.join(sourceDir, 'assets/nested/icon.png'), 'icon-one');
  await writeFile(path.join(sourceDir, 'assets/logo.png'), 'logo-one');
  await writeFile(path.join(stateDir, 'state.json'), JSON.stringify({ sessions: { demo: { file } } }));
  await writeFile(path.join(configDir, 'config.json'), JSON.stringify({ projects: [], archiveRoot }));
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const serviceArgs = [];
  const pauseEnabled = Boolean(pauseAfterVersion || pauseReadFile || pauseBeforePublication || pauseRestoreWrite || trackArchiveReads);
  if (pauseEnabled) {
    // Hold the manifest rename's completion after its bytes become observable.
    // IPC lets the test delete a dependency in that window without a timed sleep.
    const preload = path.join(directory, 'pause-manifest.mjs');
    await writeFile(preload, `
      import fs from 'node:fs/promises';
      import { once } from 'node:events';
      import { syncBuiltinESMExports } from 'node:module';
      const rename = fs.rename;
      const readFile = fs.readFile;
      const writeFile = fs.writeFile;
      const appendFile = fs.appendFile;
      let paused = false;
      const pause = async (message) => {
        paused = true;
        const resumed = once(process, 'message');
        process.send(message);
        await resumed;
      };
      fs.readFile = async (file, ...args) => {
        const bytes = await readFile(file, ...args);
        if (${trackArchiveReads} && String(file).includes('/versions/') && String(file).endsWith('.html')) await appendFile(${JSON.stringify(path.join(directory, 'archive-reads.log'))}, String(file) + '\\n');
        if (!paused && ${Boolean(pauseReadFile)} && file === ${JSON.stringify(path.join(sourceDir, pauseReadFile || ''))}) {
          const config = JSON.parse(await readFile(${JSON.stringify(path.join(configDir, 'config.json'))}, 'utf8'));
          if (config.archiveRoot === ${JSON.stringify(path.join(directory, pauseReadArchiveName))}) await pause('read-paused');
        }
        return bytes;
      };
      fs.writeFile = async (file, ...args) => {
        await writeFile(file, ...args);
        if (!paused && ${pauseRestoreWrite} && file === ${JSON.stringify(file)} && (await readFile(${JSON.stringify(file)}, 'utf8')) === ${JSON.stringify(html)}) await pause('restore-write-paused');
        if (!paused && ${pauseBeforePublication} && file.endsWith('/manifest.json.' + process.pid + '.tmp')) await pause('publication-paused');
      };
      fs.rename = async (source, destination) => {
        await rename(source, destination);
        if (paused || !destination.endsWith('/manifest.json') || !destination.startsWith(${JSON.stringify(path.join(directory, pauseArchiveName) + path.sep)})) return;
        const manifest = JSON.parse(await fs.readFile(destination, 'utf8'));
        if (manifest.versions.length !== ${pauseAfterVersion || 0}) return;
        if (${JSON.stringify(pauseReason || '')} && manifest.versions.at(-1).reason !== ${JSON.stringify(pauseReason || '')}) return;
        await pause('manifest-published');
      };
      syncBuiltinESMExports();
    `);
    serviceArgs.push('--import', preload);
  }
  const service = spawn(process.execPath, [...serviceArgs, 'scripts/local-api.mjs'], {
    env: { ...process.env, LAVISH_TRACKER_API_PORT: String(port), LAVISH_TRACKER_CONFIG_DIR: configDir, LAVISH_AXI_STATE_DIR: stateDir, LAVISH_AXI_BIN: '/usr/bin/true' },
    stdio: pauseEnabled ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore',
  });
  const publicationPaused = pauseEnabled ? once(service, 'message') : null;
  const exited = once(service, 'exit');
  const api = `http://127.0.0.1:${port}/api`;
  const get = async (route) => {
    const response = await fetch(`${api}${route}`);
    const result = await response.json();
    assert.equal(response.ok, true, result.error);
    return result;
  };
  const post = async (route, value = { file }) => {
    const response = await fetch(`${api}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
    const result = await response.json();
    assert.equal(response.ok, true, result.error);
    return result;
  };
  const history = () => get(`/artifacts/versions?file=${encodeURIComponent(file)}`);
  try {
    for (let i = 0; i < 60; i += 1) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* Starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await run({ directory, sourceDir, file, html, api, get, post, history, publicationPaused, archiveReads: async () => (await readFile(path.join(directory, 'archive-reads.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean), resumePublication: () => service.send('resume') });
  } finally {
    service.kill('SIGTERM');
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
}

async function waitForVersion(history, count) {
  for (let i = 0; i < 100; i += 1) {
    const result = await history();
    if (result.versions.length >= count) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Watcher did not archive ${count} versions`);
}

test('reconciliation archives asset-only edits and current compares the complete bundle', async () => {
  await fixture(async ({ sourceDir, get, post, history }) => {
    await post('/artifacts/snapshot');
    const baseline = (await history()).versions[0];
    await writeFile(path.join(sourceDir, 'assets/logo.png'), 'logo-two');
    assert.equal((await history()).versions.some((version) => version.isCurrent), false);
    await get('/library');
    const result = await history();
    assert.equal(result.versions.length, 2);
    assert.equal(result.versions[0].sha256, baseline.sha256);
    assert.notEqual(result.versions[0].bundleSha256, baseline.bundleSha256);
    assert.equal(result.versions[0].isCurrent, true);
    assert.equal(result.versions[1].isCurrent, false);
    await get('/library');
    assert.equal((await history()).versions.length, 2);
  });
});

async function editPublishedDependency(context, publication, versionCount) {
  const { sourceDir, history, publicationPaused, resumePublication } = context;
  assert.equal((await publicationPaused)[0], 'manifest-published');
  const published = await history();
  assert.equal(published.versions.length, versionCount);
  const icon = path.join(sourceDir, 'assets/nested/icon.png');
  await writeFile(icon, 'edited-after-publication');
  resumePublication();
  await publication;
  const changed = await waitForVersion(history, versionCount + 1);
  assert.equal(changed.versions[0].reason, 'change');
  assert.equal(changed.versions[0].isCurrent, true);
  assert.equal(await readFile(path.join(changed.archivePath, path.dirname(changed.versions[0].file), 'assets/nested/icon.png'), 'utf8'), 'edited-after-publication');
  assert.equal(await readFile(path.join(published.archivePath, path.dirname(published.versions[0].file), 'assets/nested/icon.png'), 'utf8'), 'icon-one');
  return changed;
}

test('manual snapshot watches dependencies before its first manifest is published', { timeout: 15_000 }, async () => {
  await fixture(async (context) => {
    await editPublishedDependency(context, context.post('/artifacts/snapshot'), 1);
  }, { pauseAfterVersion: 1 });
});

test('initial archive setup watches each artifact before its baseline is published', { timeout: 15_000 }, async () => {
  await fixture(async (context) => {
    const { directory, sourceDir, file, get } = context;
    const configFile = path.join(directory, 'config/config.json');
    await writeFile(configFile, JSON.stringify({ projects: [], archiveRoot: null }));
    const secondFile = path.join(sourceDir, 'other/second.html');
    await mkdir(path.dirname(secondFile));
    await writeFile(secondFile, '<title>Second artifact</title>');
    await writeFile(path.join(directory, 'state/state.json'), JSON.stringify({ sessions: { demo: { file }, second: { file: secondFile } } }));
    assert.equal((await get('/library')).artifacts.length, 2);
    await writeFile(configFile, JSON.stringify({ projects: [], archiveRoot: path.join(directory, 'archive') }));
    await editPublishedDependency(context, get('/library'), 1);
    await writeFile(secondFile, '<title>Second artifact edited</title>');
    const secondHistory = () => get(`/artifacts/versions?file=${encodeURIComponent(secondFile)}`);
    const secondChanged = await waitForVersion(secondHistory, 2);
    assert.equal(secondChanged.versions[0].reason, 'change');
    assert.equal(await readFile(path.join(secondChanged.archivePath, secondChanged.versions[0].file), 'utf8'), '<title>Second artifact edited</title>');
  }, { pauseAfterVersion: 1 });
});

test('archive switches replace dependency watchers before publishing the new baseline', { timeout: 15_000 }, async () => {
  await fixture(async (context) => {
    const { directory, get } = context;
    await get('/library');
    const nextArchive = path.join(directory, 'archive-next');
    await writeFile(path.join(directory, 'config/config.json'), JSON.stringify({ projects: [], archiveRoot: nextArchive }));
    const changed = await editPublishedDependency(context, get('/library'), 1);
    assert.equal(changed.archivePath.startsWith(nextArchive + path.sep), true);
  }, { pauseAfterVersion: 1, pauseArchiveName: 'archive-next' });
});

test('missing-source restore watches recreated dependencies before publishing its version', { timeout: 15_000 }, async () => {
  await fixture(async (context) => {
    const { file, post, get, history } = context;
    await post('/artifacts/snapshot');
    const baseline = (await history()).versions[0];
    await writeFile(file, '<title>Newer document</title>');
    await post('/artifacts/snapshot');
    await rm(file);
    await get('/library');
    await editPublishedDependency(context, post('/versions/restore', { file, versionId: baseline.id }), 3);
  }, { pauseAfterVersion: 3, pauseReason: 'restore' });
});

test('deduplicated snapshots rearm dependency watchers after archive is re-enabled', async () => {
  await fixture(async ({ directory, sourceDir, post, history }) => {
    await post('/artifacts/snapshot');
    await post('/archive/disable', {});
    await writeFile(path.join(directory, 'config/config.json'), JSON.stringify({ projects: [], archiveRoot: path.join(directory, 'archive') }));
    await post('/artifacts/snapshot');
    assert.equal((await history()).versions.length, 1);
    await writeFile(path.join(sourceDir, 'assets/nested/icon.png'), 'changed-after-rearming');
    const changed = await waitForVersion(history, 2);
    assert.equal(changed.versions[0].reason, 'change');
    assert.equal(await readFile(path.join(changed.archivePath, path.dirname(changed.versions[0].file), 'assets/nested/icon.png'), 'utf8'), 'changed-after-rearming');
  });
});

for (const [stage, options] of [
  ['collection', { pauseReadFile: 'assets/nested/icon.png' }],
  ['publication', { pauseBeforePublication: true }],
]) {
  test(`pause during ${stage} prevents a pending snapshot from publishing or restarting backups`, { timeout: 15_000 }, async () => {
    await fixture(async ({ sourceDir, file, api, post, get, history, publicationPaused, resumePublication }) => {
      const pending = fetch(`${api}/artifacts/snapshot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file }) });
      await publicationPaused;
      const archived = await history();
      await post('/archive/disable', {});
      assert.equal((await get('/library')).archive.enabled, false);
      resumePublication();
      const response = await pending;
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /Archive settings changed/);
      assert.deepEqual(await readdir(path.join(archived.archivePath, 'versions')).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)), []);
      assert.deepEqual((await readdir(archived.archivePath).catch(() => [])).filter((name) => name.endsWith('.tmp')), []);
      await writeFile(path.join(sourceDir, 'assets/nested/icon.png'), 'edited-while-paused');
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await assert.rejects(readFile(path.join(archived.archivePath, 'manifest.json')), { code: 'ENOENT' });
    }, options);
  });
}

test('an old autosave queued behind an archive switch cannot reclaim the new watchers', { timeout: 15_000 }, async () => {
  await fixture(async ({ directory, sourceDir, post, get, history, publicationPaused, resumePublication }) => {
    await post('/artifacts/snapshot');
    const previous = await history();
    const nextArchive = path.join(directory, 'archive-next');
    await writeFile(path.join(directory, 'config/config.json'), JSON.stringify({ projects: [], archiveRoot: nextArchive }));
    const scanning = get('/library');
    assert.equal((await publicationPaused)[0], 'read-paused');
    const icon = path.join(sourceDir, 'assets/nested/icon.png');
    await writeFile(icon, 'edited-during-switch');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    resumePublication();
    await scanning;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const oldManifest = JSON.parse(await readFile(path.join(previous.archivePath, 'manifest.json'), 'utf8'));
    assert.equal(oldManifest.versions.length, 1);
    await writeFile(icon, 'new-archive-only');
    const changed = await waitForVersion(history, 2);
    assert.equal(changed.archivePath.startsWith(nextArchive + path.sep), true);
    assert.equal(changed.versions[0].reason, 'change');
    assert.equal(await readFile(path.join(changed.archivePath, path.dirname(changed.versions[0].file), 'assets/nested/icon.png'), 'utf8'), 'new-archive-only');
  }, { pauseReadFile: 'assets/nested/icon.png', pauseReadArchiveName: 'archive-next' });
});

test('superseded scan cleanup leaves the active archive watchers intact', { timeout: 15_000 }, async () => {
  await fixture(async ({ directory, sourceDir, get, history, publicationPaused, resumePublication }) => {
    const oldScan = get('/library');
    assert.equal((await publicationPaused)[0], 'read-paused');
    const nextArchive = path.join(directory, 'archive-next');
    await writeFile(path.join(directory, 'config/config.json'), JSON.stringify({ projects: [], archiveRoot: nextArchive }));
    const active = await get('/library');
    assert.equal(active.archive.root, nextArchive);
    assert.equal(active.archive.totalVersions, 1);
    resumePublication();
    await oldScan;
    await writeFile(path.join(sourceDir, 'assets/nested/icon.png'), 'active-scan-watchers');
    const changed = await waitForVersion(history, 2);
    assert.equal(changed.versions[0].reason, 'change');
    assert.equal(await readFile(path.join(changed.archivePath, path.dirname(changed.versions[0].file), 'assets/nested/icon.png'), 'utf8'), 'active-scan-watchers');
  }, { pauseReadFile: 'plan.html' });
});

for (const keepExisting of [false, true]) {
  test(`a stale same-archive scan preserves ${keepExisting ? 'refreshed' : 'newly installed'} restore watchers`, { timeout: 15_000 }, async () => {
    await fixture(async ({ directory, sourceDir, file, html, get, post, publicationPaused, resumePublication }) => {
      const secondDir = path.join(sourceDir, 'recovery');
      const secondFile = path.join(secondDir, 'second.html');
      const secondHtml = '<title>Recovered artifact</title><img src="nested/icon.png">';
      const icon = path.join(secondDir, 'nested/icon.png');
      await mkdir(path.dirname(icon), { recursive: true });
      await writeFile(secondFile, secondHtml);
      await writeFile(icon, 'recovery-baseline');
      await writeFile(path.join(directory, 'state/state.json'), JSON.stringify({ sessions: { demo: { file }, second: { file: secondFile } } }));
      await post('/artifacts/snapshot');
      await post('/artifacts/snapshot', { file: secondFile });
      const secondHistory = () => get(`/artifacts/versions?file=${encodeURIComponent(secondFile)}`);
      const baseline = (await secondHistory()).versions[0];
      await rm(secondFile);
      if (!keepExisting) await get('/library');
      await writeFile(file, `${html}<p>Changed before scanning</p>`);
      const scanning = get('/library');
      assert.equal((await publicationPaused)[0], 'manifest-published');
      const restored = await post('/versions/restore', { file: secondFile, versionId: baseline.id });
      assert.equal(restored.sourceRecreated, true);
      resumePublication();
      const stale = await scanning;
      assert.equal(stale.artifacts.find((artifact) => artifact.file === secondFile).exists, false);
      await writeFile(icon, 'edited-after-restoring');
      const assetChange = await waitForVersion(secondHistory, 2);
      assert.equal(assetChange.versions[0].reason, 'change');
      assert.equal(await readFile(path.join(assetChange.archivePath, path.dirname(assetChange.versions[0].file), 'nested/icon.png'), 'utf8'), 'edited-after-restoring');
      const updatedHtml = `${secondHtml}<p>Changed after restoring</p>`;
      await writeFile(`${secondFile}.tmp`, updatedHtml);
      await rename(`${secondFile}.tmp`, secondFile);
      const htmlChange = await waitForVersion(secondHistory, 3);
      assert.equal(htmlChange.versions[0].reason, 'change');
      assert.equal(await readFile(path.join(htmlChange.archivePath, htmlChange.versions[0].file), 'utf8'), updatedHtml);
    }, { pauseAfterVersion: 2 });
  });
}

test('directory watchers archive nested assets and survive atomic replacement', async () => {
  await fixture(async ({ sourceDir, get, history, publicationPaused, resumePublication }) => {
    await get('/library');
    const icon = path.join(sourceDir, 'assets/nested/icon.png');
    await writeFile(`${icon}.tmp`, 'icon-two');
    await rename(`${icon}.tmp`, icon);
    let result = await waitForVersion(history, 2);
    assert.equal(result.versions[0].reason, 'change');
    await writeFile(icon, 'icon-three');
    result = await waitForVersion(history, 3);
    assert.equal(result.versions[0].reason, 'change');
    assert.equal(result.versions[0].isCurrent, true);
    await writeFile(path.join(sourceDir, 'assets/style.css'), 'body { background: url("nested/new/deep.png"); }');
    result = await waitForVersion(history, 4);
    assert.equal(result.versions[0].reason, 'change');
    await mkdir(path.join(sourceDir, 'assets/nested/new'));
    await writeFile(path.join(sourceDir, 'assets/nested/new/deep.png'), 'new-dependency');
    result = await waitForVersion(history, 5);
    assert.equal(result.versions[0].reason, 'change');
    assert.equal(result.versions[0].isCurrent, true);
    assert.equal((await publicationPaused)[0], 'manifest-published');
    // Delete while version 5 is visible but its publication call is still pending.
    // The new dependency directory must already be watched at this point.
    await rm(path.join(sourceDir, 'assets/nested/new/deep.png'));
    resumePublication();
    result = await waitForVersion(history, 6);
    assert.equal(result.versions[0].reason, 'change');
    assert(result.versions[0].bundle.some((entry) => entry.path === 'assets/nested/new/deep.png' && entry.status === 'missing'));
  }, { pauseAfterVersion: 5 });
});

test('restore snapshots newer asset bytes, including assets omitted by current HTML', async () => {
  await fixture(async ({ sourceDir, file, html, post, history }) => {
    await post('/artifacts/snapshot');
    const baseline = (await history()).versions[0];
    await writeFile(path.join(sourceDir, 'assets/logo.png'), 'newer-logo');
    await post('/versions/restore', { file, versionId: baseline.id });
    let result = await history();
    const safety = result.versions.find((version) => version.reason === 'pre-restore');
    assert(safety);
    assert.equal(await readFile(path.join(result.archivePath, path.dirname(safety.file), 'assets/logo.png'), 'utf8'), 'newer-logo');
    assert.equal(await readFile(path.join(sourceDir, 'assets/logo.png'), 'utf8'), 'logo-one');
    await writeFile(file, '<title>Bundle plan</title>');
    await writeFile(path.join(sourceDir, 'assets/logo.png'), 'unreferenced-newer-logo');
    await post('/versions/restore', { file, versionId: baseline.id });
    result = await history();
    const omittedSafety = result.versions.find((version) => version.reason === 'pre-restore');
    assert.equal(await readFile(path.join(result.archivePath, path.dirname(omittedSafety.file), 'assets/logo.png'), 'utf8'), 'unreferenced-newer-logo');
    await post('/versions/restore', { file, versionId: omittedSafety.id });
    assert.equal(await readFile(file, 'utf8'), '<title>Bundle plan</title>');
    assert.equal(await readFile(path.join(sourceDir, 'assets/logo.png'), 'utf8'), 'unreferenced-newer-logo');
    assert.equal((await history()).versions[0].isCurrent, true);
    assert.notEqual(await readFile(file, 'utf8'), html);
  });
});

test('schemaVersion 1 archives compare assets, restore, and retain original entries and bytes', async () => {
  await fixture(async ({ sourceDir, file, html, post, history }) => {
    await writeFile(file, `${html}<img src="legacy-missing.png">`);
    await post('/artifacts/snapshot');
    const baselineHistory = await history();
    const manifestFile = path.join(baselineHistory.archivePath, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    manifest.schemaVersion = 1;
    for (const version of manifest.versions) {
      delete version.bundleSha256;
      delete version.bundle;
      delete version.supplementalAssets;
    }
    await writeFile(manifestFile, JSON.stringify(manifest));
    const legacy = manifest.versions[0];
    const legacyHtml = await readFile(path.join(baselineHistory.archivePath, legacy.file));
    assert.equal((await history()).versions[0].isCurrent, true);
    await writeFile(path.join(sourceDir, 'assets/logo.png'), 'legacy-newer-logo');
    await writeFile(path.join(sourceDir, 'legacy-missing.png'), 'not-in-legacy-archive');
    assert.equal((await history()).versions[0].isCurrent, false);
    await post('/versions/restore', { file, versionId: legacy.id });
    assert.equal(await readFile(path.join(sourceDir, 'assets/logo.png'), 'utf8'), 'logo-one');
    const updated = JSON.parse(await readFile(manifestFile, 'utf8'));
    assert.equal(updated.schemaVersion, 2);
    assert.equal(await readFile(path.join(sourceDir, 'legacy-missing.png'), 'utf8'), 'not-in-legacy-archive');
    assert.deepEqual(updated.versions[0], legacy);
    assert.deepEqual(await readFile(path.join(baselineHistory.archivePath, legacy.file)), legacyHtml);
  });
});

test('missing assets affect identity; remote, data, and escaping symlink bytes are excluded', async () => {
  await fixture(async ({ directory, sourceDir, file, html, post, history }) => {
    const external = path.join(directory, 'external.png');
    await writeFile(external, 'outside-one');
    await symlink(external, path.join(sourceDir, 'linked.png'));
    await writeFile(file, `${html}<img src="missing/deep.png"><img src="linked.png"><img src="https://example.invalid/image.png"><img src="data:image/png;base64,AAAA"><img srcset="data:image/png;base64,BBBB 1x, assets/logo.png 2x">`);
    await post('/artifacts/snapshot');
    let result = await history();
    assert(result.versions[0].bundle.some((entry) => entry.path === 'missing/deep.png' && entry.status === 'missing'));
    assert(result.versions[0].bundle.some((entry) => entry.path === 'linked.png' && entry.status === 'symlink'));
    assert.equal(result.versions[0].bundle.some((entry) => /https:|data:|AAAA|BBBB/.test(entry.path)), false);
    await writeFile(external, 'outside-two');
    await post('/artifacts/snapshot');
    assert.equal((await history()).versions.length, 1);
    await mkdir(path.join(sourceDir, 'missing'));
    await writeFile(path.join(sourceDir, 'missing/deep.png'), 'found');
    await post('/artifacts/snapshot');
    result = await history();
    assert.equal(result.versions.length, 2);
    assert.equal(result.versions[0].isCurrent, true);
    assert.equal(await readFile(external, 'utf8'), 'outside-two');
  });
});


test('referenced directory contents keep literal filenames and safety copies survive type changes', async () => {
  await fixture(async ({ sourceDir, file, post, history }) => {
    const assetDir = path.join(sourceDir, 'bundle');
    await mkdir(assetDir);
    await writeFile(path.join(assetDir, 'a#b%20.png'), 'literal-one');
    await writeFile(file, '<title>Directory bundle</title><link href="bundle/">');
    await post('/artifacts/snapshot');
    const baselineHistory = await history();
    const baseline = baselineHistory.versions[0];
    assert.equal(await readFile(path.join(baselineHistory.archivePath, path.dirname(baseline.file), 'bundle/a#b%20.png'), 'utf8'), 'literal-one');
    await writeFile(path.join(assetDir, 'a#b%20.png'), 'literal-two');
    await writeFile(file, '<title>No references</title>');
    await post('/versions/restore', { file, versionId: baseline.id });
    const safety = (await history()).versions.find((version) => version.reason === 'pre-restore');
    await post('/versions/restore', { file, versionId: safety.id });
    assert.equal(await readFile(path.join(assetDir, 'a#b%20.png'), 'utf8'), 'literal-two');
    await rm(assetDir, { recursive: true });
    await writeFile(assetDir, 'directory-replaced-with-file');
    await post('/versions/restore', { file, versionId: baseline.id });
    const typeSafety = (await history()).versions.find((version) => version.reason === 'pre-restore');
    await post('/versions/restore', { file, versionId: typeSafety.id });
    assert.equal(await readFile(assetDir, 'utf8'), 'directory-replaced-with-file');
  });
});

test('restoring missing assets preserves newly created bytes before removing them', async () => {
  await fixture(async ({ sourceDir, file, html, post, history }) => {
    await writeFile(file, `${html}<img src="later.png">`);
    await post('/artifacts/snapshot');
    const missingVersion = (await history()).versions[0];
    await writeFile(path.join(sourceDir, 'later.png'), 'created-after-snapshot');
    await post('/versions/restore', { file, versionId: missingVersion.id });
    await assert.rejects(readFile(path.join(sourceDir, 'later.png')), { code: 'ENOENT' });
    const result = await history();
    const safety = result.versions.find((version) => version.reason === 'pre-restore');
    assert.equal(await readFile(path.join(result.archivePath, path.dirname(safety.file), 'later.png'), 'utf8'), 'created-after-snapshot');
    assert.equal(result.versions[0].isCurrent, true);
  });
});

test('navigation links are not dependencies and restore keeps later artifacts and directories', async () => {
  await fixture(async ({ directory, sourceDir, file, html, get, post, history }) => {
    await writeFile(file, `${html}<a href="report.html">Report</a><a href="docs/">Docs</a><iframe src="embedded.html"></iframe><img src="late-dir/">`);
    await post('/artifacts/snapshot');
    const baseline = (await history()).versions[0];
    assert.equal(baseline.bundle.some((entry) => entry.path === 'report.html' || entry.path === 'docs'), false);
    assert(baseline.bundle.some((entry) => entry.path === 'embedded.html' && entry.status === 'missing'));
    assert(baseline.bundle.some((entry) => entry.path === 'late-dir' && entry.status === 'missing'));
    const report = path.join(sourceDir, 'report.html');
    const embedded = path.join(sourceDir, 'embedded.html');
    await writeFile(report, '<title>Report</title>');
    await writeFile(embedded, '<title>Embedded</title>');
    await mkdir(path.join(sourceDir, 'docs'));
    await writeFile(path.join(sourceDir, 'docs/guide.txt'), 'guide');
    await mkdir(path.join(sourceDir, 'late-dir'));
    await writeFile(path.join(sourceDir, 'late-dir/image.png'), 'late');
    await writeFile(path.join(directory, 'state/state.json'), JSON.stringify({ sessions: { demo: { file }, embedded: { file: embedded } } }));
    await get('/library');
    await post('/versions/restore', { file, versionId: baseline.id });
    assert.equal(await readFile(report, 'utf8'), '<title>Report</title>');
    assert.equal(await readFile(embedded, 'utf8'), '<title>Embedded</title>');
    assert.equal(await readFile(path.join(sourceDir, 'docs/guide.txt'), 'utf8'), 'guide');
    assert.equal(await readFile(path.join(sourceDir, 'late-dir/image.png'), 'utf8'), 'late');
    const library = await get('/library');
    assert.equal(library.artifacts.find((artifact) => artifact.file === embedded)?.exists, true);
  });
});

test('SVG href subresources are dependencies whose asset-only edits create versions', async () => {
  await fixture(async ({ sourceDir, file, html, get, post, history }) => {
    await writeFile(path.join(sourceDir, 'chart.png'), 'chart-one');
    await writeFile(path.join(sourceDir, 'sprite.svg'), '<svg></svg>');
    await writeFile(file, `${html}<svg><image href="chart.png"/><use xlink:href="sprite.svg#icon"/></svg>`);
    await post('/artifacts/snapshot');
    const baseline = (await history()).versions[0];
    assert(baseline.bundle.some((entry) => entry.path === 'chart.png' && entry.status === 'file'));
    assert(baseline.bundle.some((entry) => entry.path === 'sprite.svg' && entry.status === 'file'));
    await writeFile(path.join(sourceDir, 'chart.png'), 'chart-two');
    await get('/library');
    const result = await history();
    assert.equal(result.versions.length, 2);
    assert.equal(result.versions[0].sha256, baseline.sha256);
    assert.notEqual(result.versions[0].bundleSha256, baseline.bundleSha256);
  });
});

test('restore refuses symlinked destinations without modifying external bytes', async () => {
  await fixture(async ({ directory, sourceDir, file, api, post, history }) => {
    await post('/artifacts/snapshot');
    const baseline = (await history()).versions[0];
    const externalDir = path.join(directory, 'external');
    await mkdir(externalDir);
    await writeFile(path.join(externalDir, 'logo.png'), 'external-logo');
    await rm(path.join(sourceDir, 'assets'), { recursive: true });
    await symlink(externalDir, path.join(sourceDir, 'assets'));
    const response = await fetch(`${api}/versions/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file, versionId: baseline.id }) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /symlinked asset/);
    assert.equal(await readFile(path.join(externalDir, 'logo.png'), 'utf8'), 'external-logo');
    assert.equal((await history()).versions[0].isCurrent, false);
  });
});


test('archive and restore refuse a symlinked source HTML without changing its target', async () => {
  await fixture(async ({ directory, file, api, post, history }) => {
    await post('/artifacts/snapshot');
    const baseline = (await history()).versions[0];
    const externalFile = path.join(directory, 'external.html');
    await writeFile(externalFile, '<title>External HTML</title>');
    await rm(file);
    await symlink(externalFile, file);
    for (const [route, value] of [['/artifacts/snapshot', { file }], ['/versions/restore', { file, versionId: baseline.id }]]) {
      const response = await fetch(`${api}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /symlink/);
    }
    assert.equal(await readFile(externalFile, 'utf8'), '<title>External HTML</title>');
  });
});

test('missing source history retains archived versions and restore recreates the bundle', async () => {
  await fixture(async ({ sourceDir, file, html, get, post, history }) => {
    await get('/library');
    const baseline = (await history()).versions[0];
    await rm(file);
    const library = await get('/library'); // Removes the old watcher.
    const versions = await history();
    const missing = library.artifacts.find((artifact) => artifact.file === file);
    assert.equal(missing.exists, false);
    assert.equal(missing.versionCount, 1);
    assert.equal(versions.sourceExists, false);
    assert.equal(versions.versions.length, 1);
    assert.equal(versions.versions[0].isCurrent, false);
    await rm(path.join(sourceDir, 'assets'), { recursive: true });
    await post('/versions/restore', { file, versionId: baseline.id });
    assert.equal(await readFile(file, 'utf8'), html);
    assert.equal(await readFile(path.join(sourceDir, 'assets/logo.png'), 'utf8'), 'logo-one');
    assert.equal((await history()).sourceExists, true);
    assert.equal((await history()).versions[0].isCurrent, true);
    // No library scan between restore and atomic save: restore installs watchers.
    const logo = path.join(sourceDir, 'assets/logo.png');
    await writeFile(`${logo}.tmp`, 'after-recovery');
    await rename(`${logo}.tmp`, logo);
    const changed = await waitForVersion(history, 2);
    assert.equal(changed.versions[0].reason, 'change');
    assert.equal((await get('/library')).artifacts.find((artifact) => artifact.file === file).exists, true);
  });
});

test('missing source can be restored directly without a prior library refresh', async () => {
  await fixture(async ({ file, html, post, history }) => {
    await post('/artifacts/snapshot');
    const baseline = (await history()).versions[0];
    await rm(file);
    await post('/versions/restore', { file, versionId: baseline.id });
    assert.equal(await readFile(file, 'utf8'), html);
  });
});

test('archive manifests retain discovered missing artifacts without session history', async () => {
  await fixture(async ({ directory, sourceDir, file, get, post, history }) => {
    await writeFile(path.join(directory, 'state/state.json'), JSON.stringify({ sessions: {} }));
    await writeFile(path.join(directory, 'config/config.json'), JSON.stringify({ projects: [{ path: path.dirname(sourceDir) }], archiveRoot: path.join(directory, 'archive') }));
    await get('/library');
    const baseline = (await history()).versions[0];
    await rm(file);
    const library = await get('/library');
    assert.equal(library.artifacts.find((artifact) => artifact.file === file)?.exists, false);
    assert.equal((await history()).versions.length, 1);
    await post('/versions/restore', { file, versionId: baseline.id });
    assert.equal((await get('/library')).artifacts.find((artifact) => artifact.file === file)?.exists, true);
  });
});

test('missing sources remain unavailable to open, reveal and manual snapshot', async () => {
  await fixture(async ({ file, api, post }) => {
    await post('/artifacts/snapshot');
    await rm(file);
    for (const route of ['/artifacts/open', '/artifacts/reveal', '/artifacts/snapshot', '/versions/open']) {
      const response = await fetch(`${api}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file, versionId: 'unused' }) });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /no longer exists/);
    }
  });
});

test('recovery refuses missing directories, source symlinks and non-file destinations', async () => {
  await fixture(async ({ directory, sourceDir, file, api, post, history }) => {
    await post('/artifacts/snapshot');
    const baseline = (await history()).versions[0];
    const restore = async () => {
      const response = await fetch(`${api}/versions/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file, versionId: baseline.id }) });
      assert.equal(response.status, 400);
      return (await response.json()).error;
    };
    await rm(file);
    await mkdir(file);
    assert.match(await restore(), /non-file/);
    await rm(sourceDir, { recursive: true });
    assert.match(await restore(), /ENOENT|source directory/);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
    const externalDir = path.join(directory, 'external-source');
    await mkdir(externalDir);
    await symlink(externalDir, sourceDir);
    assert.match(await restore(), /symlinked source directory/);
    await assert.rejects(readFile(path.join(externalDir, path.basename(file))), { code: 'ENOENT' });
  });
});

test('recovery refuses unknown paths and mismatched manifests without creating files', async () => {
  await fixture(async ({ directory, sourceDir, file, api, get, post, history }) => {
    await post('/artifacts/snapshot');
    const baselineHistory = await history();
    const baseline = baselineHistory.versions[0];
    await rm(file);
    const unknownPaths = [path.join(sourceDir, 'unknown.html'), path.join(directory, 'outside.html')];
    for (const unknown of unknownPaths) {
      assert.equal((await fetch(`${api}/artifacts/versions?file=${encodeURIComponent(unknown)}`)).status, 400);
      const response = await fetch(`${api}/versions/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: unknown, versionId: baseline.id }) });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /not a known Lavish artifact/);
      await assert.rejects(readFile(unknown), { code: 'ENOENT' });
    }
    const manifestFile = path.join(baselineHistory.archivePath, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    manifest.sourceFile = unknownPaths[1];
    await writeFile(manifestFile, JSON.stringify(manifest));
    await get('/library');
    assert.equal((await fetch(`${api}/artifacts/versions?file=${encodeURIComponent(file)}`)).status, 400);
    assert.equal((await fetch(`${api}/artifacts/versions?file=${encodeURIComponent(unknownPaths[1])}`)).status, 400);
    const response = await fetch(`${api}/versions/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file, versionId: baseline.id }) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /manifest does not match/);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  });
});

test('missing-source recovery keeps archive and asset paths within their folders', async () => {
  await fixture(async ({ directory, file, api, post, history }) => {
    await post('/artifacts/snapshot');
    const baselineHistory = await history();
    const manifestFile = path.join(baselineHistory.archivePath, 'manifest.json');
    const original = JSON.parse(await readFile(manifestFile, 'utf8'));
    await rm(file);
    const outside = path.join(directory, 'outside.html');
    await writeFile(outside, '<title>Keep outside bytes</title>');
    for (const change of [
      (version) => { version.file = outside; },
      (version) => { version.bundle.push({ path: '../escaped.txt', status: 'file' }); },
    ]) {
      const manifest = structuredClone(original);
      change(manifest.versions[0]);
      await writeFile(manifestFile, JSON.stringify(manifest));
      const response = await fetch(`${api}/versions/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file, versionId: manifest.versions[0].id }) });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /archived copy|archived asset path/);
      assert.equal(await readFile(outside, 'utf8'), '<title>Keep outside bytes</title>');
      await assert.rejects(readFile(file), { code: 'ENOENT' });
    }
  });
});

for (const change of ['pause', 'switch']) {
  test(`restore finishes in its original archive when settings ${change} after source writes begin`, { timeout: 15_000 }, async () => {
    await fixture(async ({ directory, sourceDir, file, html, api, post, history, publicationPaused, resumePublication }) => {
      await post('/artifacts/snapshot');
      const baseline = (await history()).versions[0];
      await writeFile(file, '<title>New content before restore</title>');
      await writeFile(path.join(sourceDir, 'assets/logo.png'), 'new-logo');
      const pending = fetch(`${api}/versions/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file, versionId: baseline.id }) });
      assert.equal((await publicationPaused)[0], 'restore-write-paused');
      if (change === 'pause') await post('/archive/disable', {});
      else await writeFile(path.join(directory, 'config/config.json'), JSON.stringify({ projects: [], archiveRoot: path.join(directory, 'archive-next') }));
      resumePublication();
      const response = await pending;
      assert.equal(response.status, 200, JSON.stringify(await response.json()));
      assert.equal(await readFile(file, 'utf8'), html);
      assert.equal(await readFile(path.join(sourceDir, 'assets/logo.png'), 'utf8'), 'logo-one');
      const archivePath = path.join(directory, 'archive', 'Lavish Library Archive', 'project');
      const [artifactDir] = await readdir(archivePath);
      const manifest = JSON.parse(await readFile(path.join(archivePath, artifactDir, 'manifest.json'), 'utf8'));
      assert.deepEqual(manifest.versions.map((version) => version.reason), ['manual', 'pre-restore', 'restore']);
      await writeFile(path.join(sourceDir, 'assets/logo.png'), 'after-restore');
      await new Promise((resolve) => setTimeout(resolve, 1100));
      assert.equal(JSON.parse(await readFile(path.join(archivePath, artifactDir, 'manifest.json'), 'utf8')).versions.length, 3);
    }, { pauseRestoreWrite: true });
  });
}

test('history avoids reading archived HTML for snapshots with stored revision metadata', async () => {
  await fixture(async ({ file, post, history, archiveReads }) => {
    for (let i = 0; i < 3; i += 1) {
      await writeFile(file, `<title>Large version ${i}</title>` + 'x'.repeat(1_000_000));
      await post('/artifacts/snapshot');
    }
    assert.equal((await history()).versions.length, 3);
    await history();
    assert.equal((await archiveReads()).length, 0);
  }, { trackArchiveReads: true });
});

test('legacy history caches revision declarations including absent registries', async () => {
  await fixture(async ({ post, history, archiveReads }) => {
    await post('/artifacts/snapshot');
    const first = await history();
    const manifestFile = path.join(first.archivePath, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    delete manifest.versions[0].revisionContext;
    await writeFile(manifestFile, JSON.stringify(manifest));
    const before = (await archiveReads()).length;
    assert.deepEqual((await history()).versions[0].revisionContext, []);
    assert.deepEqual((await history()).versions[0].revisionContext, []);
    assert.equal((await archiveReads()).length - before, 1);
    await writeFile(path.join(first.archivePath, first.versions[0].file), '<script data-lavish-revisions>[{"id":"changed"}]</script>');
    assert.equal((await history()).versions[0].revisionContext[0].id, 'changed');
    assert.equal((await archiveReads()).length - before, 2);
  }, { trackArchiveReads: true });
});

test('legacy history larger than the cache preserves hits across repeated opens', async () => {
  await fixture(async ({ post, history, archiveReads, html }) => {
    await post('/artifacts/snapshot');
    const first = await history();
    const manifestFile = path.join(first.archivePath, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    const baseline = manifest.versions[0];
    const baselineDirectory = path.join(first.archivePath, path.dirname(baseline.file));
    manifest.versions = [];
    for (let index = 0; index < 260; index += 1) {
      const id = `legacy-${index}`;
      const version = structuredClone(baseline);
      version.id = id;
      version.file = `versions/${id}/plan.html`;
      delete version.revisionContext;
      const context = index % 2 === 0 ? [{ id }] : [];
      const bytes = html + (context.length ? `<script data-lavish-revisions>${JSON.stringify(context)}</script>` : '');
      await cp(baselineDirectory, path.join(first.archivePath, 'versions', id), { recursive: true });
      await writeFile(path.join(first.archivePath, version.file), bytes);
      version.sha256 = createHash('sha256').update(bytes).digest('hex');
      version.bundle.find((entry) => entry.path === 'plan.html').sha256 = version.sha256;
      version.bundleSha256 = createHash('sha256').update(JSON.stringify(version.bundle)).digest('hex');
      version.size = Buffer.byteLength(bytes);
      manifest.versions.push(version);
    }
    await writeFile(manifestFile, JSON.stringify(manifest));
    let reads = (await archiveReads()).length;
    for (let open = 0; open < 4; open += 1) {
      const result = await history();
      assert.equal(result.versions.length, 260);
      for (const version of result.versions) {
        const index = Number(version.id.slice('legacy-'.length));
        assert.deepEqual(version.revisionContext.map((entry) => entry.id), index % 2 === 0 ? [version.id] : []);
      }
      const nextReads = (await archiveReads()).length;
      if (open === 0) assert.equal(nextReads - reads, 260);
      else assert.ok(nextReads - reads <= 4, `Reopening reread ${nextReads - reads} archived HTML files`);
      reads = nextReads;
    }
  }, { trackArchiveReads: true });
});
