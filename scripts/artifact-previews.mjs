import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function browserExecutable() {
  if (process.env.LAVISH_TRACKER_BROWSER) return process.env.LAVISH_TRACKER_BROWSER;
  for (const candidate of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  throw new Error('Install Chrome/Chromium or set LAVISH_TRACKER_BROWSER.');
}

const CONTENT_TYPES = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-same-origin";

// Render the exact collected bytes. No HTTP request is ever continued to a
// network server, and no file:// URL or filesystem path reaches the browser.
export async function capturePreview(artifact, bundle) {
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: await browserExecutable(), headless: true,
    timeout: 10_000, protocolTimeout: 10_000,
    // The companion owns its signal lifecycle. Puppeteer's default SIGTERM
    // handler would close Chrome but leave the HTTP service running.
    handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false,
    args: [
      '--disable-background-networking', '--disable-component-update', '--no-first-run',
      '--host-resolver-rules=MAP * ~NOTFOUND', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      // GitHub's Linux runners restrict unprivileged user namespaces. CI captures
      // only locally intercepted fixture bytes, so Chrome can run without its sandbox there.
      ...(process.platform === 'linux' && process.env.CI === 'true' ? ['--no-sandbox'] : []),
    ],
  });
  const deadline = setTimeout(() => { browser.process()?.kill('SIGKILL'); }, 15_000);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 750, deviceScaleFactor: 1 });
    await page.setBypassServiceWorker(true);
    await page.setRequestInterception(true);
    const entry = `http://lavish-preview.invalid/${encodeURIComponent(path.basename(artifact.file))}`;
    page.on('request', (request) => {
      const serve = async () => {
        const url = new URL(request.url());
        if (url.origin !== 'http://lavish-preview.invalid' || request.method() !== 'GET'
          || (request.isNavigationRequest() && request.url() !== entry)) return request.abort();
        const relative = decodeURIComponent(url.pathname.slice(1));
        const bytes = bundle.files.get(relative);
        if (!bytes) return request.abort();
        return request.respond({ status: 200, contentType: CONTENT_TYPES[path.extname(relative).toLowerCase()] || 'application/octet-stream', headers: { 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' }, body: bytes });
      };
      void serve().catch(() => { if (!request.isInterceptResolutionHandled()) void request.abort().catch(() => {}); });
    });
    page.on('dialog', (dialog) => { void dialog.dismiss().catch(() => {}); });
    browser.on('targetcreated', (target) => { if (target.type() === 'page') void target.page().then((popup) => popup?.close()).catch(() => {}); });
    await page.goto(entry, { waitUntil: 'networkidle0', timeout: 8_000 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    return Buffer.from(await page.screenshot({ type: 'png' }));
  } finally {
    clearTimeout(deadline);
    await browser.close().catch(() => { browser.process()?.kill('SIGKILL'); });
  }
}

export function createPreviewCache({ directory, collect, capture = capturePreview }) {
  const states = new Map();
  let queue = Promise.resolve();

  async function stateFor(id) {
    if (!states.has(id)) {
      const loading = (async () => {
        try {
          const saved = JSON.parse(await readFile(path.join(directory, `${id}.json`), 'utf8'));
          const png = await readFile(path.join(directory, `${id}.png`));
          if (createHash('sha256').update(png).digest('hex') !== saved.pngSha256) throw new Error('Incomplete preview cache.');
          return { key: saved.key, png, status: 'ready', pending: false };
        } catch { return { key: null, png: null, status: 'pending', pending: false }; }
      })();
      states.set(id, loading);
    }
    return states.get(id);
  }

  async function refresh(artifact) {
    const state = await stateFor(artifact.id);
    if (state.pending) return;
    state.pending = true;
    queue = queue.catch(() => {}).then(async () => {
      try {
        const bundle = await collect(artifact.file);
        const key = createHash('sha256').update(`preview-v1:${bundle.bundleSha256}`).digest('hex');
        if (key === state.key && (state.png || Date.now() - (state.failedAt || 0) < 60_000)) return;
        state.key = key;
        const png = await capture(artifact, bundle);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const pngPath = path.join(directory, `${artifact.id}.png`);
        await writeFile(`${pngPath}.tmp`, png, { mode: 0o600 });
        await rename(`${pngPath}.tmp`, pngPath);
        const metadataPath = path.join(directory, `${artifact.id}.json`);
        await writeFile(`${metadataPath}.tmp`, JSON.stringify({ key, pngSha256: createHash('sha256').update(png).digest('hex') }), { mode: 0o600 });
        await rename(`${metadataPath}.tmp`, metadataPath);
        Object.assign(state, { png, status: 'ready', failedAt: null });
      } catch (error) {
        Object.assign(state, { png: null, status: error.code === 'ENOENT' ? 'missing' : 'failed', failedAt: Date.now() });
        await Promise.all(['png', 'json'].map((extension) => rm(path.join(directory, `${artifact.id}.${extension}`), { force: true }).catch(() => {})));
      } finally { state.pending = false; }
    });
  }

  return {
    schedule(artifact) { return refresh(artifact).catch(() => {}); },
    async read(id) {
      const state = await stateFor(id);
      return { status: state.png ? 'ready' : state.pending ? 'pending' : state.status, png: state.png, stale: Boolean(state.png && state.pending) };
    },
    async idle() { await queue; },
  };
}
