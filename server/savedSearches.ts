/**
 * Saved searches (Obsidian brief, wave 3): a person's named queries, kept in
 * Postgres (db/migrations/044_saved_searches.sql). The query is stored as typed;
 * the grammar is shared/searchQuery.ts's. At most MAX_SAVED_SEARCHES per user —
 * the count and the insert happen under a per-user advisory lock, so two
 * parallel saves cannot both slip past the cap.
 */
import type { SavedSearch } from '../shared/contracts.js';
import { query, queryOne, withTransaction } from './db/pool.js';

export const MAX_SAVED_SEARCHES = 50;

interface SavedSearchRow {
  id: string;
  name: string;
  query: string;
  space_slug: string | null;
  created_at: string;
}

function toSavedSearch(row: SavedSearchRow): SavedSearch {
  return { id: row.id, name: row.name, query: row.query, space: row.space_slug, createdAt: new Date(row.created_at).toISOString() };
}

/** The person's saved searches, oldest first (the order they were saved in). */
export async function listSavedSearches(userId: string): Promise<SavedSearch[]> {
  const rows = await query<SavedSearchRow>('SELECT id, name, query, space_slug, created_at FROM saved_searches WHERE user_id = $1 ORDER BY created_at, id', [userId]);
  return rows.map(toSavedSearch);
}

/** Saves one; undefined when the person already has MAX_SAVED_SEARCHES. */
export async function createSavedSearch(userId: string, input: { name: string; query: string; space: string | null }): Promise<SavedSearch | undefined> {
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 44))', [`saved_searches:${userId}`]);
    const count = await client.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM saved_searches WHERE user_id = $1', [userId]);
    if ((count.rows[0]?.n ?? 0) >= MAX_SAVED_SEARCHES) return undefined;
    const inserted = await client.query<SavedSearchRow>(
      'INSERT INTO saved_searches (user_id, name, query, space_slug) VALUES ($1, $2, $3, $4) RETURNING id, name, query, space_slug, created_at',
      [userId, input.name, input.query, input.space],
    );
    return toSavedSearch(inserted.rows[0]);
  });
}

/** Deletes one of the person's own; false when there is no such search (or it is someone else's). */
export async function deleteSavedSearch(userId: string, id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>('DELETE FROM saved_searches WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
  return row !== undefined;
}
