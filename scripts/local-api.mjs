import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
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

const idFor = (value) => createHash('sha1').update(value).digest('hex').slice(0, 12);
const exists = async (value) => access(value, constants.F_OK).then(() => true).catch(() => false);

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function readConfig() {
  const config = await readJson(CONFIG_FILE, { projects: [] });
  return { projects: Array.isArray(config.projects) ? config.projects : [] };
}

async function saveConfig(config) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function projectRootFor(file) {
  const marker = `${path.sep}.lavish${path.sep}`;
  const index = file.lastIndexOf(marker);
  return index >= 0 ? file.slice(0, index) : null;
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

async function htmlMetadata(file) {
  try {
    const html = (await readFile(file, 'utf8')).slice(0, 300_000);
    const title = cleanText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]);
    const description = cleanText(html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1] || html.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1]);
    return { title, description: description.slice(0, 180) };
  } catch { return { title: '', description: '' }; }
}

async function serverRunning() {
  try {
    const response = await fetch('http://127.0.0.1:4387/health', { signal: AbortSignal.timeout(650) });
    const value = await response.json();
    return response.ok && value.app === 'lavish-axi';
  } catch { return false; }
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
      id: idFor(file), projectId: project.id, title: metadata.title || fallbackTitle,
      description: metadata.description, file,
      relativePath: project === looseProject ? file : path.relative(project.path, file),
      modifiedAt: fileStat?.mtime?.toISOString() || null, lastUsedAt,
      size: fileStat?.size || 0, exists: fileExists,
      sessionStatus: session?.status || 'discovered', pendingPrompts: Number(session?.pending_prompts || 0),
      url: session?.url || null, endedBy: session?.ended_by || null,
    });
  }

  const projects = [...projectMap.values(), ...(hasLoose ? [looseProject] : [])].map((project) => ({
    ...project,
    exists: project.exists,
    artifactCount: artifacts.filter((artifact) => artifact.projectId === project.id).length,
  })).filter((project) => project.artifactCount > 0 || project.source === 'added');

  return { projects, artifacts, server: { running, url: 'http://127.0.0.1:4387' }, scannedAt: new Date().toISOString() };
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

function chooseFolder() {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a project to watch for Lavishes")']);
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
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, app: 'lavish-tracker' }, origin);
    if (req.method === 'POST' && url.pathname === '/api/projects') {
      const input = await body(req);
      return json(res, 201, { ok: true, path: await addProject(input.path) }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/projects/choose') {
      const chosen = await chooseFolder();
      return json(res, 201, { ok: true, path: await addProject(chosen.replace(/\/$/, '')) }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/artifacts/open') {
      const input = await body(req);
      const file = path.resolve(String(input.file || ''));
      if (!/\.html?$/i.test(file) || !(await exists(file))) return json(res, 404, { error: 'That Lavish file no longer exists.' }, origin);
      const args = [file];
      if (input.reopen) args.push('--reopen');
      spawn(LAVISH_BIN, args, { detached: true, stdio: 'ignore' }).unref();
      return json(res, 202, { ok: true }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/api/artifacts/reveal') {
      const input = await body(req);
      const file = path.resolve(String(input.file || ''));
      if (!/\.html?$/i.test(file) || !(await exists(file))) return json(res, 404, { error: 'That Lavish file no longer exists.' }, origin);
      spawn('/usr/bin/open', ['-R', file], { detached: true, stdio: 'ignore' }).unref();
      return json(res, 202, { ok: true }, origin);
    }
    return json(res, 404, { error: 'Not found.' }, origin);
  } catch (error) {
    return json(res, 400, { error: error instanceof Error ? error.message : 'Request failed.' }, origin);
  }
});

server.listen(PORT, HOST, () => console.log(`Lavish Tracker library service: http://${HOST}:${PORT}`));
