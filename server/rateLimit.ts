/**
 * A tiny in-memory sliding-window limiter for unauthenticated endpoints that
 * cost real CPU (anonymous PDF/DOCX export of a public site). Per process and
 * not persisted: it bounds a single abusive client, it is not a quota system.
 * (server/oauth/routes.ts keeps its own private copy of the same idea.)
 */
const hits = new Map<string, number[]>();
const PRUNE_ABOVE = 5000;
const PRUNE_IDLE_MS = 3_600_000;

/**
 * Records one hit for `key` in `bucket` and returns true when that hit is over
 * the limit (the caller should answer 429). A rejected hit is not recorded,
 * so a client that keeps retrying is let back in as soon as its window clears.
 */
export function rateLimited(bucket: string, key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const mapKey = `${bucket}|${key}`;
  const recent = (hits.get(mapKey) ?? []).filter((t) => t > now - windowMs);
  if (recent.length >= max) {
    hits.set(mapKey, recent);
    return true;
  }
  recent.push(now);
  hits.set(mapKey, recent);
  if (hits.size > PRUNE_ABOVE) {
    for (const [k, v] of hits) if (v.every((t) => t <= now - PRUNE_IDLE_MS)) hits.delete(k);
  }
  return false;
}

/** Seconds until the oldest hit in the window expires — the value for a `Retry-After` header. At least 1. */
export function retryAfterSeconds(bucket: string, key: string, windowMs: number): number {
  const recent = hits.get(`${bucket}|${key}`) ?? [];
  if (recent.length === 0) return 1;
  const oldest = Math.min(...recent);
  return Math.max(1, Math.ceil((oldest + windowMs - Date.now()) / 1000));
}

export function __resetRateLimitsForTests(): void {
  hits.clear();
}
