export type FilterableArtifact = {
  projectId: string;
  title: string;
  description: string;
  file: string;
  sessionStatus: 'open' | 'feedback' | 'ended' | 'discovered';
  artifactFailures?: { kind: string; detail: string }[];
};

// Failures recorded for an ended review no longer need attention.
export function visibleArtifactFailures(artifact: Pick<FilterableArtifact, 'sessionStatus' | 'artifactFailures'>) {
  return artifact.sessionStatus === 'ended' ? [] : artifact.artifactFailures ?? [];
}

export type LibraryFilter = {
  selectedProject: string;
  query: string;
  statusFilter: 'all' | 'live' | 'discovered';
  serverRunning: boolean;
};

export type LibraryFilterScope = Omit<LibraryFilter, 'statusFilter'>;

// Call when the filtered list is empty; use the unfiltered library to explain why.
export function getLibraryEmptyReason(artifacts: FilterableArtifact[], selectedProject: string): 'library' | 'project' | 'filters' {
  if (selectedProject !== 'all' && !artifacts.some((artifact) => artifact.projectId === selectedProject)) return 'project';
  return artifacts.length === 0 ? 'library' : 'filters';
}

export function filterLibraryArtifacts<T extends FilterableArtifact>(artifacts: T[], filter: LibraryFilter) {
  const needle = filter.query.trim().toLowerCase();
  return artifacts.filter((artifact) => {
    const inProject = filter.selectedProject === 'all' || artifact.projectId === filter.selectedProject;
    const hasStatus = filter.statusFilter === 'all'
      || (filter.statusFilter === 'live' && artifact.sessionStatus === 'open' && filter.serverRunning)
      || (filter.statusFilter === 'discovered' && artifact.sessionStatus === 'discovered');
    return inProject && hasStatus && (!needle || `${artifact.title} ${artifact.description} ${artifact.file}`.toLowerCase().includes(needle));
  });
}

export function countLibraryFilters(artifacts: FilterableArtifact[], scope: LibraryFilterScope) {
  const scopedArtifacts = filterLibraryArtifacts(artifacts, { ...scope, statusFilter: 'all' });
  return {
    all: scopedArtifacts.length,
    live: scope.serverRunning ? scopedArtifacts.filter((artifact) => artifact.sessionStatus === 'open').length : 0,
    discovered: scopedArtifacts.filter((artifact) => artifact.sessionStatus === 'discovered').length,
  };
}
