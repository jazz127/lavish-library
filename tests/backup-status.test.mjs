import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backupFixture } from './helpers/backup-fixture.mjs';

test('disabled archive and first-backup failure remain unprotected; manual retry recovers', async () => {
  await backupFixture(async ({ library, blockFirst, unblockFirst, snapshot }) => {
    const disabled = await library();
    assert.equal(disabled.archive.enabled, false);
    assert.equal(disabled.artifacts[0].lastBackedUpAt, null);
    await blockFirst();
    const failed = await library();
    assert.match(failed.artifacts[0].backupError, /ENOTDIR/);
    assert.equal(failed.artifacts[0].lastBackedUpAt, null);
    assert.equal(failed.archive.protectedArtifacts, 0);
    assert.equal(failed.archive.failedArtifacts, 1);
    assert.equal(failed.archive.unprotectedArtifacts, 1);
    assert.equal((await snapshot()).status, 400);
    await unblockFirst();
    assert.equal((await snapshot()).status, 201);
    const recovered = await library();
    assert.equal(recovered.artifacts[0].backupError, null);
    assert.ok(recovered.artifacts[0].lastBackedUpAt);
    assert.equal(recovered.archive.protectedArtifacts, 1);
    assert.equal(recovered.archive.failedArtifacts, 0);
    assert.equal(recovered.archive.unprotectedArtifacts, 0);
  });
});

test('failure after a saved copy preserves last success and counts only latest protection', async () => {
  await backupFixture(async ({ configure, library, blockNext, unblockNext, snapshot, readManifest }) => {
    await configure(true);
    const success = await library();
    assert.equal(success.artifacts[0].versionCount, 1);
    assert.equal(success.archive.protectedArtifacts, 1);
    const lastSuccess = success.artifacts[0].lastBackedUpAt;
    await blockNext();
    const failed = await library();
    assert.match(failed.artifacts[0].backupError, /ENOTDIR/);
    assert.equal(failed.artifacts[0].lastBackedUpAt, lastSuccess);
    assert.equal(failed.artifacts[0].versionCount, 1);
    assert.equal(failed.archive.totalVersions, 1);
    assert.equal(failed.archive.protectedArtifacts, 0);
    assert.equal(failed.archive.failedArtifacts, 1);
    assert.equal(failed.archive.unprotectedArtifacts, 1);
    assert.equal((await readManifest()).versions.at(-1).createdAt, lastSuccess);
    await unblockNext();
    assert.equal((await snapshot()).status, 201);
    const recovered = await library();
    assert.equal(recovered.artifacts[0].versionCount, 2);
    assert.notEqual(recovered.artifacts[0].lastBackedUpAt, lastSuccess);
    assert.equal(recovered.artifacts[0].backupError, null);
    assert.equal(recovered.archive.protectedArtifacts, 1);
    assert.equal(recovered.archive.failedArtifacts, 0);
    assert.equal(recovered.archive.unprotectedArtifacts, 0);
  });
});
