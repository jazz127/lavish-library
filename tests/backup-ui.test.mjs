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
  await backupFixture(async ({ api, file, configure, library, blockFirst, unblockFirst, blockNext, unblockNext }) => {
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
      await check(`await page.click('.history-chip'); await page.wait('.version-row.current');
        assert((await page.eval(() => document.querySelector('.history-summary strong').textContent)) === '1', 'initial version count incorrect');
        assert((await page.eval(() => document.querySelector('.version-row.current .version-title strong').textContent)) === 'Current protected version', 'initial current label missing');
        assert(await page.eval(() => document.querySelector('.version-row.current .version-actions button:last-child').disabled), 'current restore should be disabled');
        await page.eval(() => {
          window.historyDrawer = document.querySelector('.history-drawer');
          window.historyTimeline = document.querySelector('.timeline');
          window.historyWasHidden = false;
          window.historyObserver = new MutationObserver(() => {
            if (!window.historyTimeline.isConnected || window.historyDrawer.querySelector('.history-loading')) window.historyWasHidden = true;
          });
          window.historyObserver.observe(window.historyDrawer, { childList: true, subtree: true });
        });`);
      await blockNext();
      await check(`await page.wait('.backup-status.failed');
        assert((await page.eval(() => document.querySelector('.archive-stats').textContent)).includes('1 failed'), 'automatic failure summary missing');
        assert((await page.eval(() => document.querySelector('[role="alert"]').textContent)).includes('Latest content is not protected'), 'old copy implied latest protection');
        assert((await page.eval(() => document.querySelector('.backup-status time').getAttribute('datetime'))) === ${JSON.stringify(saved)}, 'last success was lost');
        assert(await page.eval(() => !document.querySelector('.history-chip.protected')), 'history chip falsely indicates protection');`);
      await check(`await page.wait('.history-drawer .backup-status.failed');
        await page.wait('.version-row:not(.current) .version-actions button:last-child:not(:disabled)');
        assert(await page.eval(() => !document.querySelector('.version-row.current')), 'failed backup left a current version');
        assert(await page.eval(() => !document.querySelector('.version-title strong').textContent.includes('Current protected')), 'failed backup left a protected label');
        assert((await page.eval(() => document.querySelector('.history-summary strong').textContent)) === '1', 'failed backup changed saved count');
        assert(await page.eval(() => window.historyDrawer === document.querySelector('.history-drawer') && !window.historyWasHidden), 'background refresh replaced or hid the drawer');`);
      await capture('failed-grid');
      await command(['resize', '390', '844']);
      await check(`await page.click('[aria-label="List view"]');
        assert(await page.eval(() => !!document.querySelector('.artifact-list [role="alert"]')), 'list warning missing');`);
      await capture('failed-mobile-list');
      await unblockNext();
      await check(`await page.wait('.history-drawer .backup-status.protected');
        await page.wait('.version-row:nth-child(2)');
        assert((await page.eval(() => document.querySelector('.history-summary strong').textContent)) === '2', 'autosave version count stale');
        assert((await page.eval(() => document.querySelector('.version-row:first-child .version-title strong').textContent)) === 'Current protected version', 'autosave current label stale');
        assert(await page.eval(() => document.querySelector('.version-row:first-child .version-actions button:last-child').disabled), 'autosaved version is restorable');
        assert(await page.eval(() => !document.querySelector('.version-row:nth-child(2) .version-actions button:last-child').disabled), 'older version is not restorable');
        assert(await page.eval(() => !document.querySelector('[role="alert"]')), 'automatic recovery warning stale');`);
      await writeFile(file, '<title>Synthetic backup plan</title><h1>Third autosaved revision</h1>');
      await check(`await page.wait('.version-row:nth-child(3)');
        assert((await page.eval(() => document.querySelector('.history-summary strong').textContent)) === '3', 'later autosave version count stale');
        assert(await page.eval(() => document.querySelectorAll('.version-row.current').length === 1 && document.querySelector('.version-row:first-child').classList.contains('current')), 'later autosave current version stale');
        assert(await page.eval(() => [...document.querySelectorAll('.version-row:not(.current) .version-actions button:last-child')].every((button) => !button.disabled)), 'older restore eligibility stale');
        assert(await page.eval(() => window.historyDrawer === document.querySelector('.history-drawer') && !window.historyWasHidden), 'autosaves replaced or hid the drawer');
        await page.eval(() => window.historyObserver.disconnect());`);
      await configure(false);
      await check(`${refresh} assert((await page.eval(() => document.querySelector('.backup-status').textContent)).includes('Archive disabled'), 'disable did not clear protection');
        await page.wait('.history-empty');
        assert(await page.eval(() => !document.querySelector('.version-row')), 'manual refresh left the paused archive timeline');
        await page.click('[aria-label="Close version history"]');`);
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
