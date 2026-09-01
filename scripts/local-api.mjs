import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, watch } from 'node:fs';
import { access, copyFile, cp, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.LAVISH_TRACKER_API_PORT || 4318);
const requestedUiPort = Number(process.env.LAVISH_TRACKER_UI_PORT || 3000);
const UI_PORT = Number.isInteger(requestedUiPort) && requestedUiPort > 0 && requestedUiPort <= 65_535
  ? requestedUiPort
  : 3000;
const HOST = '127.0.0.1';
const STATE_FILE = process.env.LAVISH_AXI_STATE_DIR
  ? path.join(process.env.LAVISH_AXI_STATE_DIR, 'state.json')
  : path.join(os.homedir(), '.lavish-axi', 'state.json');
const CONFIG_DIR = process.env.LAVISH_TRACKER_CONFIG_DIR
  ? path.resolve(process.env.LAVISH_TRACKER_CONFIG_DIR)
  : path.join(os.homedir(), '.lavish-tracker');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const ANALYTICS_FILE = path.join(CONFIG_DIR, 'analytics.json');
const LAVISH_BIN = process.env.LAVISH_AXI_BIN || '/opt/homebrew/bin/lavish-axi';
const ARCHIVE_NAME = 'Lavish Library Archive';
const API_TOKEN = randomBytes(32).toString('base64url');
const artifactWatchers = new Map();
const snapshotQueues = new Map();
let analyticsQueue = Promise.resolve();
let gitCache = { at: 0, value: [] };
let knownArtifactsCache = { key: '', at: 0, value: null, pending: null };

const idFor = (value) => createHash('sha1').update(value).digest('hex').slice(0, 12);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const exists = async (value) => access(value, constants.F_OK).then(() => true).catch(() => false);
const slug = (value) => String(value || 'untitled').normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 70) || 'untitled';
const ALLOWED_WEB_ORIGINS = new Set([
  `http://localhost:${UI_PORT}`,
  `http://127.0.0.1:${UI_PORT}`,
]);

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

function analyticsDefaults() {
  return {
    schemaVersion: 1,
    events: [],
    feedback: {},
    recommendationState: {},
    settings: {
      cadence: 'tunable',
      manual: true,
      weekly: true,
      monthly: true,
      contextual: true,
      foregroundTime: false,
    },
  };
}

async function readAnalytics() {
  const fallback = analyticsDefaults();
  const value = await readJson(ANALYTICS_FILE, fallback);
  return {
    ...fallback,
    ...value,
    events: Array.isArray(value.events) ? value.events : [],
    feedback: value.feedback && typeof value.feedback === 'object' ? value.feedback : {},
    recommendationState: value.recommendationState && typeof value.recommendationState === 'object' ? value.recommendationState : {},
    settings: { ...fallback.settings, ...(value.settings || {}), foregroundTime: false },
  };
}

function updateAnalytics(mutator) {
  analyticsQueue = analyticsQueue.catch(() => {}).then(async () => {
    const analytics = await readAnalytics();
    const result = await mutator(analytics);
    analytics.events = analytics.events.slice(-10_000);
    await writeJson(ANALYTICS_FILE, analytics);
    return result;
  });
  return analyticsQueue;
}

function cleanEventValue(value, max = 240) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

async function recordEvent(type, details = {}) {
  const allowed = new Set(['search', 'open', 'reveal', 'snapshot', 'version_open', 'restore', 'project_view', 'insights_open', 'review_open', 'feedback', 'recommendation']);
  if (!allowed.has(type)) throw new Error('Unknown analytics event.');
  const at = new Date().toISOString();
  const event = {
    id: idFor(`${at}:${type}:${Math.random()}`),
    at,
    type,
    artifactId: cleanEventValue(details.artifactId, 40) || null,
    projectId: cleanEventValue(details.projectId, 40) || null,
    query: cleanEventValue(details.query, 160) || null,
    resultCount: Number.isFinite(details.resultCount) ? Math.max(0, Math.round(details.resultCount)) : null,
    label: cleanEventValue(details.label, 120) || null,
    detail: cleanEventValue(details.detail, 300) || null,
  };
  await updateAnalytics((analytics) => { analytics.events.push(event); });
  return event;
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

async function fileCacheKey(file) {
  try {
    const details = await stat(file);
    return `${details.mtimeMs}:${details.size}`;
  } catch {
    return 'missing';
  }
}

async function scanKnownArtifacts(options = {}) {
  const force = Boolean(options.force);
  const [stateKey, configKey] = await Promise.all([fileCacheKey(STATE_FILE), fileCacheKey(CONFIG_FILE)]);
  const cacheKey = `${stateKey}|${configKey}`;
  if (!force && knownArtifactsCache.value && knownArtifactsCache.key === cacheKey) {
    return knownArtifactsCache.value;
  }
  if (!force && knownArtifactsCache.pending && knownArtifactsCache.key === cacheKey) return knownArtifactsCache.pending;

  knownArtifactsCache.key = cacheKey;
  knownArtifactsCache.pending = (async () => {
    const [state, config] = await Promise.all([
      readJson(STATE_FILE, { sessions: {} }),
      readConfig(),
    ]);
    const sessions = Object.values(state.sessions || {});
    const projectMap = new Map();

    for (const item of config.projects) {
      const normalized = path.resolve(item.path);
      projectMap.set(normalized, { id: idFor(normalized), name: item.name || path.basename(normalized), path: normalized, source: 'added' });
    }
    for (const session of sessions) {
      const root = projectRootFor(session.file);
      if (root && !projectMap.has(root)) projectMap.set(root, { id: idFor(root), name: path.basename(root), path: root, source: 'automatic' });
    }

    const projectFiles = new Map();
    for (const project of projectMap.values()) {
      const dirs = await findLavishDirs(project.path);
      const files = new Set();
      for (const dir of dirs) for (const file of await htmlFiles(dir)) files.add(path.resolve(file));
      projectFiles.set(project.path, files);
    }

    const artifactPaths = new Set(sessions.map((session) => path.resolve(session.file)));
    for (const files of projectFiles.values()) for (const file of files) artifactPaths.add(file);
    return { sessions, projectMap, projectFiles, artifactPaths };
  })();

  try {
    const value = await knownArtifactsCache.pending;
    knownArtifactsCache = { key: cacheKey, at: Date.now(), value, pending: null };
    return value;
  } catch (error) {
    knownArtifactsCache = { key: '', at: 0, value: null, pending: null };
    throw error;
  }
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
  const [knownArtifacts, config, running] = await Promise.all([
    scanKnownArtifacts({ force: true }),
    readConfig(),
    serverRunning(),
  ]);
  const sessions = knownArtifacts.sessions;
  const projectMap = new Map(await Promise.all(
    [...knownArtifacts.projectMap.values()].map(async (project) => [project.path, { ...project, exists: await exists(project.path) }]),
  ));

  const looseProject = { id: 'loose', name: 'Loose & temporary', path: 'Known centrally by Lavish', source: 'automatic', exists: true };
  const artifactPaths = new Set(knownArtifacts.artifactPaths);
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
      sessionMessages: Array.isArray(session?.chat) ? session.chat.length : 0,
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

async function knownProjectMap() {
  const { projectMap, sessions, artifactPaths } = await scanKnownArtifacts();
  return { projectMap, sessions, artifactPaths };
}

function projectForFile(file, projectMap) {
  const root = projectRootFor(file);
  if (root && projectMap.has(root)) return projectMap.get(root);
  return [...projectMap.values()].find((candidate) => file.startsWith(`${candidate.path}${path.sep}`)) || null;
}

async function artifactForFile(file) {
  const resolved = path.resolve(String(file || ''));
  if (!/\.html?$/i.test(resolved) || !(await exists(resolved))) throw new Error('That Lavish file no longer exists.');
  const fileStat = await stat(resolved).catch(() => null);
  if (!fileStat?.isFile()) throw new Error('That Lavish file no longer exists.');
  const { projectMap, sessions, artifactPaths } = await knownProjectMap();
  const session = sessions.find((candidate) => path.resolve(candidate.file || '') === resolved) || null;
  const project = projectForFile(resolved, projectMap);
  if (!artifactPaths.has(resolved)) throw new Error('That file is not a known Lavish artifact.');
  const metadata = await htmlMetadata(resolved);
  const fallbackTitle = path.basename(resolved).replace(/\.html?$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  return {
    id: idFor(resolved),
    file: resolved,
    exists: true,
    title: metadata.title || fallbackTitle,
    description: metadata.description,
    projectId: project?.id || 'loose',
    projectName: project?.name || 'Loose & temporary',
    relativePath: project ? path.relative(project.path, resolved) : resolved,
    sessionStatus: session?.status || 'discovered',
    pendingPrompts: Number(session?.pending_prompts || 0),
    url: session?.url || null,
    endedBy: session?.ended_by || null,
    sessionMessages: Array.isArray(session?.chat) ? session.chat.length : 0,
  };
}

async function versionsFor(file) {
  const artifact = await artifactForFile(file);
  const config = await readConfig();
  if (!config.archiveRoot) return { enabled: false, versions: [] };
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

const PURPOSES = [
  ['Implementation plan', /\b(implementation|rollout|delivery|deployment|migration|plan)\b/i],
  ['Architecture review', /\b(architecture|design|topology|infrastructure)\b/i],
  ['Assessment', /\b(assessment|readiness|reconciliation|audit|diagnostic|analysis)\b/i],
  ['Runbook or guide', /\b(runbook|guide|procedure|playbook|how[- ]?to)\b/i],
  ['Comparison', /\b(comparison|versus|\bvs\b|options|tradeoffs?)\b/i],
  ['Status update', /\b(status|update|brief|summary|report|dashboard)\b/i],
  ['Retrospective', /\b(retrospective|postmortem|lessons?|outcomes?|what happened)\b/i],
  ['Proposal', /\b(proposal|strategy|recommendation|decision)\b/i],
];

const STOPWORDS = new Set('a an and are as at be been by can codex could do for from has have html how in into is it lavish library local more of on only or our out page project read should site some than that the their this to tool use using was we what when where which who will with you your analysis architecture assessment audit august april comparison content current dashboard december deployment design diagnostic february feedback guide implementation january july june live march may migration november october options plan playbook private procedure proposal readiness reconciliation report review rollout runbook september status strategy summary update'.split(' '));

function purposeFor(artifact) {
  const text = `${artifact.title} ${artifact.description} ${artifact.relativePath}`;
  return PURPOSES.find(([, pattern]) => pattern.test(text))?.[0] || 'Other knowledge work';
}

function topicTokens(artifact) {
  const source = `${artifact.title} ${artifact.description}`.toLowerCase().replace(/[^a-z0-9+#.-]+/g, ' ');
  return [...new Set(source.split(/\s+/).map((item) => item.replace(/^[+.#-]+|[+.#-]+$/g, '')).filter((item) => item.length >= 4 && item.length <= 28 && !STOPWORDS.has(item) && !/^\d+$/.test(item)))].slice(0, 14);
}

function titleCase(value) {
  const acronyms = new Set(['ad', 'api', 'azure', 'dns', 'entra', 'hyperv', 'mcp', 'ssa']);
  return value.split(/[-_ ]+/).map((part) => acronyms.has(part) ? part.toUpperCase() : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ');
}

function runCommand(command, args, timeout = 3500) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? output : ''); });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}

async function gitActivityForProjects(projects) {
  if (Date.now() - gitCache.at < 60_000) return gitCache.value;
  const groups = await Promise.all(projects.filter((project) => project.exists && path.isAbsolute(project.path)).map(async (project) => {
    const output = await runCommand('/usr/bin/git', ['-C', project.path, 'log', '--since=120 days ago', '--max-count=80', '--format=%ct%x09%h%x09%s']);
    return output.split(/\r?\n/).filter(Boolean).map((line) => {
      const [timestamp, hash, ...subject] = line.split('\t');
      return { id: `git-${project.id}-${hash}`, at: new Date(Number(timestamp) * 1000).toISOString(), type: 'git', title: project.name, label: `Commit ${hash}`, detail: subject.join(' ').slice(0, 220), projectId: project.id, artifactId: null };
    });
  }));
  gitCache = { at: Date.now(), value: groups.flat().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 160) };
  return gitCache.value;
}

function recommendationStateVisible(state) {
  if (!state) return true;
  if (state.status === 'dismissed' || state.status === 'done') return false;
  if (state.status === 'snoozed' && state.until && new Date(state.until).getTime() > Date.now()) return false;
  return true;
}

async function buildInsights(days = 90) {
  const safeDays = Number.isFinite(days) ? Math.max(1, Math.min(3650, days)) : 90;
  const [library, analytics, config] = await Promise.all([buildLibrary(), readAnalytics(), readConfig()]);
  const cutoff = Date.now() - safeDays * 86_400_000;
  const events = analytics.events.filter((event) => new Date(event.at).getTime() >= cutoff);
  const artifactById = new Map(library.artifacts.map((artifact) => [artifact.id, artifact]));
  const openCounts = new Map();
  const searchClickCounts = new Map();
  for (const event of events) {
    if (event.artifactId && event.type === 'open') openCounts.set(event.artifactId, (openCounts.get(event.artifactId) || 0) + 1);
    if (event.artifactId && event.type === 'open' && event.query) searchClickCounts.set(event.artifactId, (searchClickCounts.get(event.artifactId) || 0) + 1);
  }

  const classified = library.artifacts.map((artifact) => {
    const feedback = analytics.feedback[artifact.id] || null;
    const lastActivityAt = [artifact.lastUsedAt, artifact.modifiedAt, artifact.lastBackedUpAt, feedback?.updatedAt].filter(Boolean).sort().at(-1) || null;
    return {
      ...artifact,
      purpose: purposeFor(artifact),
      topics: topicTokens(artifact),
      trackedOpens: openCounts.get(artifact.id) || 0,
      searchClicks: searchClickCounts.get(artifact.id) || 0,
      feedback,
      lastActivityAt,
    };
  });

  const topicMap = new Map();
  for (const artifact of classified) {
    for (const topic of artifact.topics) {
      const entry = topicMap.get(topic) || { id: topic, name: titleCase(topic), artifactIds: [], repeatUse: 0, versions: 0, sessionReplies: 0 };
      entry.artifactIds.push(artifact.id);
      entry.repeatUse += artifact.trackedOpens > 1 || artifact.versionCount > 1 || artifact.sessionMessages > 1 ? 1 : 0;
      entry.versions += artifact.versionCount;
      entry.sessionReplies += artifact.sessionMessages;
      topicMap.set(topic, entry);
    }
  }
  const topics = [...topicMap.values()].filter((topic) => topic.artifactIds.length >= 2).sort((a, b) => b.artifactIds.length - a.artifactIds.length || b.repeatUse - a.repeatUse).slice(0, 18).map((topic) => ({
    ...topic,
    count: topic.artifactIds.length,
    examples: topic.artifactIds.slice(0, 3).map((id) => artifactById.get(id)?.title).filter(Boolean),
  }));

  const purposeMap = new Map();
  for (const artifact of classified) {
    const entry = purposeMap.get(artifact.purpose) || { name: artifact.purpose, artifacts: [], repeatUse: 0, versions: 0, sessionReplies: 0 };
    entry.artifacts.push(artifact);
    entry.repeatUse += artifact.trackedOpens > 1 || artifact.versionCount > 1 || artifact.sessionMessages > 1 ? 1 : 0;
    entry.versions += artifact.versionCount;
    entry.sessionReplies += artifact.sessionMessages;
    purposeMap.set(artifact.purpose, entry);
  }
  const purposes = [...purposeMap.values()].sort((a, b) => b.artifacts.length - a.artifacts.length).map((entry) => ({
    name: entry.name,
    count: entry.artifacts.length,
    repeatUse: entry.repeatUse,
    versions: entry.versions,
    sessionReplies: entry.sessionReplies,
    examples: entry.artifacts.slice(0, 3).map((artifact) => artifact.title),
  }));

  const searchMap = new Map();
  for (const event of events.filter((event) => event.type === 'search' && event.query)) {
    const key = event.query.toLowerCase();
    const entry = searchMap.get(key) || { query: event.query, count: 0, zeroResultCount: 0, totalResults: 0, lastSearchedAt: event.at };
    entry.count += 1;
    entry.zeroResultCount += event.resultCount === 0 ? 1 : 0;
    entry.totalResults += event.resultCount || 0;
    if (event.at > entry.lastSearchedAt) entry.lastSearchedAt = event.at;
    searchMap.set(key, entry);
  }
  const searches = [...searchMap.values()].sort((a, b) => b.count - a.count || b.lastSearchedAt.localeCompare(a.lastSearchedAt)).slice(0, 20).map((entry) => ({ ...entry, averageResults: Math.round(entry.totalResults / entry.count) }));

  const valuable = classified.filter((artifact) => artifact.versionCount > 1 || artifact.sessionMessages > 0 || artifact.feedback?.value === 'useful' || artifact.feedback?.outcome);
  const dormant = valuable.filter((artifact) => !artifact.lastActivityAt || new Date(artifact.lastActivityAt).getTime() < Date.now() - 30 * 86_400_000).sort((a, b) => (b.versionCount + b.sessionMessages) - (a.versionCount + a.sessionMessages)).slice(0, 10).map((artifact) => ({
    id: artifact.id,
    title: artifact.title,
    projectName: artifact.projectName,
    file: artifact.file,
    lastActivityAt: artifact.lastActivityAt,
    reason: artifact.feedback?.value === 'useful' ? 'You marked this useful' : artifact.sessionMessages ? `${artifact.sessionMessages} known session replies` : `${artifact.versionCount} protected versions`,
  }));

  const templateCandidates = purposes.filter((purpose) => purpose.count >= 2 && purpose.name !== 'Other knowledge work').slice(0, 8).map((purpose) => ({
    id: slug(purpose.name),
    name: purpose.name,
    count: purpose.count,
    confidence: purpose.count >= 6 ? 'High' : purpose.count >= 3 ? 'Medium' : 'Early',
    evidence: `${purpose.repeatUse} show repeat-use signals · ${purpose.versions} protected versions`,
    examples: purpose.examples,
  }));

  const versionEvents = [];
  if (config.archiveRoot) {
    for (const artifact of classified) {
      if (!artifact.versionCount) continue;
      const manifest = await readManifest(config, artifact).catch(() => null);
      if (!manifest) continue;
      manifest.versions.forEach((version, index) => {
        const previous = manifest.versions[index - 1];
        const lineDelta = previous ? version.lineCount - previous.lineCount : 0;
        versionEvents.push({
          id: `version-${artifact.id}-${version.id}`,
          at: version.createdAt,
          type: 'version',
          title: artifact.title,
          label: index === 0 ? 'Baseline protected' : version.reason === 'restore' ? 'Version restored' : 'Revision protected',
          detail: `${lineDelta > 0 ? '+' : ''}${lineDelta} lines · ${version.assetsCopied} local assets`,
          projectId: artifact.projectId,
          artifactId: artifact.id,
        });
      });
    }
  }
  const interactionEvents = events.filter((event) => event.type !== 'search').map((event) => {
    const artifact = artifactById.get(event.artifactId);
    return { ...event, title: artifact?.title || event.label || 'Lavish Library', label: event.label || titleCase(event.type), detail: event.detail || artifact?.projectName || '' };
  });
  const sessionEvents = classified.filter((artifact) => artifact.lastUsedAt).map((artifact) => ({
    id: `session-${artifact.id}-${artifact.lastUsedAt}`,
    at: artifact.lastUsedAt,
    type: 'session',
    title: artifact.title,
    label: artifact.sessionMessages ? `Session activity · ${artifact.sessionMessages} replies` : 'Lavish session activity',
    detail: artifact.projectName,
    projectId: artifact.projectId,
    artifactId: artifact.id,
  }));
  const gitEvents = await gitActivityForProjects(library.projects);
  const evolution = [...versionEvents, ...interactionEvents, ...sessionEvents, ...gitEvents].filter((event) => new Date(event.at).getTime() >= cutoff).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 80);

  const planCount = purposeMap.get('Implementation plan')?.artifacts.length || 0;
  const retrospectiveCount = purposeMap.get('Retrospective')?.artifacts.length || 0;
  const zeroSearch = searches.find((search) => search.zeroResultCount > 0);
  const topTopic = topics[0];
  const topPurpose = purposes[0];
  const labelledCount = Object.keys(analytics.feedback).length;
  const rawRecommendations = [
    dormant.length ? { id: 'review-dormant', kind: 'Resurface', title: `Revisit ${dormant.length} dormant ${dormant.length === 1 ? 'gem' : 'gems'}`, description: 'These Lavishes accumulated revisions or feedback, then fell quiet.', evidence: dormant.slice(0, 3).map((item) => item.title).join(' · '), confidence: 'High' } : null,
    topTopic ? { id: `curate-${topTopic.id}`, kind: 'Curate', title: `Create a ${topTopic.name} shelf`, description: 'This topic recurs across projects and deserves a reliable home.', evidence: `${topTopic.count} Lavishes · ${topTopic.repeatUse} with repeat-use signals`, confidence: topTopic.count >= 5 ? 'High' : 'Medium' } : null,
    templateCandidates[0] ? { id: `template-${templateCandidates[0].id}`, kind: 'Template', title: `Harvest a ${templateCandidates[0].name.toLowerCase()} template`, description: 'A repeated shape is emerging from work you already produce.', evidence: templateCandidates[0].evidence, confidence: templateCandidates[0].confidence } : null,
    planCount >= Math.max(3, retrospectiveCount * 3) ? { id: 'reflect-on-plans', kind: 'Experiment', title: 'Close one planning loop', description: 'Plans substantially outnumber outcome reflections. Pick one shipped plan and record what proved true.', evidence: `${planCount} planning artifacts · ${retrospectiveCount} retrospectives`, confidence: 'Medium' } : null,
    zeroSearch ? { id: `search-gap-${slug(zeroSearch.query)}`, kind: 'Findability', title: `Resolve the “${zeroSearch.query}” search gap`, description: 'At least one search returned no useful candidates.', evidence: `${zeroSearch.zeroResultCount} zero-result ${zeroSearch.zeroResultCount === 1 ? 'search' : 'searches'}`, confidence: 'High' } : null,
    labelledCount < Math.min(8, classified.length) ? { id: 'teach-value', kind: 'Feedback', title: 'Teach Lavish what “valuable” means', description: 'Label a few representative artifacts so recommendations learn from outcomes, not attention alone.', evidence: `${labelledCount} of ${classified.length} Lavishes labelled`, confidence: 'High' } : null,
  ].filter(Boolean);
  const recommendations = rawRecommendations.filter((item) => recommendationStateVisible(analytics.recommendationState[item.id])).map((item) => ({ ...item, state: analytics.recommendationState[item.id] || null }));

  const active30d = classified.filter((artifact) => artifact.lastActivityAt && new Date(artifact.lastActivityAt).getTime() >= Date.now() - 30 * 86_400_000).length;
  const repeatArtifacts = classified.filter((artifact) => artifact.trackedOpens > 1 || artifact.versionCount > 1 || artifact.sessionMessages > 1).length;
  const sessionReplies = classified.reduce((sum, artifact) => sum + artifact.sessionMessages, 0);
  const outcomes = classified.filter((artifact) => artifact.feedback?.outcome).length;
  const topSentence = topPurpose ? `${topPurpose.name} is your most common Lavish shape` : 'Your library is ready to reveal its strongest patterns';
  const lastReviewedAt = analytics.events.filter((event) => event.type === 'review_open').sort((a, b) => b.at.localeCompare(a.at))[0]?.at || null;
  const scheduledIntervals = [analytics.settings.weekly ? 7 : null, analytics.settings.monthly ? 30 : null].filter(Boolean);
  const nextDueAt = lastReviewedAt && scheduledIntervals.length ? new Date(new Date(lastReviewedAt).getTime() + Math.min(...scheduledIntervals) * 86_400_000).toISOString() : null;
  const newestEvidenceAt = evolution[0]?.at || null;
  const reasons = [];
  if (!lastReviewedAt && (analytics.settings.weekly || analytics.settings.monthly || analytics.settings.contextual)) reasons.push('Your first review is ready');
  if (nextDueAt && new Date(nextDueAt).getTime() <= Date.now()) reasons.push('A scheduled reflection is due');
  if (analytics.settings.contextual && newestEvidenceAt && (!lastReviewedAt || newestEvidenceAt > lastReviewedAt)) reasons.push('New revisions or activity are available');
  const review = {
    headline: `${topSentence}.`,
    lede: topPurpose
      ? `${topPurpose.count} artifacts fit this pattern, with ${topPurpose.repeatUse} showing repeat-use signals. The most useful next step is to connect that attention to explicit outcomes as your plans evolve.`
      : 'Usage evidence will become more useful as you search, revisit, revise, and label outcomes.',
    highlights: [
      topTopic ? { title: `${topTopic.name} keeps surfacing`, detail: `${topTopic.count} Lavishes across the library; ${topTopic.repeatUse} show repeat-use signals.`, tone: 'signal' } : null,
      dormant.length ? { title: `${dormant.length} strong artifacts have gone quiet`, detail: 'They have revisions or feedback, but no recent activity. That may mean “finished,” not “failed.”', tone: 'dormant' } : null,
      planCount ? { title: 'Plans can now tell their own story', detail: `${versionEvents.length} archived revision events and ${gitEvents.length} recent Git events can form an evidence timeline.`, tone: 'evolution' } : null,
    ].filter(Boolean),
    status: { due: reasons.length > 0, reasons: [...new Set(reasons)], lastReviewedAt, nextDueAt, newestEvidenceAt },
  };

  return {
    generatedAt: new Date().toISOString(),
    rangeDays: safeDays,
    privacy: { localOnly: true, foregroundTime: false, signals: ['Library interactions', 'Lavish session events', 'Local content classification', 'Git and outcome links'] },
    settings: analytics.settings,
    summary: { totalArtifacts: classified.length, active30d, repeatArtifacts, sessionReplies, versions: library.archive.totalVersions, outcomes, trackedSearches: events.filter((event) => event.type === 'search').length },
    topics,
    purposes,
    searches,
    dormant,
    templateCandidates,
    recommendations,
    evolution,
    review,
    feedbackQueue: classified.filter((artifact) => !artifact.feedback).sort((a, b) => new Date(b.lastActivityAt || 0) - new Date(a.lastActivityAt || 0)).slice(0, 8).map((artifact) => ({ id: artifact.id, file: artifact.file, title: artifact.title, projectName: artifact.projectName, lastActivityAt: artifact.lastActivityAt })),
  };
}

function originAllowed(origin) {
  return ALLOWED_WEB_ORIGINS.has(origin);
}

function tokenAllowed(value) {
  const supplied = Buffer.from(String(value || ''));
  const expected = Buffer.from(API_TOKEN);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function hostAllowed(value) {
  return value === `${HOST}:${PORT}` || value === `localhost:${PORT}`;
}

function json(res, status, value, origin = '') {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (originAllowed(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers.vary = 'origin';
  }
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
  if (!hostAllowed(String(req.headers.host || ''))) return json(res, 403, { error: 'Request host is not allowed.' });
  if (origin && !originAllowed(origin)) return json(res, 403, { error: 'Browser origin is not allowed.' });
  if (!origin && req.headers['sec-fetch-site']) return json(res, 403, { error: 'Browser origin is required.' });
  if (req.method === 'OPTIONS') {
    if (!origin) return json(res, 400, { error: 'Browser origin is required.' });
    res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,x-lavish-token', vary: 'origin' });
    return res.end();
  }
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/api/session') {
      if (!origin) return json(res, 403, { error: 'Open Lavish Library in its local browser page first.' });
      return json(res, 200, { token: API_TOKEN }, origin);
    }
    if (origin && url.pathname.startsWith('/api/') && !tokenAllowed(req.headers['x-lavish-token'])) {
      return json(res, 401, { error: 'The local browser session is not authorized.' }, origin);
    }
    if (req.method === 'GET' && url.pathname === '/api/library') return json(res, 200, await buildLibrary(), origin);
    if (req.method === 'GET' && url.pathname === '/api/insights') return json(res, 200, await buildInsights(Number(url.searchParams.get('days') || 90)), origin);
    if (req.method === 'GET' && url.pathname === '/api/artifacts/versions') return json(res, 200, await versionsFor(url.searchParams.get('file')), origin);
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, app: 'lavish-tracker' }, origin);
    if (req.method === 'POST' && url.pathname === '/api/projects') {
      const input = await body(req);
      return json(res, 201, { ok: true, path: await addProject(input.path) }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/events') {
      const input = await body(req);
      const event = await recordEvent(input.type, input);
      return json(res, 201, { ok: true, event }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/artifacts/feedback') {
      const input = await body(req);
      const artifact = await artifactForFile(input.file);
      const values = new Set(['useful', 'unfinished', 'disposable']);
      const outcomes = new Set(['decided', 'shipped', 'shared', 'reused', 'abandoned', 'none']);
      const value = values.has(input.value) ? input.value : null;
      const outcome = outcomes.has(input.outcome) && input.outcome !== 'none' ? input.outcome : null;
      const note = cleanEventValue(input.note, 800) || null;
      const feedback = await updateAnalytics((analytics) => {
        const previous = analytics.feedback[artifact.id] || {};
        analytics.feedback[artifact.id] = { ...previous, artifactId: artifact.id, file: artifact.file, value: value ?? previous.value ?? null, outcome: outcome ?? previous.outcome ?? null, note: note ?? previous.note ?? null, updatedAt: new Date().toISOString() };
        return analytics.feedback[artifact.id];
      });
      await recordEvent('feedback', { artifactId: artifact.id, label: [value, outcome].filter(Boolean).join(' · ') || 'Feedback updated', detail: note || '' });
      return json(res, 200, { ok: true, feedback }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/insights/settings') {
      const input = await body(req);
      const cadences = new Set(['manual', 'weekly', 'monthly', 'contextual', 'tunable']);
      const settings = await updateAnalytics((analytics) => {
        analytics.settings = {
          ...analytics.settings,
          cadence: cadences.has(input.cadence) ? input.cadence : analytics.settings.cadence,
          manual: typeof input.manual === 'boolean' ? input.manual : analytics.settings.manual,
          weekly: typeof input.weekly === 'boolean' ? input.weekly : analytics.settings.weekly,
          monthly: typeof input.monthly === 'boolean' ? input.monthly : analytics.settings.monthly,
          contextual: typeof input.contextual === 'boolean' ? input.contextual : analytics.settings.contextual,
          foregroundTime: false,
        };
        return analytics.settings;
      });
      return json(res, 200, { ok: true, settings }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/recommendations/action') {
      const input = await body(req);
      const recommendationId = cleanEventValue(input.id, 120);
      const actions = new Set(['done', 'dismissed', 'snoozed', 'reset']);
      if (!recommendationId || !actions.has(input.action)) throw new Error('Choose a valid recommendation action.');
      await updateAnalytics((analytics) => {
        if (input.action === 'reset') delete analytics.recommendationState[recommendationId];
        else analytics.recommendationState[recommendationId] = { status: input.action, at: new Date().toISOString(), until: input.action === 'snoozed' ? new Date(Date.now() + 7 * 86_400_000).toISOString() : null };
      });
      await recordEvent('recommendation', { label: input.action, detail: recommendationId });
      return json(res, 200, { ok: true }, origin);
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
      await recordEvent('snapshot', { artifactId: artifact.id, label: 'Manual version protected' });
      return json(res, 201, { ok: true, versionCount: manifest?.versions.length || 0 }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/artifacts/open') {
      const input = await body(req);
      const artifact = await artifactForFile(input.file);
      const args = [artifact.file];
      if (input.reopen) args.push('--reopen');
      spawn(LAVISH_BIN, args, { detached: true, stdio: 'ignore' }).unref();
      await recordEvent('open', { artifactId: artifact.id, query: input.query, label: input.reopen ? 'Lavish reopened' : 'Lavish opened' });
      return json(res, 202, { ok: true }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/artifacts/reveal') {
      const input = await body(req);
      const artifact = await artifactForFile(input.file);
      spawn('/usr/bin/open', ['-R', artifact.file], { detached: true, stdio: 'ignore' }).unref();
      await recordEvent('reveal', { artifactId: artifact.id, label: 'Revealed in Finder' });
      return json(res, 202, { ok: true }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/versions/open') {
      const input = await body(req);
      const resolved = await resolveVersion(input.file, input.versionId);
      spawn('/usr/bin/open', [resolved.archivedFile], { detached: true, stdio: 'ignore' }).unref();
      await recordEvent('version_open', { artifactId: resolved.artifact.id, label: 'Archived version opened', detail: resolved.version.createdAt });
      return json(res, 202, { ok: true }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/versions/restore') {
      const input = await body(req);
      const restored = await restoreVersion(input.file, input.versionId);
      await recordEvent('restore', { artifactId: restored.artifact.id, label: 'Archived version restored', detail: restored.version.createdAt });
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
