import { lstat } from 'node:fs/promises';
import path from 'node:path';

// Lavish 0.1.73's persisted fatal diagnostics. Load tokens/revisions identify
// browser requests; they are not evidence that an artifact rendered successfully.
export function artifactFailures(session) {
  if (!Array.isArray(session?.artifact_failures)) return [];
  return session.artifact_failures.slice(-20).filter((failure) => failure &&
    ['artifact-unavailable', 'artifact-asset-unavailable'].includes(failure.kind)).map((failure) => ({
    kind: failure.kind,
    detail: typeof failure.detail === 'string' ? failure.detail.slice(0, 300) : '',
  }));
}

// Lavish 0.1.76: script[data-lavish-revisions] contains an array of
// { id, label, timestamp, summary }. These are declarations, not inferred diffs.
export function revisionContext(html) {
  // Skip comments, quoted attributes and raw-text elements. Never execute HTML.
  const tags = /<!--[\s\S]*?(?:-->|$)|<([a-z][\w:-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
  let match;
  while ((match = tags.exec(html))) {
    if (!match[1]) continue;
    const tag = match[1].toLowerCase();
    if (tag === 'plaintext') return [];
    if (!['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes'].includes(tag)) continue;
    const closing = new RegExp(`</${tag}\\s*>`, 'gi');
    closing.lastIndex = tags.lastIndex;
    const end = closing.exec(html);
    if (!end) return [];
    const content = html.slice(tags.lastIndex, end.index);
    tags.lastIndex = closing.lastIndex;
    if (tag !== 'script') continue;
    const attributes = [...match[2].matchAll(/([^\s=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+))?/g)];
    if (!attributes.some((attribute) => attribute[1].toLowerCase() === 'data-lavish-revisions')) continue;
    const text = content.trim();
    if (!text || text.length > 64 * 1024) return [];
    let entries;
    try { entries = JSON.parse(text); } catch { return []; }
    if (!Array.isArray(entries)) return [];
    const seen = new Set();
    const result = [];
    const clean = (value, max) => ['string', 'number'].includes(typeof value) ? String(value).trim().slice(0, max) : '';
    for (const entry of entries.slice(0, 256)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const id = clean(entry.id, 61);
      if (!id || id.length > 60 || /\s/.test(id) || seen.has(id)) continue;
      seen.add(id);
      result.push({ id, label: clean(entry.label, 80) || id, timestamp: clean(entry.timestamp, 40), summary: clean(entry.summary, 400) });
      if (result.length === 6) break;
    }
    return result;
  }
  return [];
}

export async function serverLogPath(stateDirectory) {
  const file = path.resolve(stateDirectory, 'server.log');
  // The server chooses this path, never a browser-supplied path or URL.
  const details = await lstat(file).catch(() => null);
  return details?.isFile() ? file : null;
}

export async function revealServerLog(stateDirectory, launch) {
  const file = await serverLogPath(stateDirectory);
  if (!file) throw new Error('No local server.log is available yet.');
  await launch('/usr/bin/open', ['-R', file]);
}
