'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

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
};

type Library = {
  projects: Project[];
  artifacts: Artifact[];
  server: { running: boolean; url: string };
  scannedAt: string;
};

type SortMode = 'recent' | 'edited' | 'name';
type StatusFilter = 'all' | 'live' | 'discovered';

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

function Icon({ name }: { name: 'spark' | 'folder' | 'search' | 'refresh' | 'plus' | 'grid' | 'list' | 'arrow' | 'more' | 'clock' | 'file' }) {
  const symbols = { spark: '✦', folder: '⌑', search: '⌕', refresh: '↻', plus: '+', grid: '⊞', list: '☷', arrow: '↗', more: '•••', clock: '◷', file: '◇' };
  return <span aria-hidden="true" className={`icon icon-${name}`}>{symbols[name]}</span>;
}

export default function Home() {
  const [library, setLibrary] = useState<Library | null>(null);
  const [selectedProject, setSelectedProject] = useState('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('recent');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [manualPath, setManualPath] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

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
        searchRef.current?.focus();
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
        body: JSON.stringify({ file: artifact.file, reopen: artifact.sessionStatus === 'ended' && artifact.endedBy === 'user' }),
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
          <button className={`nav-item ${selectedProject === 'all' ? 'active' : ''}`} onClick={() => setSelectedProject('all')}>
            <Icon name="grid" /><span>All lavishes</span><small>{library?.artifacts.length ?? '—'}</small>
          </button>
          <div className="nav-item muted" aria-label={`${liveCount} known sessions`}><span className="live-dot" /><span>Known sessions</span><small>{liveCount}</small></div>

          <div className="nav-heading">
            <p className="nav-label">Projects</p>
            <button aria-label="Add project folder" onClick={() => setShowAdd((value) => !value)}><Icon name="plus" /></button>
          </div>
          <div className="project-list">
            {library?.projects.map((project) => (
              <button key={project.id} className={`nav-item ${selectedProject === project.id ? 'active' : ''}`} onClick={() => setSelectedProject(project.id)} title={project.path}>
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
          <label className="search-box">
            <Icon name="search" />
            <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search lavishes, projects, or paths…" />
            <kbd>⌘ K</kbd>
          </label>
          <button className="icon-button" aria-label="Refresh library" onClick={() => void loadLibrary()}><Icon name="refresh" /></button>
          <button className="add-button" onClick={() => setShowAdd((value) => !value)}><Icon name="plus" /> Add folder</button>
        </header>

        {showAdd && (
          <section className="add-panel" aria-label="Add a project folder">
            <div><strong>Add a project folder</strong><p>We’ll look inside its <code>.lavish</code> folders. Nothing is uploaded.</p></div>
            <button className="choose-button" onClick={() => void chooseFolder()}><Icon name="folder" /> Choose folder</button>
            <form onSubmit={addManualFolder}>
              <input value={manualPath} onChange={(event) => setManualPath(event.target.value)} placeholder="Or paste /Users/you/project" required />
              <button type="submit">Add</button>
            </form>
          </section>
        )}

        <div className="content">
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
                      <div className="card-meta"><span><span className="project-glyph mini">{project?.name.slice(0, 1).toUpperCase() ?? '?'}</span>{project?.name ?? 'Loose artifacts'}</span><span><Icon name="clock" /> {relativeTime(artifact.lastUsedAt ?? artifact.modifiedAt)}</span><span><Icon name="file" /> {formatSize(artifact.size)}</span></div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
