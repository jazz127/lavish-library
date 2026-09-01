import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countLibraryFilters, filterLibraryArtifacts } from '../app/library-filters.ts';

const artifacts = [
  { projectId: 'alpha', title: 'Alpha live', description: 'Launch plan', file: '/alpha/live.html', sessionStatus: 'open' },
  { projectId: 'alpha', title: 'Alpha draft', description: 'Research notes', file: '/alpha/draft.html', sessionStatus: 'discovered' },
  { projectId: 'alpha', title: 'Alpha closed', description: 'Decision record', file: '/alpha/closed.html', sessionStatus: 'ended' },
  { projectId: 'beta', title: 'Beta live', description: 'Launch plan', file: '/beta/live.html', sessionStatus: 'open' },
  { projectId: 'beta', title: 'Beta draft', description: 'Research notes', file: '/beta/draft.html', sessionStatus: 'discovered' },
];

test('filters artifacts by project and status', () => {
  const result = filterLibraryArtifacts(artifacts, {
    selectedProject: 'alpha',
    query: '',
    statusFilter: 'live',
    serverRunning: true,
  });
  assert.deepEqual(result.map((artifact) => artifact.title), ['Alpha live']);
});

test('counts each selector within the selected project and search', () => {
  const counts = countLibraryFilters(artifacts, {
    selectedProject: 'alpha',
    query: 'launch',
    serverRunning: true,
  });
  assert.deepEqual(counts, { all: 1, live: 1, discovered: 0 });
});

test('reports no live artifacts while the Lavish server is stopped', () => {
  const counts = countLibraryFilters(artifacts, {
    selectedProject: 'all',
    query: '',
    serverRunning: false,
  });
  assert.equal(counts.live, 0);
});
