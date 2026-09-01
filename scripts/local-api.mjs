import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, watch } from 'node:fs';
import { access, copyFile, cp, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.LAVISH_TRACKER_API_PORT || 4318);
const HOST = '127.0.0.1';
const STATE_FILE = process.env.LAVISH_AXI_STATE_DIR
  ? path.join(process.env.LAVISH_AXI_STATE_DIR, 'state.json')
  : path.join(os.homedir(), '.lavish-axi', 'state.json');
const CONFIG_DIR = path.join(os.homedir(), '.lavish-tracker');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const LAVISH_BIN = process.env.LAVISH_AXI_BIN || '/opt/homebrew/bin/lavish-axi';
const ARCHIVE_NAME = 'Lavish Library Archive';
const artifactWatchers = new Map();
const snapshotQueues = new Map();

const idFor = (value) => createHash('sha1').update(value).digest('hex').slice(0, 12);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const exists = async (value) => access(value, constants.F_OK).then(() => true).catch(() => false);
const slug = (value) => String(value || 'untitled').normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 70) || 'untitled';

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

async function readConfig() {
  const config = await readJson(CONFIG_FILE, { projects: [], archiveRoot: null });
  return {
    projects: Array.isArray(config.projects) ? config.projects : [],
    archiveRoot: typeof config.archiveRoot === 'string' && config.archiveRoot.trim() ? path.resolve(config.archiveRoot) : null,
  };
}

async function saveConfig(config) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeJson(CONFIG_FILE, config);
}

function archiveHome(config) {
  return config.archiveRoot ? path.join(config.archiveRoot, ARCHIVE_NAME) : null;
}

function projectRootFor(file) {
  const marker = `${path.sep}.lavish${path.sep}`;
  const index = file.lastIndexOf(marker);
  return index >= 0 ? file.slice(0, index) : null;
}

function projectNameFor(file) {
  const root = projectRootFor(file);
  return root ? path.basename(root) : 'Loose & temporary';
}

async function findLavishDirs(root, depth = 0) {
  if (path.basename(root) === '.lavish') return [root];
  if (depth > 3) return [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const direct = entries.find((entry) => entry.isDirectory() && entry.name === '.lavish');
  const found = direct ? [path.join(root, direct.name)] : [];
  if (direct || depth === 3) return found;
  const children = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !['node_modules', 'dist', 'build', 'vendor'].includes(entry.name));
  for (const child of children.slice(0, 80)) found.push(...await findLavishDirs(path.join(root, child.name), depth + 1));
  return found;
}

async function htmlFiles(root, depth = 0) {
  if (depth > 5) return [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const files = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory() && !['assets', 'node_modules'].includes(entry.name)) files.push(...await htmlFiles(full, depth + 1));
    if (entry.isFile() && /\.html?$/i.test(entry.name) && !/-portable\.html$/i.test(entry.name)) files.push(full);
  }
  return files;
}

function cleanText(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

function metadataFromHtml(html) {
  const searchable = html.slice(0, 300_000);
  const title = cleanText(searchable.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || searchable.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]);
  const description = cleanText(searchable.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1] || searchable.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1]);
  return { title, description: description.slice(0, 180) };
}

async function htmlMetadata(file) {
  try { return metadataFromHtml(await readFile(file, 'utf8')); } catch { return { title: '', description: '' }; }
}

async function serverRunning() {
  try {
    const response = await fetch('http://127.0.0.1:4387/health', { signal: AbortSignal.timeout(650) });
    const value = await response.json();
    return response.ok && value.app === 'lavish-axi';
  } catch { return false; }
}

function artifactArchiveDir(config, artifact) {
  return path.join(archiveHome(config), slug(projectNameFor(artifact.file)), `${slug(path.basename(artifact.file, path.extname(artifact.file)))}--${artifact.id}`);
}

function manifestPath(config, artifact) {
  return path.join(artifactArchiveDir(config, artifact), 'manifest.json');
}

function localAssetReferences(html) {
  const references = new Set();
  for (const match of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) references.add(match[1]);
  for (const match of html.matchAll(/srcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const item of match[1].split(',')) references.add(item.trim().split(/\s+/)[0]);
  }
  for (const match of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) references.add(match[1]);
  return [...references];
}

function safeLocalReference(reference) {
  if (!reference || reference.startsWith('/') || reference.startsWith('//') || reference.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(reference)) return null;
  const clean = reference.split(/[?#]/)[0];
  try { return decodeURIComponent(clean); } catch { return clean; }
}

async function copyLocalAssets(html, sourceFile, versionDir) {
  const sourceDir = path.dirname(sourceFile);
  const queue = localAssetReferences(html).map((reference) => ({ reference, baseDir: sourceDir }));
  const visited = new Set();
  let copied = 0;
  while (queue.length) {
    const { reference, baseDir } = queue.shift();
    const local = safeLocalReference(reference);
    if (!local) continue;
    const source = path.resolve(baseDir, local);
    const relative = path.relative(sourceDir, source);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || visited.has(source) || !(await exists(source))) continue;
    visited.add(source);
    const destination = path.resolve(versionDir, relative);
    if (path.relative(versionDir, destination).startsWith('..')) continue;
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, force: true });
    copied += 1;
    if (path.extname(source).toLowerCase() === '.css') {
      const css = await readFile(source, 'utf8').catch(() => '');
      queue.push(...localAssetReferences(css).map((cssReference) => ({ reference: cssReference, baseDir: path.dirname(source) })));
    }
  }
  return copied;
}

async function readManifest(config, artifact) {
  return readJson(manifestPath(config, artifact), {
    schemaVersion: 1,
    artifactId: artifact.id,
    sourceFile: artifact.file,
    title: artifact.title,
    projectName: artifact.projectName,
    versions: [],
  });
}

async function snapshotArtifactNow(config, artifact, reason = 'scan') {
  if (!config.archiveRoot || !artifact.exists) return null;
  const html = await readFile(artifact.file, 'utf8');
  const contentSha = sha256(html);
  const manifest = await readManifest(config, artifact);
  const latest = manifest.versions.at(-1);
  if (latest?.sha256 === contentSha) return manifest;

  const sourceStat = await stat(artifact.file);
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[:.]/g, '-');
  const versionId = `${stamp}-${contentSha.slice(0, 12)}`;
  const versionDir = path.join(artifactArchiveDir(config, artifact), 'versions', versionId);
  const archivedFile = path.join(versionDir, path.basename(artifact.file));
  await mkdir(versionDir, { recursive: true });
  await writeFile(archivedFile, html);
  const assetsCopied = await copyLocalAssets(html, artifact.file, versionDir);

  manifest.sourceFile = artifact.file;
  manifest.title = artifact.title;
  manifest.projectName = artifact.projectName;
  manifest.versions.push({
    id: versionId,
    createdAt,
    sourceModifiedAt: sourceStat.mtime.toISOString(),
    sha256: contentSha,
    size: Buffer.byteLength(html),
    lineCount: html.split(/\r?\n/).length,
    assetsCopied,
    reason,
    file: path.relative(artifactArchiveDir(config, artifact), archivedFile),
  });
  await writeJson(manifestPath(config, artifact), manifest);
  return manifest;
}

function snapshotArtifact(config, artifact, reason = 'scan') {
  const previous = snapshotQueues.get(artifact.id) || Promise.resolve();
  const next = previous.then(() => snapshotArtifactNow(config, artifact, reason));
  snapshotQueues.set(artifact.id, next.catch(() => {}));
  return next;
}

function closeArtifactWatchers() {
  for (const entry of artifactWatchers.values()) {
    clearTimeout(entry.timer);
    entry.watcher.close();
  }
  artifactWatchers.clear();
}

function syncArtifactWatchers(config, artifacts) {
  if (!config.archiveRoot) return closeArtifactWatchers();
  const targets = new Set(artifacts.filter((artifact) => artifact.exists).map((artifact) => artifact.file));
  for (const [file, entry] of artifactWatchers) {
    if (!targets.has(file) || entry.archiveRoot !== config.archiveRoot) {
      clearTimeout(entry.timer);
      entry.watcher.close();
      artifactWatchers.delete(file);
    }
  }
  for (const artifact of artifacts) {
    if (!artifact.exists || artifactWatchers.has(artifact.file)) continue;
    try {
      const entry = { watcher: null, timer: null, archiveRoot: config.archiveRoot };
      entry.watcher = watch(artifact.file, { persistent: false }, () => {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => snapshotArtifact(config, artifact, 'change').catch(() => {}), 700);
      });
      entry.watcher.on('error', () => {
        entry.watcher.close();
        artifactWatchers.delete(artifact.file);
      });
      artifactWatchers.set(artifact.file, entry);
    } catch { /* A periodic scan will retry files that cannot be watched. */ }
  }
}

async function buildLibrary() {
  const [state, config, running] = await Promise.all([
    readJson(STATE_FILE, { sessions: {} }),
    readConfig(),
    serverRunning(),
  ]);
  const sessions = Object.values(state.sessions || {});
  const projectMap = new Map();

  for (const item of config.projects) {
    const normalized = path.resolve(item.path);
    projectMap.set(normalized, { id: idFor(normalized), name: item.name || path.basename(normalized), path: normalized, source: 'added', exists: await exists(normalized) });
  }
  for (const session of sessions) {
    const root = projectRootFor(session.file);
    if (root && !projectMap.has(root)) projectMap.set(root, { id: idFor(root), name: path.basename(root), path: root, source: 'automatic', exists: await exists(root) });
  }

  const projectFiles = new Map();
  for (const project of projectMap.values()) {
    const dirs = await findLavishDirs(project.path);
    const files = new Set();
    for (const dir of dirs) for (const file of await htmlFiles(dir)) files.add(file);
    projectFiles.set(project.path, files);
  }

  const looseProject = { id: 'loose', name: 'Loose & temporary', path: 'Known centrally by Lavish', source: 'automatic', exists: true };
  const artifactPaths = new Set(sessions.map((session) => session.file));
  for (const files of projectFiles.values()) for (const file of files) artifactPaths.add(file);
  const sessionByFile = new Map(sessions.map((session) => [path.resolve(session.file), session]));
  const artifacts = [];
  let hasLoose = false;

  for (const fileValue of artifactPaths) {
    const file = path.resolve(fileValue);
    const session = sessionByFile.get(file);
    const root = projectRootFor(file);
    let project = root ? projectMap.get(root) : null;
    if (!project) project = [...projectMap.values()].find((candidate) => file.startsWith(`${candidate.path}${path.sep}`));
    if (!project) { project = looseProject; hasLoose = true; }
    const fileExists = await exists(file);
    const fileStat = fileExists ? await stat(file) : null;
    const metadata = fileExists ? await htmlMetadata(file) : { title: '', description: '' };
    const fallbackTitle = path.basename(file).replace(/\.html?$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
    const chatDates = Array.isArray(session?.chat) ? session.chat.map((item) => item.at).filter(Boolean) : [];
    const lastUsedAt = [session?.updated_at, ...chatDates].filter(Boolean).sort().at(-1) || null;
    artifacts.push({
      id: idFor(file), projectId: project.id, projectName: project.name,
      title: metadata.title || fallbackTitle, description: metadata.description, file,
      relativePath: project === looseProject ? file : path.relative(project.path, file),
      modifiedAt: fileStat?.mtime?.toISOString() || null, lastUsedAt, size: fileStat?.size || 0, exists: fileExists,
      sessionStatus: session?.status || 'discovered', pendingPrompts: Number(session?.pending_prompts || 0),
      url: session?.url || null, endedBy: session?.ended_by || null,
      versionCount: 0, lastBackedUpAt: null, backupError: null,
    });
  }

  let totalVersions = 0;
  let protectedArtifacts = 0;
  if (config.archiveRoot) {
    for (const artifact of artifacts) {
      if (!artifact.exists) continue;
      try {
        const manifest = await snapshotArtifact(config, artifact, 'scan');
        artifact.versionCount = manifest?.versions.length || 0;
        artifact.lastBackedUpAt = manifest?.versions.at(-1)?.createdAt || null;
        totalVersions += artifact.versionCount;
        if (artifact.versionCount > 0) protectedArtifacts += 1;
      } catch (error) {
        artifact.backupError = error instanceof Error ? error.message : 'Backup failed';
      }
    }
  }
  syncArtifactWatchers(config, artifacts);

  const projects = [...projectMap.values(), ...(hasLoose ? [looseProject] : [])].map((project) => ({
    ...project,
    artifactCount: artifacts.filter((artifact) => artifact.projectId === project.id).length,
  })).filter((project) => project.artifactCount > 0 || project.source === 'added');

  return {
    projects,
    artifacts,
    server: { running, url: 'http://127.0.0.1:4387' },
    archive: {
      enabled: Boolean(config.archiveRoot),
      root: config.archiveRoot,
      path: archiveHome(config),
      totalVersions,
      protectedArtifacts,
    },
    scannedAt: new Date().toISOString(),
  };
}

async function artifactForFile(file) {
  const resolved = path.resolve(String(file || ''));
  if (!/\.html?$/i.test(resolved) || !(await exists(resolved))) throw new Error('That Lavish file no longer exists.');
  const html = await readFile(resolved, 'utf8');
  const metadata = metadataFromHtml(html);
  const fallbackTitle = path.basename(resolved).replace(/\.html?$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  return { id: idFor(resolved), file: resolved, exists: true, title: metadata.title || fallbackTitle, projectName: projectNameFor(resolved) };
}

async function versionsFor(file) {
  const config = await readConfig();
  if (!config.archiveRoot) return { enabled: false, versions: [] };
  const artifact = await artifactForFile(file);
  const manifest = await readManifest(config, artifact);
  const currentHtml = await readFile(artifact.file, 'utf8');
  const currentSha = sha256(currentHtml);
  const currentVersionIndex = manifest.versions.findLastIndex((version) => version.sha256 === currentSha);
  const versions = manifest.versions.map((version, index) => {
    const previous = manifest.versions[index - 1];
    return {
      ...version,
      isCurrent: index === currentVersionIndex,
      sizeDelta: previous ? version.size - previous.size : 0,
      lineDelta: previous ? version.lineCount - previous.lineCount : 0,
    };
  }).reverse();
  return { enabled: true, archivePath: artifactArchiveDir(config, artifact), sourceFile: artifact.file, versions };
}

async function resolveVersion(file, versionId) {
  const config = await readConfig();
  if (!config.archiveRoot) throw new Error('Choose an archive folder first.');
  const artifact = await artifactForFile(file);
  const manifest = await readManifest(config, artifact);
  if (path.resolve(manifest.sourceFile) !== artifact.file) throw new Error('Archive manifest does not match this artifact.');
  const version = manifest.versions.find((item) => item.id === versionId);
  if (!version) throw new Error('That archived version could not be found.');
  const artifactDir = artifactArchiveDir(config, artifact);
  const archivedFile = path.resolve(artifactDir, version.file);
  const relative = path.relative(artifactDir, archivedFile);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !(await exists(archivedFile))) throw new Error('That archived copy is missing.');
  return { config, artifact, version, archivedFile };
}

async function restoreVersion(file, versionId) {
  const resolved = await resolveVersion(file, versionId);
  await snapshotArtifact(resolved.config, resolved.artifact, 'pre-restore');
  const versionDir = path.dirname(resolved.archivedFile);
  const sourceDir = path.dirname(resolved.artifact.file);
  const entries = await readdir(versionDir, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(versionDir, entry.name);
    const destination = path.join(sourceDir, entry.name);
    if (path.resolve(source) === path.resolve(resolved.archivedFile)) await copyFile(source, resolved.artifact.file);
    else await cp(source, destination, { recursive: true, force: true });
  }
  await snapshotArtifact(resolved.config, resolved.artifact, 'restore');
  return resolved;
}

function json(res, status, value, origin = '') {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) headers['access-control-allow-origin'] = origin;
  res.writeHead(status, headers);
  res.end(JSON.stringify(value));
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw new Error('Request is too large.');
  }
  return raw ? JSON.parse(raw) : {};
}

async function addProject(folder) {
  const resolved = path.resolve(String(folder || '').trim());
  const folderStat = await stat(resolved).catch(() => null);
  if (!folderStat?.isDirectory()) throw new Error('Choose an existing folder.');
  const config = await readConfig();
  if (!config.projects.some((item) => path.resolve(item.path) === resolved)) config.projects.push({ path: resolved, name: path.basename(resolved) });
  await saveConfig(config);
  return resolved;
}

function chooseFolder(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-e', `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`]);
    let output = '';
    let errorOutput = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { errorOutput += chunk; });
    child.on('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(errorOutput.includes('User canceled') ? 'Folder selection cancelled.' : errorOutput.trim())));
  });
}

const server = createServer(async (req, res) => {
  const origin = String(req.headers.origin || '');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' });
    return res.end();
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/api/library') return json(res, 200, await buildLibrary(), origin);
    if (req.method === 'GET' && url.pathname === '/api/artifacts/versions') return json(res, 200, await versionsFor(url.searchParams.get('file')), origin);
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, app: 'lavish-tracker' }, origin);
    if (req.method === 'POST' && url.pathname === '/api/projects') {
      const input = await body(req);
      return json(res, 201, { ok: true, path: await addProject(input.path) }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/projects/choose') {
      const chosen = await chooseFolder('Choose a project to watch for Lavishes');
      return json(res, 201, { ok: true, path: await addProject(chosen.replace(/\/$/, '')) }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/archive/choose') {
      const chosen = await chooseFolder('Choose where Lavish Library should keep its archive');
      const selected = path.resolve(chosen.replace(/\/$/, ''));
      const config = await readConfig();
      config.archiveRoot = selected;
      await saveConfig(config);
      return json(res, 201, { ok: true, root: selected, path: archiveHome(config) }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/archive/disable') {
      const config = await readConfig();
      config.archiveRoot = null;
      await saveConfig(config);
      closeArtifactWatchers();
      return json(res, 200, { ok: true }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/archive/reveal') {
      const config = await readConfig();
      const folder = archiveHome(config);
      if (!folder || !(await exists(folder))) throw new Error('No archive folder has been created yet.');
      spawn('/usr/bin/open', [folder], { detached: true, stdio: 'ignore' }).unref();
      return json(res, 202, { ok: true }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/artifacts/snapshot') {
      const input = await body(req);
      const config = await readConfig();
      if (!config.archiveRoot) throw new Error('Choose an archive folder first.');
      const artifact = await artifactForFile(input.file);
      const manifest = await snapshotArtifact(config, artifact, 'manual');
      return json(res, 201, { ok: true, versionCount: manifest?.versions.length || 0 }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/artifacts/open') {
      const input = await body(req);
      const artifact = await artifactForFile(input.file);
      const args = [artifact.file];
      if (input.reopen) args.push('--reopen');
      spawn(LAVISH_BIN, args, { detached: true, stdio: 'ignore' }).unref();
      return json(res, 202, { ok: true }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/artifacts/reveal') {
      const input = await body(req);
      const artifact = await artifactForFile(input.file);
      spawn('/usr/bin/open', ['-R', artifact.file], { detached: true, stdio: 'ignore' }).unref();
      return json(res, 202, { ok: true }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/versions/open') {
      const input = await body(req);
      const resolved = await resolveVersion(input.file, input.versionId);
      spawn('/usr/bin/open', [resolved.archivedFile], { detached: true, stdio: 'ignore' }).unref();
      return json(res, 202, { ok: true }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/versions/restore') {
      const input = await body(req);
      const restored = await restoreVersion(input.file, input.versionId);
      return json(res, 200, { ok: true, restoredAt: new Date().toISOString(), versionId: restored.version.id }, origin);
    }
    return json(res, 404, { error: 'Not found.' }, origin);
  } catch (error) {
    return json(res, 400, { error: error instanceof Error ? error.message : 'Request failed.' }, origin);
  }
});

const periodicScan = setInterval(() => buildLibrary().catch(() => {}), 30_000);
periodicScan.unref();
server.listen(PORT, HOST, () => console.log(`Lavish Tracker library service: http://${HOST}:${PORT}`));
