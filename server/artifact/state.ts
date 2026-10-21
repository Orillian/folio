/**
 * Artifacts: what an artifact keeps through the bridge (window.storage, the
 * localStorage polyfill) for signed-in readers — `artifact_state` (migration
 * 051). `user_id` NULL is the state shared by every reader of the page, a
 * user's id their own. Limits (docs/spec-artifacts.md §3): key ≤ 200 chars,
 * value ≤ 256 KB, ≤ 5 MB of personal state per reader per page, ≤ 5 MB shared.
 * Anonymous readers (share link, public site) never reach this: their state
 * lives in the parent page's localStorage.
 */
import { ARTIFACT_LIMITS, type ArtifactState, type ArtifactStatePut } from '../../shared/contracts.js';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { HttpError } from '../errors.js';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export async function readArtifactState(pageId: string, userId: string): Promise<ArtifactState> {
  const rows = await query<{ user_id: string | null; key: string; value: string }>(
    'SELECT user_id, key, value FROM artifact_state WHERE page_id = $1 AND (user_id IS NULL OR user_id = $2) ORDER BY key',
    [pageId, userId],
  );
  const state: ArtifactState = { personal: {}, shared: {} };
  for (const r of rows) (r.user_id === null ? state.shared : state.personal)[r.key] = r.value;
  return state;
}

/** One key set (or deleted with value null). Throws 413/400 past the limits. Returns the reader's whole state after the write. */
export async function writeArtifactState(pageId: string, userId: string, put: ArtifactStatePut): Promise<ArtifactState> {
  if (put.key.length > ARTIFACT_LIMITS.maxStateKeyChars) throw new HttpError(400, `a key is at most ${ARTIFACT_LIMITS.maxStateKeyChars} characters`);
  const owner = put.shared ? null : userId;
  if (put.value === null) {
    await query(
      `DELETE FROM artifact_state WHERE page_id = $1 AND coalesce(user_id, '${NIL_UUID}'::uuid) = coalesce($2::uuid, '${NIL_UUID}'::uuid) AND key = $3`,
      [pageId, owner, put.key],
    );
    return readArtifactState(pageId, userId);
  }
  const bytes = Buffer.byteLength(put.value, 'utf8');
  if (bytes > ARTIFACT_LIMITS.maxStateValueBytes) throw new HttpError(413, `a value is at most ${ARTIFACT_LIMITS.maxStateValueBytes / 1024} KB`);
  await withTransaction(async (client) => {
    // One writer per (page, owner) at a time, so two writes cannot both slip under the total.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`artifact_state:${pageId}:${owner ?? 'shared'}`]);
    const total = await client.query<{ total: string | null }>(
      `SELECT sum(octet_length(key) + octet_length(value)) AS total FROM artifact_state
        WHERE page_id = $1 AND coalesce(user_id, '${NIL_UUID}'::uuid) = coalesce($2::uuid, '${NIL_UUID}'::uuid) AND key <> $3`,
      [pageId, owner, put.key],
    );
    const used = Number(total.rows[0]?.total ?? 0);
    if (used + bytes + Buffer.byteLength(put.key, 'utf8') > ARTIFACT_LIMITS.maxStateTotalBytes) {
      throw new HttpError(413, `the ${put.shared ? 'shared' : 'personal'} state of this artifact is limited to ${ARTIFACT_LIMITS.maxStateTotalBytes / 1024 / 1024} MB`);
    }
    await client.query(
      `INSERT INTO artifact_state (page_id, user_id, key, value, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (page_id, coalesce(user_id, '${NIL_UUID}'::uuid), key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [pageId, owner, put.key, put.value],
    );
  });
  return readArtifactState(pageId, userId);
}

/** How many keys a page has in shared state (tests, diagnostics). */
export async function sharedStateCount(pageId: string): Promise<number> {
  const row = await queryOne<{ n: string }>('SELECT count(*) AS n FROM artifact_state WHERE page_id = $1 AND user_id IS NULL', [pageId]);
  return Number(row?.n ?? 0);
}
