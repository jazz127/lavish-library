export type FilterableArtifact = {
  projectId: string;
  title: string;
  description: string;
  file: string;
  sessionStatus: 'open' | 'feedback' | 'ended' | 'discovered';
};

export type LibraryFilter = {
  selectedProject: string;
  query: string;
  statusFilter: 'all' | 'live' | 'discovered';
  serverRunning: boolean;
};

export type LibraryFilterScope = Omit<LibraryFilter, 'statusFilter'>;

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
