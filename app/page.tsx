'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import InsightsView from './insights-view';
import ArtifactPreview from './artifact-preview';
import BackupStatus, { isLatestProtected } from './backup-status';
import { apiFetch } from './api-client';
import { countLibraryFilters, filterLibraryArtifacts, getLibraryEmptyReason, visibleArtifactFailures } from './library-filters';

type Project = {
  id: string;
  name: string;
  path: string;
  source: 'added' | 'automatic';
  exists: boolean;
  artifactCount: number;
};

type Artifact = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  file: string;
  relativePath: string;
  modifiedAt: string | null;
  lastUsedAt: string | null;
  size: number;
  exists: boolean;
  sessionStatus: 'open' | 'feedback' | 'ended' | 'discovered';
  pendingPrompts: number;
  url: string | null;
  endedBy: 'user' | 'agent' | null;
  sessionMessages: number;
  versionCount: number;
  lastBackedUpAt: string | null;
  backupError: string | null;
  artifactFailures?: { kind: string; detail: string }[];
};

type RevisionContext = { id: string; label: string; timestamp: string; summary: string };

type ArchivedVersion = {
  id: string;
  createdAt: string;
  sourceModifiedAt: string;
  size: number;
  lineCount: number;
  assetsCopied: number;
  reason: 'scan' | 'change' | 'manual' | 'pre-restore' | 'restore';
  isCurrent: boolean;
  sizeDelta: number;
  lineDelta: number;
  revisionContext?: RevisionContext[];
};

type VersionHistory = {
  enabled: boolean;
  archivePath?: string;
  sourceFile?: string;
  sourceExists?: boolean;
  versions: ArchivedVersion[];
};

type Library = {
  projects: Project[];
  artifacts: Artifact[];
  server: { running: boolean; url: string; logAvailable?: boolean };
  archive: {
    enabled: boolean;
    root: string | null;
    path: string | null;
    totalVersions: number;
    protectedArtifacts: number;
    failedArtifacts: number;
    unprotectedArtifacts: number;
  };
  scannedAt: string;
};

type SortMode = 'recent' | 'edited' | 'name';
type StatusFilter = 'all' | 'live' | 'discovered';
type PageSection = 'library' | 'observatory' | 'review';

function relativeTime(value: string | null) {
  if (!value) return 'Never opened';
  const delta = Date.now() - new Date(value).getTime();
  if (delta < 60_000) return 'Just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short' }).format(new Date(value));
}

function formatSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function statusLabel(artifact: Artifact, serverRunning: boolean) {
  if (!artifact.exists) return 'Missing';
  if (artifact.sessionStatus === 'ended') return 'Review ended';
  if (artifact.pendingPrompts > 0 || artifact.sessionStatus === 'feedback') return 'Feedback waiting';
  if (artifact.sessionStatus === 'open' && serverRunning) return 'Live';
  if (artifact.sessionStatus === 'open') return 'Ready to resume';
  return 'Discovered';
}

function fullDate(value: string) {
  return new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function deltaLabel(value: number, unit: string) {
  if (!value) return `No ${unit} change`;
  return `${value > 0 ? '+' : ''}${value} ${unit}`;
}

function Icon({ name }: { name: 'spark' | 'folder' | 'search' | 'refresh' | 'plus' | 'grid' | 'list' | 'arrow' | 'more' | 'clock' | 'file' | 'archive' | 'history' | 'close' | 'restore' }) {
  const symbols = { spark: '✦', folder: '⌑', search: '⌕', refresh: '↻', plus: '+', grid: '⊞', list: '☷', arrow: '↗', more: '•••', clock: '◷', file: '◇', archive: '▣', history: '↶', close: '×', restore: '↺' };
  return <span aria-hidden="true" className={`icon icon-${name}`}>{symbols[name]}</span>;
}

export default function Home() {
  const [library, setLibrary] = useState<Library | null>(null);
  const [selectedProject, setSelectedProject] = useState('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('recent');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [section, setSection] = useState<PageSection>('library');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | { source: 'library' | 'history' | 'manual-folder' | 'archive-pause'; message: string }>('');
  const noticeMessage = typeof notice === 'string' ? notice : notice.message;
  const [manualPath, setManualPath] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [historyArtifact, setHistoryArtifact] = useState<Artifact | null>(null);
  const [history, setHistory] = useState<VersionHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [backingUp, setBackingUp] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const trackedSearchRef = useRef('');
  const libraryRequestRef = useRef<Promise<Library | undefined> | null>(null);
  const historyRefreshRef = useRef<(() => Promise<void>) | null>(null);
  const historyFile = historyArtifact?.file;

  const loadLibrary = useCallback(async (quiet = false, signal?: AbortSignal): Promise<Library | undefined> => {
    if (!quiet) setLoading(true);
    const fetchLibrary = async (): Promise<Library | undefined> => {
      try {
        const response = await apiFetch('/library', { cache: 'no-store', signal });
        if (!response.ok) throw new Error('The local library service did not respond.');
        const value: Library = await response.json();
        if (!signal?.aborted && request === libraryRequestRef.current) {
          setLibrary(value);
          setNotice((current) => typeof current !== 'string' && current.source === 'library' ? '' : current);
        }
        return value;
      } catch (error) {
        if (!signal?.aborted && request === libraryRequestRef.current) {
          setNotice({ source: 'library', message: error instanceof Error ? error.message : 'Could not load your library.' });
        }
      } finally {
        if (!signal?.aborted && request === libraryRequestRef.current) setLoading(false);
      }
    };
    const request = fetchLibrary();
    libraryRequestRef.current = request;
    let latest = request;
    for (;;) {
      const value = await latest;
      if (latest === libraryRequestRef.current) return value;
      latest = libraryRequestRef.current!;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState === 'hidden') return;
      document.removeEventListener('visibilitychange', refresh);
      pending = true;
      try {
        await loadLibrary(true, controller.signal);
      } finally {
        pending = false;
      }
    };
    document.addEventListener('visibilitychange', refresh);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [loadLibrary]);

  useEffect(() => {
    if (!historyFile) return;
    const controller = new AbortController();
    let pending = false;
    let queued = false;
    const refresh = async () => {
      if (pending) {
        queued = true;
        return;
      }
      pending = true;
      try {
        const response = await apiFetch(`/artifacts/versions?file=${encodeURIComponent(historyFile)}`, { cache: 'no-store', signal: controller.signal });
        const result: VersionHistory & { error?: string } = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not load version history.');
        if (!controller.signal.aborted) {
          setHistory(result);
          setNotice((current) => typeof current !== 'string' && current.source === 'history' ? '' : current);
        }
      } catch (error) {
        if (!controller.signal.aborted) setNotice({ source: 'history', message: error instanceof Error ? error.message : 'Could not load version history.' });
      } finally {
        pending = false;
        if (!controller.signal.aborted) {
          setHistoryLoading(false);
          if (queued) {
            queued = false;
            void refresh();
          }
        }
      }
    };
    historyRefreshRef.current = refresh;
    void refresh();
    return () => {
      controller.abort();
      historyRefreshRef.current = null;
    };
  }, [historyFile]);

  useEffect(() => {
    if (library) void historyRefreshRef.current?.();
  }, [library]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSection('library');
        window.setTimeout(() => searchRef.current?.focus(), 0);
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  const artifacts = useMemo(() => {
    const items = filterLibraryArtifacts([...(library?.artifacts ?? [])], {
      selectedProject,
      query,
      statusFilter,
      serverRunning: Boolean(library?.server.running),
    });
    items.sort((a, b) => {
      if (sort === 'name') return a.title.localeCompare(b.title);
      const aDate = sort === 'edited' ? a.modifiedAt : a.lastUsedAt ?? a.modifiedAt;
      const bDate = sort === 'edited' ? b.modifiedAt : b.lastUsedAt ?? b.modifiedAt;
      return new Date(bDate ?? 0).getTime() - new Date(aDate ?? 0).getTime();
    });
    return items;
  }, [library, query, selectedProject, sort, statusFilter]);

  const filterCounts = useMemo(() => countLibraryFilters(library?.artifacts ?? [], {
    selectedProject,
    query,
    serverRunning: Boolean(library?.server.running),
  }), [library, query, selectedProject]);

  useEffect(() => {
    const normalized = query.trim().toLowerCase();
    if (section !== 'library' || normalized.length < 2 || trackedSearchRef.current === normalized) return;
    const timer = window.setTimeout(() => {
      trackedSearchRef.current = normalized;
      void apiFetch('/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'search', query: query.trim(), resultCount: artifacts.length, projectId: selectedProject }),
      });
    }, 750);
    return () => window.clearTimeout(timer);
  }, [artifacts.length, query, section, selectedProject]);

  function selectProject(projectId: string) {
    setSection('library');
    setSelectedProject(projectId);
    void apiFetch('/events', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'project_view', projectId }),
    });
  }

  async function chooseFolder() {
    setNotice('Opening the folder picker…');
    try {
      const response = await apiFetch('/projects/choose', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not add that folder.');
      setShowAdd(false);
      if (await loadLibrary(true)) setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not add that folder.');
    }
  }

  async function addManualFolder(event: React.FormEvent) {
    event.preventDefault();
    try {
      const response = await apiFetch('/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: manualPath }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not add that folder.');
      setManualPath('');
      setShowAdd(false);
      setNotice((current) => typeof current !== 'string' && current.source === 'manual-folder' ? '' : current);
      await loadLibrary(true);
    } catch (error) {
      setNotice({ source: 'manual-folder', message: error instanceof Error ? error.message : 'Could not add that folder.' });
    }
  }

  async function openArtifact(artifact: Artifact) {
    setNotice(`Opening “${artifact.title}”…`);
    try {
      const response = await apiFetch('/artifacts/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: artifact.file, reopen: artifact.sessionStatus === 'ended' && artifact.endedBy === 'user', query: query.trim() || null }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Lavish could not be opened.');
      setNotice('');
      window.setTimeout(() => void loadLibrary(true), 900);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Lavish could not be opened.');
    }
  }

  async function revealArtifact(artifact: Artifact) {
    setNotice(`Revealing “${artifact.title}” in Finder…`);
    try {
      const response = await apiFetch('/artifacts/reveal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: artifact.file }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not reveal that file.');
      setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not reveal that file.');
    }
  }

  async function revealLog() {
    try {
      const response = await apiFetch('/server/reveal-log', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not reveal server.log.');
      setNotice('Revealed server.log in Finder.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not reveal server.log.');
    }
  }

  async function chooseArchiveFolder() {
    setNotice('Choose a folder for your Lavish archive…');
    try {
      const response = await apiFetch('/archive/choose', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not configure the archive.');
      setNotice('Creating the first protected copy of each Lavish…');
      if (await loadLibrary(true)) setNotice('');
      setShowArchive(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not configure the archive.');
    }
  }

  async function disableArchive() {
    if (!window.confirm('Pause automatic backups? Existing archived versions will be kept.')) return;
    try {
      const response = await apiFetch('/archive/disable', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not pause backups.');
      setNotice((current) => typeof current !== 'string' && current.source === 'archive-pause' ? '' : current);
      await loadLibrary(true);
    } catch (error) {
      setNotice({ source: 'archive-pause', message: error instanceof Error ? error.message : 'Could not pause backups.' });
    }
  }

  async function revealArchive() {
    try {
      const response = await apiFetch('/archive/reveal', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not reveal the archive.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not reveal the archive.');
    }
  }

  function selectHistory(artifact: Artifact) {
    if (artifact.file === historyFile) {
      void historyRefreshRef.current?.();
      return;
    }
    setHistoryArtifact(artifact);
    setHistoryLoading(true);
    setHistory(null);
  }

  async function retryBackup(artifact: Artifact) {
    setBackingUp((ids) => [...ids, artifact.id]);
    setNotice(`Protecting “${artifact.title}”…`);
    let retryError: string | null = null;
    try {
      const response = await apiFetch('/artifacts/snapshot', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: artifact.file }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not create a snapshot.');
    } catch (error) {
      retryError = error instanceof Error ? error.message : 'Could not create a snapshot.';
    } finally {
      // Reconcile warnings and summary after both failed and successful retries.
      const refreshed = await loadLibrary(true);
      setBackingUp((ids) => ids.filter((id) => id !== artifact.id));
      if (refreshed) {
        const current = refreshed.artifacts.find((item) => item.id === artifact.id);
        setNotice(retryError ?? (current && isLatestProtected(current, refreshed.archive.enabled) ? 'Current version is protected.' : 'Latest content is not protected. Check the backup status and retry.'));
      } else if (retryError) {
        setNotice(retryError);
      }
    }
  }

  async function openArchivedVersion(version: ArchivedVersion) {
    if (!historyArtifact) return;
    try {
      const response = await apiFetch('/versions/open', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: historyArtifact.file, versionId: version.id }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not open that version.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not open that version.');
    }
  }

  async function restoreArchivedVersion(version: ArchivedVersion) {
    if (!historyArtifact || version.isCurrent) return;
    const sourceMissing = history?.sourceExists === false;
    if (!window.confirm(`Restore the version from ${fullDate(version.createdAt)}? ${sourceMissing ? 'The missing source file will be recreated with its archived assets.' : 'The current file will be backed up first.'}`)) return;
    setNotice(`Restoring “${historyArtifact.title}”…`);
    try {
      const response = await apiFetch('/versions/restore', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: historyArtifact.file, versionId: version.id }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not restore that version.');
      await loadLibrary(true);
      setNotice(result.sourceRecreated ? 'Version restored. The missing source file was recreated.' : 'Version restored. The previous current file was preserved in the archive.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not restore that version.');
    }
  }

  const currentProject = library?.projects.find((project) => project.id === selectedProject);
  const liveCount = library?.artifacts.filter((artifact) => artifact.sessionStatus === 'open').length ?? 0;
  const currentHistoryArtifact = library?.artifacts.find((artifact) => artifact.id === historyArtifact?.id) ?? historyArtifact;
  const emptyReason = getLibraryEmptyReason(library?.artifacts ?? [], selectedProject);

  function clearSearchAndFilters() {
    setQuery('');
    setStatusFilter('all');
    searchRef.current?.focus();
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Icon name="spark" /></div>
          <div><strong>Lavish</strong><span>Library</span></div>
        </div>

        <nav aria-label="Library navigation">
          <p className="nav-label">Library</p>
          <button className={`nav-item ${section === 'library' && selectedProject === 'all' ? 'active' : ''}`} onClick={() => selectProject('all')}>
            <Icon name="grid" /><span>All lavishes</span><small>{library?.artifacts.length ?? '—'}</small>
          </button>
          <div className="nav-item muted" aria-label={`${liveCount} known sessions`}><span className="live-dot" /><span>Known sessions</span><small>{liveCount}</small></div>
          <button className={`nav-item ${section === 'library' && showArchive ? 'active' : ''}`} onClick={() => { setSection('library'); setShowArchive((value) => !value); }}>
            <Icon name="archive" /><span>Version archive</span><small>{library?.archive?.totalVersions ?? '—'}</small>
          </button>

          <p className="nav-label nav-section-label">Insights</p>
          <button className={`nav-item ${section === 'observatory' ? 'active' : ''}`} onClick={() => setSection('observatory')}>
            <span className="nav-insight-glyph">◎</span><span>Observatory</span>
          </button>
          <button className={`nav-item ${section === 'review' ? 'active' : ''}`} onClick={() => setSection('review')}>
            <span className="nav-review-glyph">✦</span><span>Review</span>
          </button>

          <div className="nav-heading">
            <p className="nav-label">Projects</p>
            <button aria-label="Add project folder" onClick={() => setShowAdd((value) => !value)}><Icon name="plus" /></button>
          </div>
          <div className="project-list">
            {library?.projects.map((project) => (
              <button key={project.id} className={`nav-item ${section === 'library' && selectedProject === project.id ? 'active' : ''}`} onClick={() => selectProject(project.id)} title={project.path}>
                <span className="project-glyph">{project.name.slice(0, 1).toUpperCase()}</span><span>{project.name}</span><small>{project.artifactCount}</small>
              </button>
            ))}
          </div>
        </nav>

        <div className="sidebar-foot">
          <div className="server-card">
            <span className={`server-light ${library?.server.running ? 'online' : ''}`} />
            <div><strong>Lavish server</strong><span>{library?.server.running ? 'Running locally' : 'Starts when needed'}</span>{library?.server.logAvailable && <button className="reveal-log" onClick={() => void revealLog()}>Reveal server.log</button>}</div>
          </div>
          <p>Stored on this Mac</p>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          {section === 'library' ? <>
            <label className="search-box">
              <Icon name="search" />
              <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search lavishes, projects, or paths…" />
              <kbd>⌘ K</kbd>
            </label>
            <button className="icon-button" aria-label="Refresh library" onClick={() => void loadLibrary()}><Icon name="refresh" /></button>
            <button className={`archive-button ${library?.archive?.enabled ? 'enabled' : ''} ${library?.archive?.failedArtifacts ? 'failed' : ''}`} onClick={() => setShowArchive((value) => !value)}><Icon name="archive" /> {library?.archive?.enabled ? `${library.archive.totalVersions} versions${library.archive.failedArtifacts ? ` · ${library.archive.failedArtifacts} failed` : ''}` : 'Set up archive'}</button>
            <button className="add-button" onClick={() => setShowAdd((value) => !value)}><Icon name="plus" /> Add folder</button>
          </> : <>
            <div className="insights-topbar-copy"><strong>{section === 'observatory' ? 'Signal Observatory' : 'Lavish Review'}</strong><span>{section === 'observatory' ? 'Explore local evidence and evolving plans' : 'Reflect, respond, and choose what comes next'}</span></div>
            <button className="archive-button enabled" onClick={() => setSection('library')}><Icon name="grid" /> Back to library</button>
          </>}
        </header>

        {section === 'library' && showArchive && (
          <section className="archive-panel" aria-label="Version archive settings">
            <div className="archive-panel-copy">
              <div className="archive-emblem"><Icon name="archive" /></div>
              <div>
                <strong>{library?.archive?.enabled ? 'Automatic version archive' : 'Protect every good iteration'}</strong>
                <p>{library?.archive?.enabled ? library.archive.path : 'Choose a local folder. Lavish Library will keep an immutable copy whenever an artifact changes.'}</p>
              </div>
            </div>
            {library?.archive?.enabled ? (
              <>
                <div className="archive-stats" aria-live="polite"><span><strong>{library.archive.protectedArtifacts}</strong> latest protected</span><span><strong>{library.archive.unprotectedArtifacts}</strong> unprotected</span><span className={library.archive.failedArtifacts ? 'failed' : ''}><strong>{library.archive.failedArtifacts}</strong> failed</span><span><strong>{library.archive.totalVersions}</strong> versions</span></div>
                <div className="archive-panel-actions"><button onClick={() => void revealArchive()}>Show in Finder</button><button onClick={() => void chooseArchiveFolder()}>Change folder</button><button className="quiet-danger" onClick={() => void disableArchive()}>Pause</button></div>
              </>
            ) : <button className="archive-choose" onClick={() => void chooseArchiveFolder()}><Icon name="folder" /> Choose archive folder</button>}
          </section>
        )}

        {section === 'library' && showAdd && (
          <section className="add-panel" aria-label="Add a project folder">
            <div><strong>Add a project folder</strong><p>We’ll look inside its <code>.lavish</code> folders. Nothing is uploaded.</p></div>
            <button className="choose-button" onClick={() => void chooseFolder()}><Icon name="folder" /> Choose folder</button>
            <form onSubmit={addManualFolder}>
              <input value={manualPath} onChange={(event) => setManualPath(event.target.value)} placeholder="Or paste /Users/you/project" required />
              <button type="submit">Add</button>
            </form>
          </section>
        )}

        {section !== 'library' ? <InsightsView mode={section} /> : <div className="content">
          <div className="eyebrow"><Icon name="spark" /> YOUR CREATIVE ARCHIVE</div>
          <div className="title-row">
            <div>
              <h1>{currentProject?.name ?? 'All lavishes'}</h1>
              <p>{currentProject ? currentProject.path : 'Every review surface you’ve made, finally in one place.'}</p>
            </div>
            <div className="summary-pill"><strong>{artifacts.length}</strong><span>{artifacts.length === 1 ? 'artifact' : 'artifacts'}</span></div>
          </div>

          <div className="toolbar">
            <div className="filter-pills">
              <button className={statusFilter === 'all' ? 'selected' : ''} onClick={() => setStatusFilter('all')}>All <span>{filterCounts.all}</span></button>
              <button className={statusFilter === 'live' ? 'selected' : ''} onClick={() => setStatusFilter('live')}>Live <span>{filterCounts.live}</span></button>
              <button className={statusFilter === 'discovered' ? 'selected' : ''} onClick={() => setStatusFilter('discovered')}>Discovered <span>{filterCounts.discovered}</span></button>
            </div>
            <div className="view-tools">
              <label>Sort <select value={sort} onChange={(event) => setSort(event.target.value as SortMode)}><option value="recent">Recently used</option><option value="edited">Last edited</option><option value="name">Name</option></select></label>
              <div className="view-switch"><button className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} aria-label="Grid view"><Icon name="grid" /></button><button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} aria-label="List view"><Icon name="list" /></button></div>
            </div>
          </div>

          {noticeMessage && <div className="notice" role="status">{noticeMessage}</div>}

          {loading ? (
            <div className="loading-grid">{[1, 2, 3, 4, 5, 6].map((item) => <div className="skeleton" key={item} />)}</div>
          ) : artifacts.length === 0 ? (
            <div className="empty-state">
              <div><Icon name={emptyReason === 'filters' ? 'search' : 'spark'} /></div>
              {emptyReason === 'library' ? <>
                <h2>No lavishes found here yet</h2>
                <p>Add a project folder, or create a <code>.lavish</code> artifact and refresh.</p>
                <button onClick={() => setShowAdd(true)}>Add your first folder</button>
              </> : emptyReason === 'project' ? <>
                <h2>No lavishes in this project yet</h2>
                <p>Create a <code>.lavish</code> artifact in this project folder and refresh.</p>
                <button onClick={() => selectProject('all')}>View all projects</button>
              </> : <>
                <h2>No matching lavishes</h2>
                <p>Your current search and filters have no matches{selectedProject !== 'all' ? ' in this project' : ''}. Clear them to see all lavishes{selectedProject !== 'all' ? ' in this project' : ''}.</p>
                <button onClick={clearSearchAndFilters}>Clear search and filters</button>
              </>}
            </div>
          ) : (
            <div className={`artifact-${view}`}>
              {artifacts.map((artifact, index) => {
                const project = library?.projects.find((item) => item.id === artifact.projectId);
                const label = statusLabel(artifact, Boolean(library?.server.running));
                const failures = visibleArtifactFailures(artifact);
                return (
                  <article className="artifact-card" key={artifact.id} style={{ '--card-index': index % 6 } as React.CSSProperties}>
                    <div className="card-preview">
                      <ArtifactPreview id={artifact.id} title={artifact.title} exists={artifact.exists} />
                      <div className="card-actions"><button onClick={() => void openArtifact(artifact)} disabled={!artifact.exists}>{artifact.sessionStatus === 'ended' ? 'Reopen' : 'Open'} <Icon name="arrow" /></button></div>
                    </div>
                    <div className="card-body">
                      <div className="card-heading"><div><span className={`status status-${artifact.sessionStatus}`}>{label}</span>{!!failures.length && <span className="status status-failed">Review failed</span>}<h2>{artifact.title}</h2></div><button aria-label="Reveal in Finder" title="Reveal in Finder" onClick={() => void revealArtifact(artifact)}><Icon name="more" /></button></div>
                      {!!failures.length && <details className="artifact-warning"><summary>Lavish reported a review failure</summary><p>{library?.server.running ? 'The server is running, but this artifact or a local asset could not load.' : 'This artifact or a local asset could not load in Lavish.'} This is the last recorded failure; server health does not confirm a successful render.</p><ul>{failures.map((failure, index) => <li key={index}><strong>{failure.kind === 'artifact-unavailable' ? 'Artifact unavailable' : 'Local asset unavailable'}</strong>{failure.detail && <span>{failure.detail}</span>}</li>)}</ul></details>}
                      <p className="description">{artifact.description || artifact.relativePath}</p>
                      <div className="card-meta"><span><span className="project-glyph mini">{project?.name.slice(0, 1).toUpperCase() ?? '?'}</span>{project?.name ?? 'Loose artifacts'}</span><span><Icon name="clock" /> {relativeTime(artifact.lastUsedAt ?? artifact.modifiedAt)}</span><span><Icon name="file" /> {formatSize(artifact.size)}</span><button className={`history-chip ${isLatestProtected(artifact, Boolean(library?.archive?.enabled)) ? 'protected' : ''}`} onClick={() => selectHistory(artifact)}><Icon name="history" /> {library?.archive?.enabled ? artifact.versionCount : 'History'}</button></div>
                      <BackupStatus artifact={artifact} enabled={Boolean(library?.archive?.enabled)} busy={backingUp.includes(artifact.id)} onRetry={() => void retryBackup(artifact)} />
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>}
      </section>

      {historyArtifact && (
        <div className="history-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHistoryArtifact(null); }}>
          <aside className="history-drawer" role="dialog" aria-modal="true" aria-label={`Version history for ${historyArtifact.title}`}>
            <header className="history-head">
              <div><span className="history-kicker"><Icon name="history" /> VERSION HISTORY</span><h2>{historyArtifact.title}</h2><p>{historyArtifact.relativePath}</p></div>
              <button aria-label="Close version history" onClick={() => setHistoryArtifact(null)}><Icon name="close" /></button>
            </header>

            {historyLoading ? <div className="history-loading">Reading the archive…</div> : !history?.enabled ? (
              <div className="history-empty"><div><Icon name="archive" /></div><h3>No archive folder yet</h3><p>Choose a folder to create a baseline and start tracking every future revision.</p><button onClick={() => void chooseArchiveFolder()}>Choose archive folder</button></div>
            ) : (
              <>
                <div className="history-summary"><div><strong>{history.versions.length}</strong><span>saved versions</span></div><button disabled={history.sourceExists === false || backingUp.includes(historyArtifact.id)} onClick={() => void retryBackup(historyArtifact)}><Icon name="plus" /> {backingUp.includes(historyArtifact.id) ? 'Backing up…' : 'Back up now'}</button></div>
                {currentHistoryArtifact && <BackupStatus artifact={currentHistoryArtifact} enabled={Boolean(library?.archive?.enabled)} />}
                {history.sourceExists === false && <p className="history-loading">The source file is missing. Restore a saved version to recover it.</p>}
                <div className="timeline">
                  {history.versions.map((version, index) => (
                    <article className={`version-row ${version.isCurrent ? 'current' : ''}`} key={version.id}>
                      <div className="timeline-mark"><i /></div>
                      <div className="version-content">
                        <div className="version-title"><strong>{version.isCurrent ? 'Current protected version' : index === history.versions.length - 1 ? 'Original baseline' : `Revision ${history.versions.length - index}`}</strong><span>{relativeTime(version.createdAt)}</span></div>
                        <p>{fullDate(version.createdAt)} · {formatSize(version.size)} · {version.lineCount.toLocaleString()} lines</p>
                        <div className="version-deltas"><span>{deltaLabel(version.lineDelta, 'lines')}</span><span>{version.assetsCopied} local assets</span><span>{version.reason === 'pre-restore' ? 'Safety copy' : version.reason === 'restore' ? 'Restored' : version.reason === 'change' ? 'Auto-saved' : version.reason === 'manual' ? 'Manual copy' : 'Scan'}</span></div>
                        {!!version.revisionContext?.length && <section className="revision-context" aria-label="Agent-declared revision context"><h3>Agent-declared revisions</h3><p>Context from this saved artifact.</p>{version.revisionContext.map((revision) => <div className="revision-declaration" key={revision.id}><strong>{revision.label}</strong>{revision.timestamp && <time>{revision.timestamp}</time>}{revision.summary && <p>{revision.summary}</p>}</div>)}</section>}
                        <div className="version-actions"><button disabled={history.sourceExists === false} onClick={() => void openArchivedVersion(version)}>Open copy <Icon name="arrow" /></button><button disabled={version.isCurrent} onClick={() => void restoreArchivedVersion(version)}><Icon name="restore" /> {version.isCurrent ? 'In use' : 'Restore'}</button></div>
                      </div>
                    </article>
                  ))}
                </div>
                <footer className="history-foot"><Icon name="folder" /><span>{history.archivePath}</span></footer>
              </>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}
