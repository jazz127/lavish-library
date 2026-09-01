'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import InsightsView from './insights-view';

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
};

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
};

type VersionHistory = {
  enabled: boolean;
  archivePath?: string;
  sourceFile?: string;
  versions: ArchivedVersion[];
};

type Library = {
  projects: Project[];
  artifacts: Artifact[];
  server: { running: boolean; url: string };
  archive: {
    enabled: boolean;
    root: string | null;
    path: string | null;
    totalVersions: number;
    protectedArtifacts: number;
  };
  scannedAt: string;
};

type SortMode = 'recent' | 'edited' | 'name';
type StatusFilter = 'all' | 'live' | 'discovered';
type PageSection = 'library' | 'observatory' | 'review';

const API = 'http://127.0.0.1:4318/api';

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
  const [notice, setNotice] = useState('');
  const [manualPath, setManualPath] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [historyArtifact, setHistoryArtifact] = useState<Artifact | null>(null);
  const [history, setHistory] = useState<VersionHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const trackedSearchRef = useRef('');

  async function loadLibrary(quiet = false) {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch(`${API}/library`, { cache: 'no-store' });
      if (!response.ok) throw new Error('The local library service did not respond.');
      setLibrary(await response.json());
      setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not load your library.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API}/library`, { cache: 'no-store', signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('The local library service did not respond.');
        return response.json();
      })
      .then((value) => setLibrary(value))
      .catch((error) => {
        if (error instanceof Error && error.name !== 'AbortError') setNotice(error.message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

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
    const items = [...(library?.artifacts ?? [])].filter((artifact) => {
      const inProject = selectedProject === 'all' || artifact.projectId === selectedProject;
      const hasStatus = statusFilter === 'all'
        || (statusFilter === 'live' && artifact.sessionStatus === 'open' && library?.server.running)
        || (statusFilter === 'discovered' && artifact.sessionStatus === 'discovered');
      const needle = query.trim().toLowerCase();
      return inProject && hasStatus && (!needle || `${artifact.title} ${artifact.description} ${artifact.file}`.toLowerCase().includes(needle));
    });
    items.sort((a, b) => {
      if (sort === 'name') return a.title.localeCompare(b.title);
      const aDate = sort === 'edited' ? a.modifiedAt : a.lastUsedAt ?? a.modifiedAt;
      const bDate = sort === 'edited' ? b.modifiedAt : b.lastUsedAt ?? b.modifiedAt;
      return new Date(bDate ?? 0).getTime() - new Date(aDate ?? 0).getTime();
    });
    return items;
  }, [library, query, selectedProject, sort, statusFilter]);

  useEffect(() => {
    const normalized = query.trim().toLowerCase();
    if (section !== 'library' || normalized.length < 2 || trackedSearchRef.current === normalized) return;
    const timer = window.setTimeout(() => {
      trackedSearchRef.current = normalized;
      void fetch(`${API}/events`, {
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
    void fetch(`${API}/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'project_view', projectId }),
    });
  }

  async function chooseFolder() {
    setNotice('Opening the folder picker…');
    try {
      const response = await fetch(`${API}/projects/choose`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not add that folder.');
      setShowAdd(false);
      await loadLibrary(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not add that folder.');
    }
  }

  async function addManualFolder(event: React.FormEvent) {
    event.preventDefault();
    try {
      const response = await fetch(`${API}/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: manualPath }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not add that folder.');
      setManualPath('');
      setShowAdd(false);
      await loadLibrary(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not add that folder.');
    }
  }

  async function openArtifact(artifact: Artifact) {
    setNotice(`Opening “${artifact.title}”…`);
    try {
      const response = await fetch(`${API}/artifacts/open`, {
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
      const response = await fetch(`${API}/artifacts/reveal`, {
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

  async function chooseArchiveFolder() {
    setNotice('Choose a folder for your Lavish archive…');
    try {
      const response = await fetch(`${API}/archive/choose`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not configure the archive.');
      setNotice('Creating the first protected copy of each Lavish…');
      await loadLibrary(true);
      setShowArchive(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not configure the archive.');
    }
  }

  async function disableArchive() {
    if (!window.confirm('Pause automatic backups? Existing archived versions will be kept.')) return;
    try {
      const response = await fetch(`${API}/archive/disable`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not pause backups.');
      await loadLibrary(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not pause backups.');
    }
  }

  async function revealArchive() {
    try {
      const response = await fetch(`${API}/archive/reveal`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not reveal the archive.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not reveal the archive.');
    }
  }

  async function loadHistory(artifact: Artifact) {
    setHistoryArtifact(artifact);
    setHistoryLoading(true);
    setHistory(null);
    try {
      const response = await fetch(`${API}/artifacts/versions?file=${encodeURIComponent(artifact.file)}`, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not load version history.');
      setHistory(result);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not load version history.');
    } finally {
      setHistoryLoading(false);
    }
  }

  async function createSnapshot() {
    if (!historyArtifact) return;
    setNotice(`Protecting “${historyArtifact.title}”…`);
    try {
      const response = await fetch(`${API}/artifacts/snapshot`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: historyArtifact.file }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not create a snapshot.');
      await Promise.all([loadLibrary(true), loadHistory(historyArtifact)]);
      setNotice('Current version is protected.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create a snapshot.');
    }
  }

  async function openArchivedVersion(version: ArchivedVersion) {
    if (!historyArtifact) return;
    try {
      const response = await fetch(`${API}/versions/open`, {
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
    if (!window.confirm(`Restore the version from ${fullDate(version.createdAt)}? The current file will be backed up first.`)) return;
    setNotice(`Restoring “${historyArtifact.title}”…`);
    try {
      const response = await fetch(`${API}/versions/restore`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: historyArtifact.file, versionId: version.id }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not restore that version.');
      await Promise.all([loadLibrary(true), loadHistory(historyArtifact)]);
      setNotice('Version restored. The previous current file was preserved in the archive.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not restore that version.');
    }
  }

  const currentProject = library?.projects.find((project) => project.id === selectedProject);
  const liveCount = library?.artifacts.filter((artifact) => artifact.sessionStatus === 'open').length ?? 0;

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
          <button className={`nav-item ${section === 'observatory' ? 'active' : ''}`} onClick={() => setSection('observatory')}>
            <span className="nav-insight-glyph">◎</span><span>Observatory</span><small>C</small>
          </button>
          <button className={`nav-item ${section === 'review' ? 'active' : ''}`} onClick={() => setSection('review')}>
            <span className="nav-review-glyph">✦</span><span>Review</span><small>D</small>
          </button>
          <div className="nav-item muted" aria-label={`${liveCount} known sessions`}><span className="live-dot" /><span>Known sessions</span><small>{liveCount}</small></div>
          <button className={`nav-item ${section === 'library' && showArchive ? 'active' : ''}`} onClick={() => { setSection('library'); setShowArchive((value) => !value); }}>
            <Icon name="archive" /><span>Version archive</span><small>{library?.archive?.totalVersions ?? '—'}</small>
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
            <div><strong>Lavish server</strong><span>{library?.server.running ? 'Running locally' : 'Starts when needed'}</span></div>
          </div>
          <p>Private to this Mac</p>
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
            <button className={`archive-button ${library?.archive?.enabled ? 'enabled' : ''}`} onClick={() => setShowArchive((value) => !value)}><Icon name="archive" /> {library?.archive?.enabled ? `${library.archive.totalVersions} versions` : 'Set up archive'}</button>
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
                <div className="archive-stats"><span><strong>{library.archive.protectedArtifacts}</strong> protected</span><span><strong>{library.archive.totalVersions}</strong> versions</span></div>
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
              <button className={statusFilter === 'all' ? 'selected' : ''} onClick={() => setStatusFilter('all')}>All <span>{library?.artifacts.length ?? 0}</span></button>
              <button className={statusFilter === 'live' ? 'selected' : ''} onClick={() => setStatusFilter('live')}>Live <span>{library?.artifacts.filter((item) => item.sessionStatus === 'open' && library.server.running).length ?? 0}</span></button>
              <button className={statusFilter === 'discovered' ? 'selected' : ''} onClick={() => setStatusFilter('discovered')}>Discovered <span>{library?.artifacts.filter((item) => item.sessionStatus === 'discovered').length ?? 0}</span></button>
            </div>
            <div className="view-tools">
              <label>Sort <select value={sort} onChange={(event) => setSort(event.target.value as SortMode)}><option value="recent">Recently used</option><option value="edited">Last edited</option><option value="name">Name</option></select></label>
              <div className="view-switch"><button className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} aria-label="Grid view"><Icon name="grid" /></button><button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} aria-label="List view"><Icon name="list" /></button></div>
            </div>
          </div>

          {notice && <div className="notice" role="status">{notice}</div>}

          {loading ? (
            <div className="loading-grid">{[1, 2, 3, 4, 5, 6].map((item) => <div className="skeleton" key={item} />)}</div>
          ) : artifacts.length === 0 ? (
            <div className="empty-state"><div><Icon name="spark" /></div><h2>No lavishes found here yet</h2><p>Add a project folder, or create a <code>.lavish</code> artifact and refresh.</p><button onClick={() => setShowAdd(true)}>Add your first folder</button></div>
          ) : (
            <div className={`artifact-${view}`}>
              {artifacts.map((artifact, index) => {
                const project = library?.projects.find((item) => item.id === artifact.projectId);
                const label = statusLabel(artifact, Boolean(library?.server.running));
                return (
                  <article className="artifact-card" key={artifact.id} style={{ '--card-index': index % 6 } as React.CSSProperties}>
                    <div className="card-preview">
                      <div className="preview-chrome"><i /><i /><i /><span>{artifact.title}</span></div>
                      <div className="preview-content"><span /><strong>{artifact.title}</strong><p>{artifact.description || 'A Lavish review surface'}</p><div><i /><i /><i /></div></div>
                      <div className="card-actions"><button onClick={() => void openArtifact(artifact)} disabled={!artifact.exists}>{artifact.sessionStatus === 'ended' ? 'Reopen' : 'Open'} <Icon name="arrow" /></button></div>
                    </div>
                    <div className="card-body">
                      <div className="card-heading"><div><span className={`status status-${artifact.sessionStatus}`}>{label}</span><h2>{artifact.title}</h2></div><button aria-label="Reveal in Finder" title="Reveal in Finder" onClick={() => void revealArtifact(artifact)}><Icon name="more" /></button></div>
                      <p className="description">{artifact.description || artifact.relativePath}</p>
                      <div className="card-meta"><span><span className="project-glyph mini">{project?.name.slice(0, 1).toUpperCase() ?? '?'}</span>{project?.name ?? 'Loose artifacts'}</span><span><Icon name="clock" /> {relativeTime(artifact.lastUsedAt ?? artifact.modifiedAt)}</span><span><Icon name="file" /> {formatSize(artifact.size)}</span><button className={`history-chip ${artifact.versionCount ? 'protected' : ''}`} onClick={() => void loadHistory(artifact)}><Icon name="history" /> {library?.archive?.enabled ? artifact.versionCount : 'History'}</button></div>
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
                <div className="history-summary"><div><strong>{history.versions.length}</strong><span>saved versions</span></div><button onClick={() => void createSnapshot()}><Icon name="plus" /> Back up now</button></div>
                <div className="timeline">
                  {history.versions.map((version, index) => (
                    <article className={`version-row ${version.isCurrent ? 'current' : ''}`} key={version.id}>
                      <div className="timeline-mark"><i /></div>
                      <div className="version-content">
                        <div className="version-title"><strong>{version.isCurrent ? 'Current protected version' : index === history.versions.length - 1 ? 'Original baseline' : `Revision ${history.versions.length - index}`}</strong><span>{relativeTime(version.createdAt)}</span></div>
                        <p>{fullDate(version.createdAt)} · {formatSize(version.size)} · {version.lineCount.toLocaleString()} lines</p>
                        <div className="version-deltas"><span>{deltaLabel(version.lineDelta, 'lines')}</span><span>{version.assetsCopied} local assets</span><span>{version.reason === 'pre-restore' ? 'Safety copy' : version.reason === 'restore' ? 'Restored' : version.reason === 'change' ? 'Auto-saved' : version.reason === 'manual' ? 'Manual copy' : 'Scan'}</span></div>
                        <div className="version-actions"><button onClick={() => void openArchivedVersion(version)}>Open copy <Icon name="arrow" /></button><button disabled={version.isCurrent} onClick={() => void restoreArchivedVersion(version)}><Icon name="restore" /> {version.isCurrent ? 'In use' : 'Restore'}</button></div>
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
