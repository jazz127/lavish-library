import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterLibraryArtifacts, getLibraryEmptyReason } from '../app/library-filters.ts';

const artifacts = [
  { projectId: 'alpha', title: 'Launch plan', description: 'Design', file: '/alpha/plan.html', sessionStatus: 'open' },
  { projectId: 'alpha', title: 'Research', description: 'Notes', file: '/alpha/notes.html', sessionStatus: 'discovered' },
  { projectId: 'beta', title: 'Decision record', description: 'Closed review', file: '/beta/decision.html', sessionStatus: 'ended' },
];

const defaults = { selectedProject: 'all', query: '', statusFilter: 'all', serverRunning: true };

for (const { name, items = artifacts, filter = {}, reason } of [
  { name: 'empty library keeps first-folder onboarding', items: [], reason: 'library' },
  { name: 'empty library with active filters still needs onboarding', items: [], filter: { query: 'missing', statusFilter: 'live' }, reason: 'library' },
  { name: 'unmatched search is a filter result', filter: { query: 'missing' }, reason: 'filters' },
  { name: 'empty Live filter is a filter result', filter: { statusFilter: 'live', serverRunning: false }, reason: 'filters' },
  { name: 'empty Discovered filter is a filter result', items: [artifacts[0]], filter: { statusFilter: 'discovered' }, reason: 'filters' },
  { name: 'selected project with no status matches is a filter result', filter: { selectedProject: 'beta', statusFilter: 'live' }, reason: 'filters' },
  { name: 'empty project differs from an empty library', filter: { selectedProject: 'empty' }, reason: 'project' },
  { name: 'empty selected project stays explicit even in an empty library', items: [], filter: { selectedProject: 'empty' }, reason: 'project' },
  { name: 'active filters do not hide an empty project', filter: { selectedProject: 'empty', query: 'missing', statusFilter: 'live' }, reason: 'project' },
  { name: 'combined project, search and status filters explain no matches', filter: { selectedProject: 'alpha', query: 'Research', statusFilter: 'live' }, reason: 'filters' },
]) {
  test(name, () => {
    const scope = { ...defaults, ...filter };
    assert.equal(filterLibraryArtifacts(items, scope).length, 0);
    assert.equal(getLibraryEmptyReason(items, scope.selectedProject), reason);
  });
}
