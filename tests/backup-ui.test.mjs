import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { backupFixture, freePort } from './helpers/backup-fixture.mjs';

// Opt in with LAVISH_BACKUP_UI_TEST=1. The actual Home component and apiFetch
// run against a synthetic companion fixture in an isolated browser session.
test('synthetic browser covers backup states, refresh notices and slow history', { skip: process.env.LAVISH_BACKUP_UI_TEST !== '1' }, async () => {
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
  await backupFixture(async ({ api, file, configure, library, blockFirst, unblockFirst, blockNext, unblockNext, setUnreadableFiles }) => {
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
      page.wait = async (target, timeout = 10000) => page.eval('() => new Promise((resolve, reject) => { const ready = ' + (typeof target === 'function' ? target.toString() : '() => !!document.querySelector(' + JSON.stringify(target) + ')') + '; const until = Date.now() + ' + timeout + '; const poll = () => { if (ready()) return resolve(); if (Date.now() > until) return reject(new Error("Timed out: " + ' + JSON.stringify(String(target)) + ')); setTimeout(poll, 25); }; poll(); })');
      page.click = async (selector) => page.eval('() => { const element = document.querySelector(' + JSON.stringify(selector) + '); if (!element) throw new Error("Missing control"); element.click(); }');
      ${script}
    `);
    const refresh = `await page.click('[aria-label="Refresh library"]'); await page.wait('.artifact-card');`;
    const restorableHistory = `await page.wait(() => { const buttons = document.querySelectorAll('.version-actions button:last-child'); return buttons.length > 0 && !document.querySelector('.version-row.current') && [...buttons].every((button) => !button.disabled); });`;
    const refreshApplied = `await page.wait(() => {
      const fixture = window.refreshNotices;
      const count = fixture.successes[fixture.target];
      if (count < fixture.expected) return false;
      return fixture.target === 'library'
        ? document.querySelector('.description')?.textContent === 'Library recovery ' + count
        : document.querySelector('.version-row:first-child .version-content > p')?.textContent.includes((10000 + count).toLocaleString() + ' lines');
    });`;
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
        ${restorableHistory}
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
      for (const failure of ['html', 'asset']) {
        const assetFile = path.join(path.dirname(file), 'protected-asset.png');
        await writeFile(assetFile, `Saved asset for ${failure}`);
        const content = `<title>Synthetic backup plan</title><img src="protected-asset.png"><h1>Protected before ${failure} read failure</h1>`;
        await writeFile(file, content);
        const protectedArtifact = (await library()).artifacts[0];
        const count = protectedArtifact.versionCount;
        await check(`await page.wait('.version-row:nth-child(${count})');
          assert(await page.eval(() => document.querySelector('.version-row:first-child').classList.contains('current')), 'readable bundle did not match');
          await page.eval(() => { window.readFailureDrawer = document.querySelector('.history-drawer'); window.readFailureTimeline = document.querySelector('.timeline'); });`);
        await setUnreadableFiles([failure === 'html' ? file : assetFile]);
        await writeFile(file, `${content}<p>Pending edit during read failure</p>`);
        await check(`await page.wait('.history-drawer .backup-status.failed');
          ${restorableHistory}
          assert(await page.eval(() => !document.querySelector('.version-row.current')), '${failure} read failure left a current version');
          assert(await page.eval(() => [...document.querySelectorAll('.version-title strong')].every((label) => !label.textContent.includes('Current protected'))), '${failure} read failure left a protected label');
          assert(await page.eval(() => [...document.querySelectorAll('.version-actions button:last-child')].every((button) => !button.disabled)), '${failure} read failure disabled restore');
          assert((await page.eval(() => document.querySelector('.history-summary strong').textContent)) === ${JSON.stringify(String(count))}, '${failure} read failure dropped saved copies');
          assert((await page.eval(() => document.querySelector('.history-drawer [role="alert"]').textContent)).includes('EACCES'), '${failure} read failure warning missing');
          assert((await page.eval(() => document.querySelector('.history-drawer time').getAttribute('datetime'))) === ${JSON.stringify(protectedArtifact.lastBackedUpAt)}, '${failure} read failure lost last success');
          assert(await page.eval(() => window.readFailureDrawer === document.querySelector('.history-drawer') && window.readFailureTimeline === document.querySelector('.timeline') && !document.querySelector('.history-loading')), '${failure} read failure hid the drawer');
          await page.click('[aria-label="Close version history"]');
          await page.click('.history-chip');
          ${restorableHistory}
          assert((await page.eval(() => document.querySelector('.history-summary strong').textContent)) === ${JSON.stringify(String(count))}, 'initial ${failure} failure dropped saved copies');
          assert(await page.eval(() => !document.querySelector('.history-empty') && !document.querySelector('.version-row.current')), 'initial ${failure} failure showed an unconfigured archive or current copy');`);
        await setUnreadableFiles([]);
        await check(`await page.wait('.version-row:nth-child(${count + 1})');
          await page.wait('.history-drawer .backup-status.protected');
          assert(await page.eval(() => document.querySelectorAll('.version-row.current').length === 1 && document.querySelector('.version-row:first-child').classList.contains('current')), 'readable ${failure} recovery did not match');
          assert(await page.eval(() => document.querySelector('.version-row.current .version-actions button:last-child').disabled), 'readable ${failure} recovery left restore enabled');`);
      }
      await check(`await page.click('[aria-label="Close version history"]');
        await page.wait(() => !document.querySelector('.history-drawer'));
        await page.eval(() => {
          const original = window.fetch;
          window.slowHistory = { originalFetch: original, records: [], pending: 0, maxPending: 0, completed: 0, aborted: 0, libraryResponses: 0 };
          window.fetch = async (...args) => {
            const response = await original(...args);
            const url = String(args[0]);
            if (url.endsWith('/library')) window.slowHistory.libraryResponses += 1;
            if (!url.includes('/artifacts/versions?')) return response;
            const body = await response.text();
            const record = { startedAt: Date.now(), libraryResponses: window.slowHistory.libraryResponses };
            window.slowHistory.records.push(record);
            window.slowHistory.pending += 1;
            window.slowHistory.maxPending = Math.max(window.slowHistory.maxPending, window.slowHistory.pending);
            return new Promise((resolve, reject) => {
              const signal = args[1]?.signal;
              const abort = () => {
                clearTimeout(timer);
                window.slowHistory.pending -= 1;
                window.slowHistory.aborted += 1;
                reject(new DOMException('Aborted', 'AbortError'));
              };
              const timer = setTimeout(() => {
                signal?.removeEventListener('abort', abort);
                window.slowHistory.pending -= 1;
                window.slowHistory.completed += 1;
                record.completedAt = Date.now();
                record.completedLibraryResponses = window.slowHistory.libraryResponses;
                resolve(new Response(body, { status: response.status, headers: response.headers }));
              }, 6000);
              if (signal?.aborted) abort();
              else signal?.addEventListener('abort', abort, { once: true });
            });
          };
        });
        await page.click('.history-chip'); await page.wait('.history-loading');
        await page.wait('.version-row.current', 15000);
        assert(await page.eval(() => window.slowHistory.aborted === 0 && window.slowHistory.completed >= 1), 'library polling starved initial history loading');
        assert(await page.eval(() => window.slowHistory.records[0].completedAt - window.slowHistory.records[0].startedAt > 5000 && window.slowHistory.records[0].completedLibraryResponses > window.slowHistory.records[0].libraryResponses), 'initial history did not overlap a library update');
        await page.wait(() => window.slowHistory.records.length >= 2);
        await page.eval(() => { window.slowDrawer = document.querySelector('.history-drawer'); window.slowTimeline = document.querySelector('.timeline'); });
        await page.click('.history-chip');
        assert(await page.eval(() => window.slowDrawer === document.querySelector('.history-drawer') && window.slowTimeline === document.querySelector('.timeline') && !document.querySelector('.history-loading') && window.slowHistory.aborted === 0), 'selecting the same artifact restarted history');`);
      const slowCount = (await library()).artifacts[0].versionCount;
      await blockNext();
      await writeFile(file, '<title>Synthetic backup plan</title><h1>Unprotected slow-history edit</h1>');
      await check(`await page.wait('.history-drawer .backup-status.failed');
        await page.wait(() => { const buttons = document.querySelectorAll('.version-actions button:last-child'); return buttons.length > 0 && !document.querySelector('.version-row.current') && [...buttons].every((button) => !button.disabled); }, 25000);
        assert((await page.eval(() => document.querySelector('.history-summary strong').textContent)) === ${JSON.stringify(String(slowCount))}, 'slow refresh dropped saved versions');
        assert(await page.eval(() => [...document.querySelectorAll('.version-title strong')].every((label) => !label.textContent.includes('Current protected'))), 'slow refresh retained protected labels');
        assert(await page.eval(() => window.slowHistory.completed >= 3 && window.slowHistory.aborted === 0 && window.slowHistory.maxPending === 1), 'newer library state was not coalesced after the active request');
        assert(await page.eval(() => window.slowDrawer === document.querySelector('.history-drawer') && window.slowTimeline === document.querySelector('.timeline') && !document.querySelector('.history-loading')), 'slow refresh hid the existing drawer');`);
      await unblockNext();
      await check(`await page.wait(() => document.querySelector('.history-summary strong')?.textContent === ${JSON.stringify(String(slowCount + 1))} && document.querySelector('.version-row:first-child')?.classList.contains('current') && !!document.querySelector('.history-drawer .backup-status.protected'), 25000);
        assert(await page.eval(() => document.querySelector('.version-row.current .version-actions button:last-child').disabled), 'slow autosave recovery left restore enabled');
        assert(await page.eval(() => window.slowHistory.aborted === 0 && window.slowHistory.maxPending === 1), 'slow same-artifact refresh was cancelled or overlapped');
        await page.wait(() => window.slowHistory.pending === 1);
        await page.eval(() => { window.completedBeforeClose = window.slowHistory.completed; window.requestsBeforeClose = window.slowHistory.records.length; window.libraryBeforeClose = window.slowHistory.libraryResponses; });
        await page.click('[aria-label="Close version history"]');
        await page.wait(() => window.slowHistory.aborted === 1 && window.slowHistory.pending === 0);
        await page.wait(() => window.slowHistory.libraryResponses > window.libraryBeforeClose);
        assert(await page.eval(() => !document.querySelector('.history-drawer') && window.slowHistory.completed === window.completedBeforeClose && window.slowHistory.records.length === window.requestsBeforeClose), 'closed drawer published or queued history');
        await page.eval(() => { window.fetch = window.slowHistory.originalFetch; });
        await page.click('.history-chip'); await page.wait('.version-row.current');`);
      await check(`await page.eval(() => {
        const original = window.fetch;
        window.refreshNotices = { originalFetch: original, failure: null, successes: { library: 0, history: 0 }, actionMessage: 'Unrelated action notice' };
        window.fetch = async (...args) => {
          const url = String(args[0]);
          const source = url.endsWith('/library') ? 'library' : url.includes('/artifacts/versions?') ? 'history' : null;
          if (url.endsWith('/artifacts/reveal')) return new Response(JSON.stringify({ error: window.refreshNotices.actionMessage }), { status: 400 });
          if (source && window.refreshNotices.failure === source) return new Response(JSON.stringify({ error: 'Synthetic history refresh outage' }), { status: 503 });
          const response = await original(...args);
          if (!source || !response.ok) return response;
          const value = await response.json();
          const count = ++window.refreshNotices.successes[source];
          if (source === 'library') value.artifacts[0].description = 'Library recovery ' + count;
          else value.versions[0].lineCount = 10000 + count;
          return new Response(JSON.stringify(value), { status: response.status, headers: response.headers });
        };
      });`);
      for (const source of ['library', 'history']) {
        const message = source === 'library' ? 'The local library service did not respond.' : 'Synthetic history refresh outage';
        await check(`await page.eval(() => { window.refreshNotices.failure = ${JSON.stringify(source)}; });
          await page.wait(() => document.querySelector('.notice')?.textContent === ${JSON.stringify(message)});
          await page.eval(() => { window.refreshNotices.target = ${JSON.stringify(source)}; window.refreshNotices.expected = window.refreshNotices.successes[${JSON.stringify(source)}] + 1; window.refreshNotices.failure = null; });
          ${refreshApplied}
          await page.wait(() => !document.querySelector('.notice'));
          assert(await page.eval(() => !!document.querySelector('.version-row.current')), 'refresh recovery dropped the drawer');`);
        await check(`await page.eval(() => { window.refreshNotices.failure = ${JSON.stringify(source)}; });
          await page.wait(() => document.querySelector('.notice')?.textContent === ${JSON.stringify(message)});
          await page.click('[aria-label="Reveal in Finder"]');
          await page.wait(() => document.querySelector('.notice')?.textContent === window.refreshNotices.actionMessage);
          await page.eval(() => { window.refreshNotices.expected = window.refreshNotices.successes[${JSON.stringify(source)}] + 1; window.refreshNotices.failure = null; });
          ${refreshApplied}
          assert(await page.eval(() => document.querySelector('.notice')?.textContent === window.refreshNotices.actionMessage), '${source} recovery cleared an unrelated action notice');`);
      }
      await check(`await page.eval(() => { window.fetch = window.refreshNotices.originalFetch; });`);
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
  }, { uiPort, readFailures: true });
});
