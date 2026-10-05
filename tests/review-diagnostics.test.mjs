import assert from 'node:assert/strict';
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { artifactFailures, revisionContext, revealServerLog, serverLogPath } from '../scripts/review-diagnostics.mjs';
import { countLibraryFilters, filterLibraryArtifacts, visibleArtifactFailures } from '../app/library-filters.ts';
import { diagnosticsFixture } from './helpers/diagnostics-fixture.mjs';

const failures = [
  { kind: 'artifact-unavailable', detail: 'The artifact returned HTTP 500.', severity: 'fatal' },
  { kind: 'artifact-asset-unavailable', detail: 'styles.css returned HTTP 404.', severity: 'fatal' },
];
const context = [{ id: 'r2', label: 'Clarify launch ownership', timestamp: '2026-10-02T00:00:00Z', summary: 'Named an owner for each launch task.' }];
const html = (entries) => `<title>Launch review</title><script type="application/json" data-lavish-revisions>${JSON.stringify(entries)}</script><h1 data-lavish-revision="r2">Launch review</h1>`;
const fixture = async (run, options) => {
  const value = await diagnosticsFixture(options);
  try { await run(value); } finally { await value.close(); }
};

test('synthetic: a healthy server retains per-artifact fatal load and asset diagnostics', async () => {
  await fixture(async ({ api, session, writeState }) => {
    const library = await (await fetch(`${api}/library`)).json();
    assert.equal(library.server.running, true);
    assert.deepEqual(library.artifacts[0].artifactFailures, failures.map(({ kind, detail }) => ({ kind, detail })));
    await writeState({ ...session, artifact_failures: [] });
    const refreshed = await (await fetch(`${api}/library`)).json();
    assert.deepEqual(refreshed.artifacts[0].artifactFailures, []);
  }, { session: { artifact_failures: failures } });
});

test('synthetic: revision context follows saved bytes rather than the current source', async () => {
  await fixture(async ({ api, file }) => {
    await fetch(`${api}/library`);
    await writeFile(file, html([{ ...context[0], id: 'r3', label: 'Update launch date' }]));
    await fetch(`${api}/library`);
    const history = await (await fetch(`${api}/artifacts/versions?file=${encodeURIComponent(file)}`)).json();
    assert.equal(history.versions.length, 2);
    assert.equal(history.versions[0].revisionContext[0].id, 'r3');
    assert.deepEqual(history.versions[1].revisionContext, context);
    await rm(file);
    const missing = await (await fetch(`${api}/artifacts/versions?file=${encodeURIComponent(file)}`)).json();
    assert.deepEqual(missing.versions[1].revisionContext, context);
    const unreadable = path.join(missing.archivePath, path.dirname(missing.versions[1].file));
    await chmod(unreadable, 0);
    try {
      const response = await fetch(`${api}/artifacts/versions?file=${encodeURIComponent(file)}`);
      assert.equal(response.status, 200);
      const degraded = await response.json();
      assert.deepEqual(degraded.versions[1].revisionContext, []);
      assert.equal(degraded.versions[0].revisionContext[0].id, 'r3');
    } finally { await chmod(unreadable, 0o755); }
  }, { html: html(context) });
});

test('synthetic: server log availability survives an unavailable server and rejects browser paths', async () => {
  await fixture(async ({ api, stateDir }) => {
    const library = await (await fetch(`${api}/library`)).json();
    assert.equal(library.server.running, false);
    assert.equal(library.server.logAvailable, true);
    const unauthorized = await fetch(`${api}/server/reveal-log`, { method: 'POST', headers: { origin: 'http://localhost:3000' } });
    assert.equal(unauthorized.status, 401);
    await rm(path.join(stateDir, 'server.log'));
    const response = await fetch(`${api}/server/reveal-log`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: '/some/other.log' }) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /No local server.log/);
    assert.equal((await (await fetch(`${api}/library`)).json()).server.logAvailable, undefined);
  }, { log: true, health: { app: 'other-service' } });
});

test('synthetic: older Lavish data adds no warnings, revision declarations or log action', async () => {
  await fixture(async ({ api, file }) => {
    const library = await (await fetch(`${api}/library`)).json();
    assert.equal(library.server.running, true);
    assert.deepEqual(library.artifacts[0].artifactFailures ?? [], []);
    assert.equal(library.server.logAvailable, undefined);
    const history = await (await fetch(`${api}/artifacts/versions?file=${encodeURIComponent(file)}`)).json();
    assert.deepEqual(history.versions[0].revisionContext ?? [], []);
  });
});

test('failed open sessions stay in Live alongside older open sessions', () => {
  const artifacts = [
    { projectId: 'demo', title: 'Failed', description: '', file: '/demo/fail.html', sessionStatus: 'open', artifactFailures: failures },
    { projectId: 'demo', title: 'Older session', description: '', file: '/demo/old.html', sessionStatus: 'open' },
  ];
  const filter = { selectedProject: 'all', query: '', serverRunning: true, statusFilter: 'live' };
  assert.deepEqual(filterLibraryArtifacts(artifacts, filter).map((artifact) => artifact.title), ['Failed', 'Older session']);
  assert.equal(countLibraryFilters(artifacts, filter).live, 2);
});

test('artifact failures stay beside waiting feedback and clear once the review has ended', () => {
  assert.equal(visibleArtifactFailures({ sessionStatus: 'feedback', artifactFailures: failures }).length, 2);
  assert.deepEqual(visibleArtifactFailures({ sessionStatus: 'ended', artifactFailures: failures }), []);
  assert.deepEqual(visibleArtifactFailures({ sessionStatus: 'open' }), []);
});

test('fatal diagnostics ignore absent, malformed and layout-only payloads and bound details', () => {
  for (const session of [null, {}, { artifact_failures: {} }, { artifact_failures: [null, { kind: 'overflow' }] }]) assert.deepEqual(artifactFailures(session), []);
  assert.equal(artifactFailures({ artifact_failures: [{ kind: 'artifact-unavailable', detail: 'x'.repeat(500) }] })[0].detail.length, 300);
  assert.equal(artifactFailures({ artifact_failures: Array(50).fill(failures[0]) }).length, 20);
});

test('revision registries degrade gracefully, deduplicate exact IDs and bound untrusted text', () => {
  for (const source of ['', '<script data-lavish-revisions>{bad}</script>', html({}), '<!--' + html(context) + '-->', '<textarea>' + html(context) + '</textarea>', '<div title="<script data-lavish-revisions>[]</script>"></div>', '<script title="data-lavish-revisions">[]</script>']) assert.deepEqual(revisionContext(source), []);
  assert.deepEqual(revisionContext(html(context)), context);
  const entries = [null, { id: 'bad id' }, { id: 'x'.repeat(61) }, { id: '__proto__' }, { id: '__proto__' }, ...Array.from({ length: 10 }, (_, id) => ({ id, label: 'x'.repeat(90), summary: 'x'.repeat(500) }))];
  const result = revisionContext(html(entries));
  assert.equal(result.length, 6);
  assert.equal(result[0].id, '__proto__');
  assert.equal(result[1].label.length, 80);
  assert.equal(result[1].summary.length, 400);
  assert.deepEqual(revisionContext(html([{ id: 'r1', summary: 'x'.repeat(65536) }])), []);
});

test('reveal log dispatches the fixed configured file and refuses missing, directory and symlink entries', async () => {
  await fixture(async ({ stateDir }) => {
    const calls = [];
    const launch = async (...args) => { calls.push(args); };
    await revealServerLog(stateDir, launch);
    assert.deepEqual(calls, [['/usr/bin/open', ['-R', path.join(stateDir, 'server.log')]]]);
    await rm(path.join(stateDir, 'server.log'));
    await mkdir(path.join(stateDir, 'server.log'));
    assert.equal(await serverLogPath(stateDir), null);
    await rm(path.join(stateDir, 'server.log'), { recursive: true });
    await symlink('state.json', path.join(stateDir, 'server.log'));
    await assert.rejects(revealServerLog(stateDir, launch), /No local server.log/);
    assert.equal(calls.length, 1);
  }, { log: true });
});
