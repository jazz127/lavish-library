type BackupArtifact = {
  title: string;
  exists: boolean;
  versionCount: number;
  lastBackedUpAt: string | null;
  backupError: string | null;
};

export function isLatestProtected(artifact: BackupArtifact, enabled: boolean) {
  return enabled && artifact.exists && !artifact.backupError && artifact.versionCount > 0;
}

export default function BackupStatus({ artifact, enabled, busy, onRetry }: {
  artifact: BackupArtifact;
  enabled: boolean;
  busy?: boolean;
  onRetry?: () => void;
}) {
  const failed = enabled && Boolean(artifact.backupError);
  const protectedLatest = isLatestProtected(artifact, enabled);
  const label = !enabled ? 'Archive disabled' : failed ? 'Backup failed' : protectedLatest ? 'Latest content protected' : artifact.versionCount ? 'Saved copies available · source missing' : 'Never backed up';
  return (
    <div className={`backup-status ${failed ? 'failed' : protectedLatest ? 'protected' : 'unprotected'}`} role={failed ? 'alert' : undefined}>
      <strong>{label}</strong>
      {failed && <p>Latest content is not protected. {artifact.backupError} Check archive folder access, then retry.</p>}
      {artifact.lastBackedUpAt ? <p>Last successful backup: <time dateTime={artifact.lastBackedUpAt}>{new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(artifact.lastBackedUpAt))}</time>{failed && ' · Earlier saved copy only.'}</p> : enabled && failed ? <p>Never backed up · no saved copy yet.</p> : null}
      {onRetry && enabled && artifact.exists && !protectedLatest && <button className="backup-retry" disabled={busy} onClick={onRetry} aria-label={`${failed ? 'Retry backup' : 'Back up now'} for ${artifact.title}`}>{busy ? 'Backing up…' : failed ? 'Retry backup' : 'Back up now'}</button>}
    </div>
  );
}
