import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';

// Synthetic API responses, visibility and poll timing; the real Home and
// apiFetch render in an isolated chrome-devtools-axi browser session.
test('synthetic library refresh regressions', { skip: process.env.LAVISH_BACKUP_UI_TEST !== '1' }, async (t) => {
  const { build } = await import('esbuild');
  const bundle = await build({
    stdin: { contents: "import React from 'react'; import { createRoot } from 'react-dom/client'; import Home from './app/page.tsx'; window.unmountHome = () => root.unmount(); const root = createRoot(document.getElementById('root')); root.render(<Home />);", resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, jsx: 'automatic',
  });
  const bootstrap = `
    window.fixture = { requests: [], snapshots: 0, hidden: location.search === '?hidden', poll: null };
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => fixture.hidden ? 'hidden' : 'visible' });
    const originalInterval = window.setInterval;
    window.setInterval = (callback, delay, ...args) => {
      if (delay === 5000) { fixture.poll = callback; return 0; }
      return originalInterval(callback, delay, ...args);
    };
    window.fetch = async (url) => {
      const route = new URL(url).pathname;
      if (route === '/api/session') return Response.json({ token: 'synthetic' });
      if (route === '/api/library') return new Promise((resolve) => fixture.requests.push({ complete: (value) => resolve(Response.json(value)) }));
      if (route === '/api/artifacts/snapshot') { fixture.snapshots += 1; return Response.json({}); }
      return Response.json({ status: 'unavailable' });
    };
    window.libraryValue = (protectedLatest, description = 'Initial library') => ({
      projects: [{ id: 'project', name: 'Synthetic project', path: '/synthetic', source: 'added', exists: true, artifactCount: 1 }],
      artifacts: [{ id: 'artifact', projectId: 'project', title: 'Synthetic plan', description, file: '/synthetic/plan.html', relativePath: 'plan.html', modifiedAt: '2026-01-01T00:00:00Z', lastUsedAt: null, size: 100, exists: true, sessionStatus: 'discovered', pendingPrompts: 0, url: null, endedBy: null, sessionMessages: 0, versionCount: protectedLatest ? 1 : 0, lastBackedUpAt: protectedLatest ? '2026-01-01T00:00:00Z' : null, backupError: protectedLatest ? null : 'Synthetic backup failure' }],
      server: { running: false, url: '' },
      archive: { enabled: true, root: '/synthetic/archive', path: '/synthetic/archive', totalVersions: protectedLatest ? 1 : 0, protectedArtifacts: protectedLatest ? 1 : 0, failedArtifacts: protectedLatest ? 0 : 1, unprotectedArtifacts: protectedLatest ? 0 : 1 },
      scannedAt: '2026-01-01T00:00:00Z',
    });
  `;
  const server = createServer((req, res) => {
    res.setHeader('content-type', req.url === '/app.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/app.js' ? bundle.outputFiles[0].contents : `<!doctype html><div id="root"></div><script>${bootstrap}</script><script src="/app.js"></script>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const session = `lavish-refresh-${process.pid}`;
  const command = (args, script = '') => new Promise((resolve, reject) => {
    const child = spawn('chrome-devtools-axi', args, { env: { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: session }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (bytes) => { output += bytes; });
    child.stderr.on('data', (bytes) => { output += bytes; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(output)));
    child.stdin.end(script);
  });
  const check = (script) => command(['run'], `
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const wait = (predicate) => page.eval('() => new Promise((resolve, reject) => { const predicate = ' + predicate.toString() + '; const until = Date.now() + 3000; const poll = () => { if (predicate()) return resolve(); if (Date.now() > until) return reject(new Error("Timed out: " + ' + JSON.stringify(predicate.toString()) + ')); setTimeout(poll, 10); }; poll(); })');
    ${script}
  `);
  try {
    for (const pollFirst of [true, false]) {
      await t.test(`backup reconciliation survives a poll (${pollFirst ? 'poll' : 'reconciliation'} completes first)`, async () => {
        await check(`
          await page.open('${url}');
          await wait(() => window.fixture.requests.length === 1);
          await page.eval(() => fixture.requests[0].complete(libraryValue(false)));
          await wait(() => !!document.querySelector('.backup-retry'));
          await page.eval(() => document.querySelector('.backup-retry').click());
          await wait(() => window.fixture.requests.length === 2);
          assert(await page.eval(() => fixture.snapshots === 1 && document.querySelector('.notice')?.textContent.includes('Protecting')), 'backup did not enter reconciliation');
          await page.eval(() => fixture.poll());
          await wait(() => window.fixture.requests.length === 3);
          await page.eval(() => fixture.requests[${pollFirst ? 2 : 1}].complete(libraryValue(true, '${pollFirst ? 'Newer poll' : 'Reconciliation'}')));
          await page.eval(() => new Promise((resolve) => setTimeout(resolve, 50)));
          await page.eval(() => fixture.requests[${pollFirst ? 1 : 2}].complete(libraryValue(true, '${pollFirst ? 'Reconciliation' : 'Newer poll'}')));
          await wait(() => document.querySelector('.description')?.textContent === 'Newer poll' && !document.querySelector('.backup-retry'));
          assert(await page.eval(() => document.querySelector('.notice')?.textContent === 'Current version is protected.'), 'successful backup left Protecting notice after overlapping poll');
        `);
      });
    }
    await t.test('hidden initial load refreshes immediately on visibility and cleans up', async () => {
      await check(`
        await page.open('${url}?hidden');
        await wait(() => typeof window.fixture.poll === 'function');
        assert(await page.eval(() => fixture.requests.length === 0 && !document.querySelector('.artifact-card')), 'hidden tab started a request');
        await page.eval(() => { fixture.hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
        await wait(() => window.fixture.requests.length === 1);
        await page.eval(() => { document.dispatchEvent(new Event('visibilitychange')); fixture.poll(); });
        assert(await page.eval(() => fixture.requests.length === 1), 'visibility and poll overlapped an active refresh');
        await page.eval(() => fixture.requests[0].complete(libraryValue(true)));
        await wait(() => !!document.querySelector('.artifact-card'));
        await page.eval(() => { fixture.hidden = true; document.dispatchEvent(new Event('visibilitychange')); fixture.poll(); });
        assert(await page.eval(() => fixture.requests.length === 1), 'hidden poll started a request');
        await page.eval(() => { window.unmountHome(); fixture.hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
        await page.eval(() => new Promise((resolve) => setTimeout(resolve, 50)));
        assert(await page.eval(() => fixture.requests.length === 1), 'unmounted page retained visibility listener');
      `);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await command(['stop']);
  }
});
