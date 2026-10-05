import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fixture(run, { bin = '/usr/bin/true', health = null } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lavish-review-'));
  const lavishDir = path.join(directory, 'project', '.lavish');
  const stateDir = path.join(directory, 'state');
  const configDir = path.join(directory, 'config');
  await Promise.all([lavishDir, stateDir, configDir].map((dir) => mkdir(dir, { recursive: true })));
  const file = path.join(lavishDir, 'plan.html');
  await writeFile(file, '<title>Review plan</title>');
  const chat = [{ role: 'agent', text: 'Reply', at: '2026-09-01T00:00:00Z' }, { role: 'user', kind: 'input', text: 'Answer', at: '2026-09-02T00:00:00Z' }];
  await writeFile(path.join(stateDir, 'state.json'), JSON.stringify({ sessions: { demo: { file, status: 'open', chat } } }));
  await writeFile(path.join(configDir, 'config.json'), JSON.stringify({ projects: [], archiveRoot: null }));
  const port = await freePort();
  const upstream = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(health));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const service = spawn(process.execPath, ['scripts/local-api.mjs'], {
    env: { ...process.env, LAVISH_TRACKER_API_PORT: String(port), LAVISH_AXI_PORT: String(upstreamPort), LAVISH_AXI_STATE_DIR: stateDir, LAVISH_TRACKER_CONFIG_DIR: configDir, LAVISH_AXI_BIN: bin },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  service.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => service.once('exit', resolve));
  const api = `http://127.0.0.1:${port}/api`;
  const post = async (route, value) => fetch(`${api}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  try {
    for (let i = 0; i < 60; i += 1) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* Starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await run({ api, post, file, lavishDir, stateDir, configDir, upstreamPort });
  } catch (error) {
    error.message += `\nCompanion stderr: ${output}`;
    throw error;
  } finally {
    service.kill('SIGTERM');
    await exited;
    await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test('counts agent replies separately from structured reviewer messages', async () => {
  await fixture(async ({ api }) => {
    const library = await (await fetch(`${api}/library`)).json();
    assert.equal(library.artifacts[0].sessionMessages, 1);
    assert.equal(library.artifacts[0].lastUsedAt, '2026-09-02T00:00:00Z');
    const insights = await (await fetch(`${api}/insights?days=3650`)).json();
    assert.equal(insights.summary.sessionReplies, 1);
  });
});

test('probes the configured Lavish port and accepts older health responses', async () => {
  await fixture(async ({ api, upstreamPort }) => {
    const library = await (await fetch(`${api}/library`)).json();
    assert.equal(library.server.running, true);
    assert.equal(library.server.url, `http://127.0.0.1:${upstreamPort}`);
  }, { health: { app: 'lavish-axi', ok: true } });
});

test('recognizes the matching installation identity from upstream 0.1.78', async () => {
  const health = { app: 'lavish-axi', ok: true };
  await fixture(async ({ api, stateDir }) => {
    health.state_id = createHash('sha256').update(path.join(await realpath(stateDir), 'state.json')).digest('hex').slice(0, 16);
    const library = await (await fetch(`${api}/library`)).json();
    assert.equal(library.server.running, true);
    health.state_id = 'another-installation';
    const foreign = await (await fetch(`${api}/library`)).json();
    assert.equal(foreign.server.running, false);
  }, { health });
});

test('reports a missing CLI without killing the companion or recording an open', async () => {
  await fixture(async ({ api, post, file, configDir }) => {
    const response = await post('/artifacts/open', { file });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /ENOENT|could not launch/i);
    assert.equal((await fetch(`${api}/library`)).status, 200);
    const analytics = await readFile(path.join(configDir, 'analytics.json'), 'utf8').then(JSON.parse).catch(() => ({ events: [] }));
    assert.equal(analytics.events.filter((event) => event.type === 'open').length, 0);
  }, { bin: '/nonexistent/lavish-axi' });
});

test('explicit none clears an outcome while omitted fields retain feedback', async () => {
  await fixture(async ({ post, file }) => {
    await post('/artifacts/feedback', { file, value: 'useful', outcome: 'shipped', note: 'Original note' });
    const valueOnly = await (await post('/artifacts/feedback', { file, value: 'unfinished' })).json();
    assert.equal(valueOnly.feedback.outcome, 'shipped');
    const cleared = await (await post('/artifacts/feedback', { file, outcome: 'none', note: '' })).json();
    assert.equal(cleared.feedback.outcome, null);
    assert.equal(cleared.feedback.note, null);
    assert.equal(cleared.feedback.value, 'unfinished');
  });
});

// All sources and timestamps below are synthetic. Backdating fixture activity
// simulates an idle period without waiting 30 days or changing the API's clock.
async function dormantFixture(context, { replies = 0, revisions = false } = {}) {
  const { api, post, file, stateDir, configDir } = context;
  const old = new Date(Date.now() - 60 * 86_400_000);
  const chat = Array.from({ length: replies }, () => ({ role: 'agent', text: 'Reply', at: old.toISOString() }));
  await writeFile(path.join(stateDir, 'state.json'), JSON.stringify({ sessions: { demo: { file, updated_at: old.toISOString(), chat } } }));
  const get = async (route) => {
    const response = await fetch(`${api}${route}`);
    const result = await response.json();
    assert.equal(response.ok, true, result.error);
    return result;
  };
  const history = () => get(`/artifacts/versions?file=${encodeURIComponent(file)}`);
  if (revisions) {
    await writeFile(path.join(configDir, 'config.json'), JSON.stringify({ projects: [], archiveRoot: path.join(path.dirname(configDir), 'archive') }));
    assert.equal((await post('/artifacts/snapshot', { file })).ok, true);
    await writeFile(file, '<title>Review plan</title><p>Revised plan</p>');
    assert.equal((await post('/artifacts/snapshot', { file })).ok, true);
    const { archivePath, versions } = await history();
    assert.equal(versions.length, 2);
    const manifestFile = path.join(archivePath, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    for (const version of manifest.versions) version.createdAt = old.toISOString();
    await writeFile(manifestFile, JSON.stringify(manifest));
  }
  await utimes(file, old, old);
  const library = await get('/library');
  assert.equal(library.artifacts.length, 1);
  const artifact = library.artifacts[0];
  assert.equal(artifact.sessionMessages, replies);
  assert.equal(artifact.versionCount, revisions ? 2 : 0);
  const source = await readFile(file, 'utf8');
  const { archivePath, versions } = await history();
  const archivedBytes = await Promise.all(versions.map((version) => readFile(path.join(archivePath, version.file))));
  const analyticsFile = path.join(configDir, 'analytics.json');
  let savedFeedback;
  let changes = 0;
  const feedback = async (input) => {
    const response = await post('/artifacts/feedback', { file, ...input });
    assert.equal(response.ok, true);
    savedFeedback = (await response.json()).feedback;
    // Feedback is activity: freshly changed labels must not bypass dormancy.
    assert.equal((await get('/insights?days=3650')).dormant.length, 0);
    const analytics = JSON.parse(await readFile(analyticsFile, 'utf8'));
    analytics.feedback[artifact.id].updatedAt = old.toISOString();
    savedFeedback.updatedAt = old.toISOString();
    await writeFile(analyticsFile, JSON.stringify(analytics));
    changes += 1;
  };
  const assertEligible = async (eligible) => {
    const insights = await get('/insights?days=3650');
    assert.deepEqual(insights.dormant.map((item) => item.id), eligible ? [artifact.id] : []);
    const recommendation = insights.recommendations.find((item) => item.id === 'review-dormant');
    assert.equal(Boolean(recommendation), eligible);
    if (eligible) {
      assert.equal(recommendation.title, 'Revisit 1 dormant gem');
      assert.equal(recommendation.evidence, artifact.title);
    }
    assert.equal(insights.review.highlights.some((item) => item.tone === 'dormant'), eligible);
    assert.equal(insights.summary.totalArtifacts, 1);
    assert.equal(insights.summary.sessionReplies, replies);
    assert.equal(insights.summary.versions, versions.length);
    assert.equal((await get('/library')).artifacts[0].id, artifact.id);
    assert.equal(await readFile(file, 'utf8'), source);
    assert.deepEqual((await history()).versions, versions);
    assert.deepEqual(await Promise.all(versions.map((version) => readFile(path.join(archivePath, version.file)))), archivedBytes);
    if (savedFeedback) {
      const analytics = JSON.parse(await readFile(analyticsFile, 'utf8'));
      assert.deepEqual(analytics.feedback[artifact.id], savedFeedback);
      assert.equal(analytics.events.filter((event) => event.type === 'feedback').length, changes);
      assert.equal(insights.evolution.filter((event) => event.type === 'feedback').length, changes);
    }
  };
  return { assertEligible, feedback };
}

const dormantCases = [
  { name: 'abandoned outcome alone', feedback: { outcome: 'abandoned' }, eligible: false },
  { name: 'abandoned with replies', replies: 2, feedback: { outcome: 'abandoned' }, eligible: false },
  { name: 'abandoned with revisions', revisions: true, feedback: { outcome: 'abandoned' }, eligible: false },
  { name: 'disposable with replies', replies: 2, feedback: { value: 'disposable' }, eligible: false },
  { name: 'disposable with revisions', revisions: true, feedback: { value: 'disposable' }, eligible: false },
  { name: 'useful but abandoned', replies: 2, revisions: true, feedback: { value: 'useful', outcome: 'abandoned' }, eligible: false },
  { name: 'disposable but shipped', replies: 2, revisions: true, feedback: { value: 'disposable', outcome: 'shipped' }, eligible: false },
  { name: 'useful feedback alone', feedback: { value: 'useful' }, eligible: true },
  { name: 'shipped outcome alone', feedback: { outcome: 'shipped' }, eligible: true },
  { name: 'revisions alone', revisions: true, eligible: true },
  { name: 'replies alone', replies: 2, eligible: true },
  { name: 'no positive evidence', eligible: false },
];

for (const scenario of dormantCases) {
  test(`dormant suggestions respect ${scenario.name}`, async () => {
    await fixture(async (context) => {
      const dormant = await dormantFixture(context, scenario);
      if (scenario.feedback) await dormant.feedback(scenario.feedback);
      await dormant.assertEligible(scenario.eligible);
    });
  });
}

for (const evidence of [{ name: 'replies', replies: 2 }, { name: 'revisions', revisions: true }, { name: 'no engagement' }]) {
  test(`dormant eligibility recomputes after feedback changes with ${evidence.name}`, async () => {
    await fixture(async (context) => {
      const dormant = await dormantFixture(context, evidence);
      const hasEngagement = Boolean(evidence.replies || evidence.revisions);
      await dormant.assertEligible(hasEngagement);
      const changes = [
        [{ outcome: 'abandoned' }, false],
        [{ outcome: 'none' }, hasEngagement],
        [{ value: 'useful', outcome: 'abandoned' }, false],
        [{ outcome: 'none' }, true],
        [{ value: 'disposable', outcome: 'shipped' }, false],
        [{ value: 'unfinished' }, true],
        [{ outcome: 'abandoned' }, false],
        [{ outcome: 'reused' }, true],
        [{ value: 'disposable', outcome: 'none' }, false],
        [{ value: 'unfinished' }, hasEngagement],
      ];
      for (const [feedback, eligible] of changes) {
        await dormant.feedback(feedback);
        await dormant.assertEligible(eligible);
      }
    });
  });
}

test('dormant recommendations count only eligible artifacts in a mixed library', async () => {
  await fixture(async (context) => {
    const { api, post, file, lavishDir, stateDir, configDir } = context;
    const dormant = await dormantFixture(context, { replies: 2 });
    await dormant.feedback({ value: 'useful' });
    const old = new Date(Date.now() - 60 * 86_400_000);
    const sessions = JSON.parse(await readFile(path.join(stateDir, 'state.json'), 'utf8')).sessions;
    for (const name of ['abandoned', 'disposable']) {
      const negativeFile = path.join(lavishDir, `${name}.html`);
      await writeFile(negativeFile, `<title>${name} work</title>`);
      await utimes(negativeFile, old, old);
      sessions[name] = { file: negativeFile, updated_at: old.toISOString(), chat: sessions.demo.chat };
    }
    await writeFile(path.join(stateDir, 'state.json'), JSON.stringify({ sessions }));
    assert.equal((await fetch(`${api}/library`)).ok, true);
    assert.equal((await post('/artifacts/feedback', { file: sessions.abandoned.file, value: 'useful', outcome: 'abandoned' })).ok, true);
    assert.equal((await post('/artifacts/feedback', { file: sessions.disposable.file, value: 'disposable', outcome: 'shipped' })).ok, true);
    const analyticsFile = path.join(configDir, 'analytics.json');
    const analytics = JSON.parse(await readFile(analyticsFile, 'utf8'));
    for (const feedback of Object.values(analytics.feedback)) feedback.updatedAt = old.toISOString();
    await writeFile(analyticsFile, JSON.stringify(analytics));
    const response = await fetch(`${api}/insights?days=3650`);
    assert.equal(response.ok, true);
    const insights = await response.json();
    assert.deepEqual(insights.dormant.map((item) => item.file), [file]);
    const recommendation = insights.recommendations.find((item) => item.id === 'review-dormant');
    assert.equal(recommendation.title, 'Revisit 1 dormant gem');
    assert.equal(recommendation.evidence, 'Review plan');
    assert.equal(insights.summary.totalArtifacts, 3);
  });
});

test('does not discover generated exports unless they are explicitly in session history', async () => {
  await fixture(async ({ api, file, lavishDir, stateDir }) => {
    await writeFile(path.join(lavishDir, 'plan.export.html'), '<title>Portable copy</title>');
    let library = await (await fetch(`${api}/library`)).json();
    assert.equal(library.artifacts.length, 1);
    const exported = path.join(lavishDir, 'plan.export.html');
    await writeFile(path.join(stateDir, 'state.json'), JSON.stringify({ sessions: { original: { file }, exported: { file: exported } } }));
    library = await (await fetch(`${api}/library`)).json();
    assert.equal(library.artifacts.length, 2);
  });
});

test('a missing site launcher exits nonzero and terminates the companion API', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lavish-launch-'));
  await mkdir(path.join(directory, 'scripts'));
  await writeFile(path.join(directory, 'scripts', 'local-api.mjs'), 'setInterval(() => {}, 1000);');
  const launcher = spawn(process.execPath, [path.resolve('scripts/run-local.mjs'), 'dev'], { cwd: directory, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    let stderr = '';
    launcher.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('companion API kept the launcher output open')), 5000);
      launcher.on('close', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
    });
    assert.equal(code, 1);
    assert.match(stderr, /Could not launch the local app/);
  } finally {
    launcher.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});
