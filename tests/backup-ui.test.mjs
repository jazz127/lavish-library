import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { backupFixture, freePort } from './helpers/backup-fixture.mjs';

// Opt in with LAVISH_BACKUP_UI_TEST=1. The actual Home component and apiFetch
// run against a synthetic companion fixture in an isolated browser session.
test('synthetic browser covers backup states, accessible warnings, retry and summary recovery', { skip: process.env.LAVISH_BACKUP_UI_TEST !== '1' }, async () => {
  const { build } = await import('esbuild');
  const uiPort = await freePort();
  const session = `lavish-issue-24-${process.pid}`;
  const command = (args, script = '') => new Promise((resolve, reject) => {
    const child = spawn('chrome-devtools-axi', args, { env: { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: session }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (bytes) => { stdout += bytes; });
    child.stderr.on('data', (bytes) => { stderr += bytes; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${stdout}\n${stderr}`)));
    child.stdin.end(script);
  });
  const browser = (script) => command(['run'], script);
  const capture = async (name) => {
    if (!process.env.LAVISH_BACKUP_SCREENSHOT_DIR) return;
    const directory = path.resolve(process.env.LAVISH_BACKUP_SCREENSHOT_DIR);
    await mkdir(directory, { recursive: true });
    await browser("await page.eval(() => document.querySelector('.backup-status').scrollIntoView({ block: 'center' }));");
    await command(['screenshot', path.join(directory, `${name}.png`)]);
    await writeFile(path.join(directory, `${name}.txt`), await browser('console.log(await page.snapshot());'));
  };
  await backupFixture(async ({ api, configure, library, blockFirst, unblockFirst, blockNext, unblockNext }) => {
    const bundle = await build({
      stdin: { contents: "import React from 'react'; import { createRoot } from 'react-dom/client'; import Home from './app/page.tsx'; import './app/globals.css'; createRoot(document.getElementById('root')).render(<Home />);", resolveDir: process.cwd(), loader: 'tsx' },
      bundle: true, write: false, outfile: 'app.js', jsx: 'automatic', conditions: ['style'],
      plugins: [{ name: 'synthetic-api-origin', setup(build) {
        build.onLoad({ filter: /app\/api-client\.ts$/ }, async ({ path }) => ({ contents: (await readFile(path, 'utf8')).replace('http://127.0.0.1:4318', api.replace(/\/api$/, '')), loader: 'ts' }));
      } }],
    });
    const server = createServer((req, res) => {
      const file = bundle.outputFiles.find((entry) => req.url === `/${entry.path.split('/').at(-1)}`);
      res.setHeader('content-type', file ? req.url.endsWith('.css') ? 'text/css' : 'text/javascript' : 'text/html');
      res.end(file?.contents || '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>');
    });
    await new Promise((resolve) => server.listen(uiPort, '127.0.0.1', resolve));
    const check = async (script) => browser(`
      const assert = (value, message) => { if (!value) throw new Error(message); };
      // The installed CLI's selector wait passes a Promise instead of a
      // function to CDP; keep waits in the supported page.eval function form.
      page.wait = async (selector) => page.eval('() => new Promise((resolve, reject) => { const selector = ' + JSON.stringify(selector) + '; const until = Date.now() + 10000; const poll = () => { if (document.querySelector(selector)) return resolve(); if (Date.now() > until) return reject(new Error("Missing: " + selector)); setTimeout(poll, 25); }; poll(); })');
      page.click = async (selector) => page.eval('() => { const element = document.querySelector(' + JSON.stringify(selector) + '); if (!element) throw new Error("Missing control"); element.click(); }');
      ${script}
    `);
    const refresh = `await page.click('[aria-label="Refresh library"]'); await page.wait('.artifact-card');`;
    try {
      await check(`await page.open('http://127.0.0.1:${uiPort}'); await page.wait('.artifact-card');
        assert((await page.eval(() => document.querySelector('.backup-status').textContent)).includes('Archive disabled'), 'disabled state missing');`);
      await blockFirst();
      await check(`${refresh}
        assert((await page.eval(() => document.querySelector('[role="alert"]').textContent)).includes('ENOTDIR'), 'useful first failure missing');
        assert((await page.eval(() => document.querySelector('.backup-status').textContent)).includes('Never backed up'), 'first failure history missing');
        await page.click('.archive-button');
        assert((await page.eval(() => document.querySelector('.archive-stats').textContent)).includes('1 failed'), 'failure summary missing');
        await page.click('.backup-retry');
        await page.wait('.backup-retry:not(:disabled)');
        assert(await page.eval(() => !!document.querySelector('[role="alert"]')), 'failed retry hid warning');`);
      await unblockFirst();
      await check(`await page.eval(() => document.querySelector('.backup-retry').focus()); await page.press('Enter'); await page.wait('.backup-status.protected');
        assert(await page.eval(() => !document.querySelector('[role="alert"]')), 'recovery warning stale');
        assert((await page.eval(() => document.querySelector('.archive-stats').textContent)).includes('1 latest protected'), 'recovery summary missing');
        assert(await page.eval(() => !!document.querySelector('.backup-status time[datetime]')), 'last success date missing');`);
      const saved = (await library()).artifacts[0].lastBackedUpAt;
      await blockNext();
      await check(`await page.wait('.backup-status.failed');
        assert((await page.eval(() => document.querySelector('.archive-stats').textContent)).includes('1 failed'), 'automatic failure summary missing');
        assert((await page.eval(() => document.querySelector('[role="alert"]').textContent)).includes('Latest content is not protected'), 'old copy implied latest protection');
        assert((await page.eval(() => document.querySelector('.backup-status time').getAttribute('datetime'))) === ${JSON.stringify(saved)}, 'last success was lost');
        assert(await page.eval(() => !document.querySelector('.history-chip.protected')), 'history chip falsely indicates protection');`);
      await capture('failed-grid');
      await command(['resize', '390', '844']);
      await check(`await page.click('[aria-label="List view"]');
        assert(await page.eval(() => !!document.querySelector('.artifact-list [role="alert"]')), 'list warning missing');`);
      await capture('failed-mobile-list');
      await unblockNext();
      await check(`await page.click('.backup-retry'); await page.wait('.backup-status.protected');
        assert(await page.eval(() => !document.querySelector('[role="alert"]')), 'second recovery warning stale');`);
      await configure(false);
      await check(`${refresh} assert((await page.eval(() => document.querySelector('.backup-status').textContent)).includes('Archive disabled'), 'disable did not clear protection');`);
      // A synthetic API response is used only for the never-backed-up state,
      // because /library normally attempts the initial snapshot during a scan.
      await configure(true);
      await check(`await page.eval(() => { const original = window.fetch; window.fetch = async (...args) => {
        const response = await original(...args);
        if (String(args[0]).endsWith('/library')) { const value = await response.json(); value.artifacts[0].backupError = null; value.artifacts[0].lastBackedUpAt = null; value.artifacts[0].versionCount = 0; return new Response(JSON.stringify(value)); }
        return response;
      }; }); ${refresh}
        assert((await page.eval(() => document.querySelector('.backup-status').textContent)).includes('Never backed up'), 'never-backed-up state missing');`);
      assert.ok(saved);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      const child = spawn('chrome-devtools-axi', ['stop'], { env: { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: session }, stdio: 'ignore' });
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }, { uiPort });
});
