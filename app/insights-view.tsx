'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

const API = 'http://127.0.0.1:4318/api';

type InsightSummary = {
  totalArtifacts: number;
  active30d: number;
  repeatArtifacts: number;
  sessionReplies: number;
  versions: number;
  outcomes: number;
  trackedSearches: number;
};

type Topic = { id: string; name: string; count: number; repeatUse: number; versions: number; sessionReplies: number; examples: string[] };
type Purpose = { name: string; count: number; repeatUse: number; versions: number; sessionReplies: number; examples: string[] };
type SearchSignal = { query: string; count: number; zeroResultCount: number; averageResults: number; lastSearchedAt: string };
type EvolutionEvent = { id: string; at: string; type: string; title: string; label: string; detail: string; artifactId: string | null; projectId: string | null };
type Recommendation = { id: string; kind: string; title: string; description: string; evidence: string; confidence: string };
type FeedbackCandidate = { id: string; file: string; title: string; projectName: string; lastActivityAt: string | null };
type DormantArtifact = FeedbackCandidate & { reason: string };
type TemplateCandidate = { id: string; name: string; count: number; confidence: string; evidence: string; examples: string[] };
type Settings = { cadence: string; manual: boolean; weekly: boolean; monthly: boolean; contextual: boolean; foregroundTime: false };

type Insights = {
  generatedAt: string;
  rangeDays: number;
  privacy: { localOnly: boolean; foregroundTime: boolean; signals: string[] };
  settings: Settings;
  summary: InsightSummary;
  topics: Topic[];
  purposes: Purpose[];
  searches: SearchSignal[];
  dormant: DormantArtifact[];
  templateCandidates: TemplateCandidate[];
  recommendations: Recommendation[];
  evolution: EvolutionEvent[];
  review: { headline: string; lede: string; highlights: Array<{ title: string; detail: string; tone: string }>; status: { due: boolean; reasons: string[]; lastReviewedAt: string | null; nextDueAt: string | null; newestEvidenceAt: string | null } };
  feedbackQueue: FeedbackCandidate[];
};

function when(value: string | null) {
  if (!value) return 'No recent activity';
  const delta = Date.now() - new Date(value).getTime();
  if (delta < 86_400_000) return 'Today';
  if (delta < 7 * 86_400_000) return `${Math.max(1, Math.floor(delta / 86_400_000))}d ago`;
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value));
}

function eventGlyph(type: string) {
  return ({ version: '↶', session: '◌', git: '⌁', open: '↗', feedback: '♡', restore: '↺', recommendation: '✦' } as Record<string, string>)[type] || '·';
}

export default function InsightsView() {
  const [insights, setInsights] = useState<Insights | null>(null);
  const [mode, setMode] = useState<'observe' | 'review'>('observe');
  const [days, setDays] = useState(90);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [eventType, setEventType] = useState('all');
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch(`${API}/insights?days=${days}`, { cache: 'no-store' });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || 'Could not read Lavish insights.');
      setInsights(value);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not read Lavish insights.');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API}/insights?days=${days}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || 'Could not read Lavish insights.');
        return value;
      })
      .then((value) => { setInsights(value); setError(''); })
      .catch((reason) => { if (reason instanceof Error && reason.name !== 'AbortError') setError(reason.message); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [days]);
  useEffect(() => { void fetch(`${API}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'insights_open' }) }); }, []);

  const evolution = useMemo(() => {
    if (!insights) return [];
    return insights.evolution.filter((event) => eventType === 'all' || event.type === eventType);
  }, [eventType, insights]);

  async function saveFeedback(candidate: FeedbackCandidate, value: string, outcome = 'none') {
    setNotice(`Saving feedback for “${candidate.title}”…`);
    try {
      const response = await fetch(`${API}/artifacts/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: candidate.file, value, outcome }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save that feedback.');
      setNotice('Feedback saved locally.');
      await load(true);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'Could not save that feedback.');
    }
  }

  async function saveOutcome(candidate: FeedbackCandidate, outcome: string) {
    setNotice(`Recording the outcome for “${candidate.title}”…`);
    try {
      const response = await fetch(`${API}/artifacts/feedback`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: candidate.file, outcome }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save that outcome.');
      setNotice('Outcome saved locally.');
      await load(true);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'Could not save that outcome.');
    }
  }

  async function updateRecommendation(id: string, action: 'done' | 'dismissed' | 'snoozed') {
    const response = await fetch(`${API}/recommendations/action`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, action }),
    });
    const result = await response.json();
    if (!response.ok) return setNotice(result.error || 'Could not update that recommendation.');
    setNotice(action === 'snoozed' ? 'Snoozed for a week.' : action === 'done' ? 'Marked as done.' : 'Recommendation dismissed.');
    await load(true);
  }

  async function saveSettings(next: Settings) {
    const response = await fetch(`${API}/insights/settings`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next),
    });
    const result = await response.json();
    if (!response.ok) return setNotice(result.error || 'Could not save those settings.');
    setInsights((current) => current ? { ...current, settings: result.settings } : current);
    setNotice('Reflection rhythm saved locally.');
  }

  async function openArtifact(candidate: FeedbackCandidate) {
    setNotice(`Opening “${candidate.title}”…`);
    const response = await fetch(`${API}/artifacts/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: candidate.file }),
    });
    const result = await response.json();
    setNotice(response.ok ? '' : result.error || 'Could not open that Lavish.');
  }

  async function markReviewed() {
    await fetch(`${API}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'review_open', label: 'Lavish Review completed' }) });
    setNotice('Review marked complete. New evidence will shape the next one.');
    await load(true);
  }

  if (loading && !insights) return <div className="insights-loading"><span>✦</span><strong>Reading the signals already on this Mac…</strong><p>Version history, sessions, projects, and recent work are being reconciled.</p></div>;
  if (error && !insights) return <div className="insights-error"><strong>Insights could not be prepared</strong><p>{error}</p><button onClick={() => void load()}>Try again</button></div>;
  if (!insights) return null;

  const maxPurpose = Math.max(...insights.purposes.map((item) => item.count), 1);
  const selectedTopicValue = insights.topics.find((topic) => topic.id === selectedTopic);

  return (
    <div className="insights-shell">
      <header className="insights-hero">
        <div>
          <span className="insights-eyebrow">✦ LAVISH INTELLIGENCE</span>
          <h1>Observe the signals.<br /><em>Review the practice.</em></h1>
          <p>A private evidence layer for understanding what earns attention, what creates outcomes, and how your plans change while the work unfolds.</p>
        </div>
        <div className="insights-controls">
          <label>Evidence window<select value={days} onChange={(event) => { setLoading(true); setDays(Number(event.target.value)); }}><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>One year</option><option value={3650}>All recorded</option></select></label>
          <button onClick={() => setSettingsOpen((value) => !value)}>⚙ Tune rhythm</button>
        </div>
      </header>

      <div className="insights-mode" role="tablist" aria-label="Insights views">
        <button className={mode === 'observe' ? 'active' : ''} onClick={() => setMode('observe')}><span>C</span><div><strong>Signal Observatory</strong><small>Explore evidence and evolving plans</small></div></button>
        <button className={mode === 'review' ? 'active' : ''} onClick={() => setMode('review')}><span>D</span><div><strong>Lavish Review</strong><small>Reflect, respond, and choose what’s next</small></div></button>
      </div>

      {settingsOpen && <section className="rhythm-panel">
        <div><span className="section-kicker">REFLECTION RHYTHM</span><h2>A mix you can tune</h2><p>Prompts stay local. Foreground-time tracking is permanently excluded.</p></div>
        <div className="rhythm-options">
          {(['manual', 'weekly', 'monthly', 'contextual'] as const).map((key) => <label key={key}><input type="checkbox" checked={insights.settings[key]} onChange={(event) => void saveSettings({ ...insights.settings, [key]: event.target.checked, cadence: 'tunable' })} /><span><strong>{key === 'manual' ? 'On demand' : key.slice(0, 1).toUpperCase() + key.slice(1)}</strong><small>{key === 'manual' ? 'Only when you open Insights' : key === 'contextual' ? 'After a revision, restore, or feedback loop' : `${key.slice(0, 1).toUpperCase() + key.slice(1)} synthesis`}</small></span></label>)}
        </div>
      </section>}

      {notice && <div className="insights-notice" role="status">{notice}</div>}

      {mode === 'observe' ? <>
        <section className="signal-ledger">
          <div className="ledger-heading"><span className="section-kicker">SIGNAL LEDGER</span><h2>What the system actually knows</h2><p>No magic score. Every conclusion stays traceable to evidence.</p></div>
          <div className="ledger-grid">
            <div><small>Active in 30 days</small><strong>{insights.summary.active30d}</strong><span>of {insights.summary.totalArtifacts} Lavishes</span></div>
            <div><small>Repeat-use signals</small><strong>{insights.summary.repeatArtifacts}</strong><span>returns, revisions, or feedback</span></div>
            <div><small>Session replies</small><strong>{insights.summary.sessionReplies}</strong><span>known Lavish conversation activity</span></div>
            <div><small>Protected revisions</small><strong>{insights.summary.versions}</strong><span>evidence of plan evolution</span></div>
            <div><small>Outcomes labelled</small><strong>{insights.summary.outcomes}</strong><span>decided, shipped, shared, reused</span></div>
            <div><small>Searches recorded</small><strong>{insights.summary.trackedSearches}</strong><span>tracking begins with this version</span></div>
          </div>
          <div className="signal-sources">{insights.privacy.signals.map((signal) => <span key={signal}>✓ {signal}</span>)}<span className="excluded">× Foreground time excluded</span></div>
        </section>

        <section className="insights-section">
          <div className="section-head"><div><span className="section-kicker">TOPIC OBSERVATORY</span><h2>Threads across the library</h2><p>Local classification from titles, descriptions, paths, revisions, and your corrections.</p></div>{selectedTopicValue && <button className="quiet-link" onClick={() => setSelectedTopic(null)}>Clear focus</button>}</div>
          <div className="topic-layout">
            <div className="topic-cloud">{insights.topics.map((topic) => <button key={topic.id} className={selectedTopic === topic.id ? 'selected' : ''} onClick={() => setSelectedTopic(topic.id)} style={{ '--topic-weight': Math.min(1.45, .82 + topic.count / 20) } as React.CSSProperties}><strong>{topic.name}</strong><span>{topic.count} Lavishes · {topic.repeatUse} repeat</span></button>)}</div>
            <aside className="topic-evidence">
              <span className="section-kicker">{selectedTopicValue ? 'SELECTED THREAD' : 'STRONGEST THREAD'}</span>
              <h3>{(selectedTopicValue || insights.topics[0])?.name || 'More evidence needed'}</h3>
              {(selectedTopicValue || insights.topics[0]) ? <><p>{(selectedTopicValue || insights.topics[0]).count} artifacts, {(selectedTopicValue || insights.topics[0]).versions} protected versions, and {(selectedTopicValue || insights.topics[0]).sessionReplies} known session replies.</p><ul>{(selectedTopicValue || insights.topics[0]).examples.map((example) => <li key={example}>{example}</li>)}</ul></> : <p>Topics will appear as the library grows.</p>}
            </aside>
          </div>
        </section>

        <section className="insights-section split-section">
          <div className="purpose-panel"><span className="section-kicker">WHAT YOU MAKE</span><h2>Recurring Lavish shapes</h2><div className="purpose-bars">{insights.purposes.slice(0, 8).map((purpose) => <div key={purpose.name}><div><strong>{purpose.name}</strong><span>{purpose.count}</span></div><i><b style={{ width: `${Math.max(8, purpose.count / maxPurpose * 100)}%` }} /></i><small>{purpose.repeatUse} repeat-use signals · {purpose.versions} versions</small></div>)}</div></div>
          <div className="search-panel"><span className="section-kicker">SEARCH INTELLIGENCE</span><h2>What you try to retrieve</h2>{insights.searches.length ? <div className="search-signals">{insights.searches.slice(0, 7).map((search) => <div key={search.query}><strong>“{search.query}”</strong><span>{search.count}× searched</span><span>{search.averageResults} avg. results</span>{search.zeroResultCount > 0 && <em>{search.zeroResultCount} missed</em>}</div>)}</div> : <div className="empty-module"><span>⌕</span><strong>Search learning starts now</strong><p>Queries, result counts, and the Lavish you open will appear here. Existing searches cannot be reconstructed.</p></div>}</div>
        </section>

        <section className="insights-section evolution-section">
          <div className="section-head"><div><span className="section-kicker">PLAN EVOLUTION</span><h2>Watch the work change as you do it</h2><p>Versions, feedback, opens, restores, and project commits arranged as one evidence timeline.</p></div><div className="event-filter"><button className={eventType === 'all' ? 'active' : ''} onClick={() => setEventType('all')}>All</button>{['version', 'session', 'git', 'feedback'].map((type) => <button key={type} className={eventType === type ? 'active' : ''} onClick={() => setEventType(type)}>{type}</button>)}</div></div>
          <div className="evolution-list">{evolution.slice(0, 28).map((event) => <article key={event.id}><div className={`event-glyph event-${event.type}`}>{eventGlyph(event.type)}</div><div><span>{when(event.at)} · {event.type}</span><h3>{event.title}</h3><p><strong>{event.label}</strong>{event.detail ? ` — ${event.detail}` : ''}</p></div></article>)}</div>
        </section>
      </> : <>
        <article className="review-editorial">
          <div className="review-meta"><div className="review-date">YOUR LAVISH REVIEW · {new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric' }).format(new Date())}</div><div className={`review-status ${insights.review.status.due ? 'due' : ''}`}><span>{insights.review.status.due ? insights.review.status.reasons.join(' · ') : `Caught up${insights.review.status.lastReviewedAt ? ` · reviewed ${when(insights.review.status.lastReviewedAt)}` : ''}`}</span><button onClick={() => void markReviewed()}>Mark reviewed</button></div></div>
          <h2>{insights.review.headline}</h2>
          <p className="review-lede">{insights.review.lede}</p>
          <div className="review-highlights">{insights.review.highlights.map((item) => <section key={item.title} className={`tone-${item.tone}`}><span>{item.tone}</span><h3>{item.title}</h3><p>{item.detail}</p></section>)}</div>
        </article>

        <section className="insights-section">
          <div className="section-head"><div><span className="section-kicker">NEXT BEST MOVES</span><h2>An explainable recommendation queue</h2><p>Each suggestion shows its evidence. Finish, snooze, or dismiss it to teach the system.</p></div></div>
          <div className="recommendation-list">{insights.recommendations.length ? insights.recommendations.map((item, index) => <article key={item.id}><span className="recommendation-rank">{String(index + 1).padStart(2, '0')}</span><div><small>{item.kind} · {item.confidence} confidence</small><h3>{item.title}</h3><p>{item.description}</p><blockquote>{item.evidence}</blockquote></div><div className="recommendation-actions"><button onClick={() => void updateRecommendation(item.id, 'done')}>Done</button><button onClick={() => void updateRecommendation(item.id, 'snoozed')}>Snooze</button><button onClick={() => void updateRecommendation(item.id, 'dismissed')}>Dismiss</button></div></article>) : <div className="empty-module"><span>✓</span><strong>The queue is clear</strong><p>New suggestions will appear when fresh evidence warrants them.</p></div>}</div>
        </section>

        <section className="insights-section split-section">
          <div><span className="section-kicker">DORMANT GEMS</span><h2>Strong work that fell quiet</h2><div className="dormant-list">{insights.dormant.length ? insights.dormant.slice(0, 5).map((item) => <article key={item.id}><div><strong>{item.title}</strong><span>{item.projectName} · {when(item.lastActivityAt)}</span><p>{item.reason}</p></div><button onClick={() => void openArtifact(item)}>Revisit ↗</button></article>) : <div className="empty-module compact"><strong>No dormant gems yet</strong><p>Artifacts with strong signals and no recent activity will appear here.</p></div>}</div></div>
          <div><span className="section-kicker">TEMPLATE CANDIDATES</span><h2>Repeatable shapes worth harvesting</h2><div className="template-list">{insights.templateCandidates.map((item) => <article key={item.id}><div><span>{item.confidence}</span><strong>{item.name}</strong><small>{item.count} examples</small></div><p>{item.evidence}</p><ul>{item.examples.slice(0, 2).map((example) => <li key={example}>{example}</li>)}</ul></article>)}</div></div>
        </section>

        <section className="insights-section feedback-section">
          <div className="section-head"><div><span className="section-kicker">TEACH THE SYSTEM</span><h2>What counted as valuable?</h2><p>Small corrections after real use are stronger than an invented engagement score.</p></div></div>
          <div className="feedback-list">{insights.feedbackQueue.map((item) => <article key={item.id}><div><strong>{item.title}</strong><span>{item.projectName} · {when(item.lastActivityAt)}</span></div><div className="value-buttons"><button onClick={() => void saveFeedback(item, 'useful')}>Useful</button><button onClick={() => void saveFeedback(item, 'unfinished')}>Unfinished</button><button onClick={() => void saveFeedback(item, 'disposable')}>Disposable</button></div><label>Outcome<select defaultValue="none" onChange={(event) => { if (event.target.value !== 'none') void saveOutcome(item, event.target.value); }}><option value="none">Not labelled</option><option value="decided">Informed a decision</option><option value="shipped">Shipped</option><option value="shared">Shared</option><option value="reused">Reused elsewhere</option><option value="abandoned">Abandoned</option></select></label></article>)}</div>
        </section>
      </>}
    </div>
  );
}
