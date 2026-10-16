/**
 * The scan must never hold the event loop (prod, 15.10.2026): after an
 * INDEX_META_VERSION bump the boot scan re-parsed every document, one big
 * document blocked the loop for 339 s, the container's health check (GET
 * /api/health, 5 s timeout) failed and the proxy answered 503 for minutes.
 *
 * A synthetic space of 3,000 small documents plus a few of 1–2 MB in the
 * constructs micromark parses in more than linear time (a GFM table, a long
 * list, a paragraph of links, one HTML block of anchors): while scanSpace
 * indexes it, a 10 ms interval timer never runs late by more than 500 ms and
 * /api/health on a real listening server answers within a second. Real PG,
 * real files.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as authStore from './auth/store.js';
import { query } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import * as storage from './storage.js';

const SMALL_DOCS = 3000;
const MAX_LAG_MS = 500;
const MAX_HEALTH_MS = 1000;

function repeatTo(unit: string, size: number): string {
  return unit.repeat(Math.ceil(size / unit.length));
}

describe('scanSpace stays cooperative on a big space (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let base: string;
  let slug: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    app = Fastify();
    app.get('/api/health', async () => ({ ok: true }));
    base = await app.listen({ port: 0, host: '127.0.0.1' });
    const owner = await authStore.createUser({ email: `scan-loop-${Date.now()}@example.com`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    slug = (await storage.createSpace(`Scan loop ${Date.now()}`, owner.id)).slug;
  });

  afterAll(async () => {
    await app.close();
    await deleteTestSpace(slug);
    await teardownSchema();
  });

  it(
    'a 10 ms timer is never late by more than 500 ms and /api/health answers within 1 s while 3k docs and 1–2 MB docs are indexed',
    async () => {
      const dir = storage.getSpaceDir(slug);
      for (let folder = 0; folder < 30; folder++) {
        const folderDir = path.join(dir, `area-${folder}`);
        await fs.mkdir(folderDir, { recursive: true });
        await fs.writeFile(path.join(folderDir, 'index.md'), `# Area ${folder}\n\nThe area's home.\n`);
        await Promise.all(
          Array.from({ length: SMALL_DOCS / 30 }, (_, i) =>
            fs.writeFile(
              path.join(folderDir, `page-${i}.md`),
              `# Page ${folder}-${i}\n\n## Notes\n\nSee [next](page-${(i + 1) % 100}.md), [[page-${(i + 2) % 100}]] and [home](/s/${slug}).\n\n#area-${folder} #topic/${i % 7}\n`,
            ),
          ),
        );
      }
      await fs.writeFile(path.join(dir, 'big-table.md'), `# Big table\n\n| a | b | c |\n|---|---|---|\n${repeatTo('| cell one | [l](area-1/page-1.md) | #tag |\n', 1_500_000)}`);
      await fs.writeFile(path.join(dir, 'big-list.md'), `# Big list\n\n${repeatTo('- item [x](area-2/page-2.md) #t\n  - nested [[page-3]]\n', 1_200_000)}`);
      await fs.writeFile(path.join(dir, 'big-links.md'), `# Big links\n\n${repeatTo('See [page](/s/x/p/01M34CK3G0CHVQZ3RJP4QNACAG) and [b](area-3/page-3.md#notes) here.\n', 2_000_000)}`);
      await fs.writeFile(path.join(dir, 'big-html.md'), `# Big html\n\n<div>\n${repeatTo('<p><a href="https://example.com/x">link</a> text</p>\n', 1_000_000)}</div>\n`);

      let maxLag = 0;
      let last = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        maxLag = Math.max(maxLag, now - last - 10);
        last = now;
      }, 10);
      let maxHealth = 0;
      let healthChecks = 0;
      let scanning = true;
      const prober = (async () => {
        while (scanning) {
          const started = performance.now();
          const res = await fetch(`${base}/api/health`);
          expect(res.ok).toBe(true);
          maxHealth = Math.max(maxHealth, performance.now() - started);
          healthChecks++;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      })();

      try {
        const stats = await storage.scanSpace(slug);
        expect(stats.filesRead).toBeGreaterThanOrEqual(SMALL_DOCS + 4);
      } finally {
        scanning = false;
        clearInterval(timer);
        await prober;
      }

      // The index is complete: the big documents' links are there.
      const big = await query<{ path: string; n: number }>(
        `SELECT p.path, COUNT(l.id)::int AS n FROM pages_index p LEFT JOIN page_links l ON l.source_page_id = p.id
          WHERE p.space_slug = $1 AND p.path LIKE 'big-%' GROUP BY p.path ORDER BY p.path`,
        [slug],
      );
      expect(big.map((r) => r.path)).toEqual(['big-html.md', 'big-links.md', 'big-list.md', 'big-table.md']);
      for (const r of big) expect(r.n).toBeGreaterThan(10_000);

      // eslint-disable-next-line no-console
      console.log(`[scan-loop] max event-loop lag ${maxLag.toFixed(0)} ms, max /api/health ${maxHealth.toFixed(0)} ms over ${healthChecks} checks`);
      expect(healthChecks).toBeGreaterThan(5);
      expect(maxLag).toBeLessThan(MAX_LAG_MS);
      expect(maxHealth).toBeLessThan(MAX_HEALTH_MS);
    },
    10 * 60_000,
  );
});
