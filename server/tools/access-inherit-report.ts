/**
 * Stage 7 (docs/spec-access.md §13): page restrictions became inherited — a
 * child of a restricted page is restricted too. Deploying it therefore SHRINKS
 * the audience of every page that sits below a restricted page. This report
 * lists, before (or after) the deploy, exactly those pages and who loses them:
 * for each page, its readers under the old rule (its own restriction only)
 * and under the new one (its own and every restricted ancestor's), and the
 * difference. Read-only: it runs SELECTs and changes nothing.
 *
 *   DATABASE_URL=postgres://… npm run access:inherit-report            # text
 *   DATABASE_URL=postgres://… npm run access:inherit-report -- --json  # JSON
 *   … -- --space <slug>                                                # one space
 *
 * DATABASE_URL from the environment wins; otherwise `.env` is read like the
 * server does. Works on any Folio database with migration 020+ (and on one
 * migrated past 053, group grants included) — the code that resolves roles is
 * the server's own (access/roles.ts), so "before" and "after" are the same
 * rule the server applies, with and without inheritance.
 *
 * "Public visitor" in the list means the page also stops being part of the
 * space's public site (visibility `public`).
 */
import { closePool, query } from '../db/pool.js';
import { closedPagesSql } from '../access/roleSql.js';
import * as roles from '../access/roles.js';
import { isAgentPath } from '../agentPath.js';
import type { SpaceRole } from '../../shared/contracts.js';

interface ReportRow {
  space: string;
  pageId: string;
  path: string;
  title: string;
  readersBefore: number;
  readersAfter: number;
  lost: Array<{ userId: string; name: string; email: string; roleBefore: SpaceRole }>;
  /** The page leaves the space's public site. */
  publicLost: boolean;
  /** The restricted ancestors it now inherits from, root-most first. */
  restrictedBy: Array<{ pageId: string; path: string; title: string }>;
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const TEMPLATES = /^_templates(\/|$)/;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const onlySpace = argValue(args, '--space');

  const users = new Map(
    (await query<{ id: string; name: string; email: string; is_admin: boolean }>('SELECT id, name, email, is_admin FROM users WHERE NOT is_system AND NOT disabled')).map((u) => [u.id, u]),
  );
  // Every page below at least one restricted page (the rule pages themselves too: one may sit under another).
  const candidates = await query<{ id: string; space_slug: string; path: string; title: string; visibility: string }>(
    `SELECT p.id, p.space_slug, p.path, p.title, sp.visibility
       FROM pages_index p JOIN spaces sp ON sp.slug = p.space_slug
      WHERE p.id IN (${closedPagesSql(onlySpace ? { space: '$1' } : {})})
      ORDER BY p.space_slug, p.path`,
    onlySpace ? [onlySpace] : [],
  );

  const membersBySpace = new Map<string, Array<{ userId: string; spaceRole: SpaceRole }>>();
  const report: ReportRow[] = [];
  for (const page of candidates) {
    const chain = await roles.restrictionChain(page.id);
    const restrictedBy = chain.filter((rule) => rule.pageId !== page.id);
    if (restrictedBy.length === 0) continue; // restricted by its own rule only: nothing changes
    let members = membersBySpace.get(page.space_slug);
    if (!members) {
      members = [...(await roles.spaceMemberRoles(page.space_slug))].map(([userId, spaceRole]) => ({ userId, spaceRole }));
      membersBySpace.set(page.space_slug, members);
    }
    // `.agent/**` is for space and instance admins only, before and after alike.
    const eligible = isAgentPath(page.path) ? members.filter((m) => m.spaceRole === 'admin' || users.get(m.userId)?.is_admin) : members;
    const before = await roles.pageRolesFor(page.id, eligible, { ownRuleOnly: true });
    const after = await roles.pageRolesFor(page.id, eligible);
    const lost = [...before]
      .filter(([userId]) => !after.has(userId))
      .map(([userId, roleBefore]) => ({ userId, name: users.get(userId)?.name ?? userId, email: users.get(userId)?.email ?? '', roleBefore }));
    const ownRule = chain.some((rule) => rule.pageId === page.id);
    const publicLost = page.visibility === 'public' && !ownRule && !isAgentPath(page.path) && !TEMPLATES.test(page.path);
    if (lost.length === 0 && !publicLost) continue;
    report.push({
      space: page.space_slug,
      pageId: page.id,
      path: page.path,
      title: page.title,
      readersBefore: before.size,
      readersAfter: after.size,
      lost,
      publicLost,
      restrictedBy: restrictedBy.map((rule) => ({ pageId: rule.pageId, path: rule.path, title: rule.title })),
    });
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ pages: report }, null, 2)}\n`);
    return;
  }
  if (report.length === 0) {
    process.stdout.write('No page loses readers: no page sits below a restricted page whose audience is narrower than its own.\n');
    return;
  }
  let space = '';
  for (const row of report) {
    if (row.space !== space) {
      space = row.space;
      process.stdout.write(`\n== space ${space}\n`);
    }
    process.stdout.write(`${row.path}  "${row.title}"  readers ${row.readersBefore} -> ${row.readersAfter}\n`);
    process.stdout.write(`   restricted by: ${row.restrictedBy.map((r) => r.path).join(' > ')}\n`);
    for (const person of row.lost) process.stdout.write(`   - ${person.name} <${person.email}> (${person.roleBefore})\n`);
    if (row.publicLost) process.stdout.write('   - public visitor (leaves the public site)\n');
  }
  const people = new Set(report.flatMap((row) => row.lost.map((p) => p.userId)));
  process.stdout.write(`\n${report.length} page(s) lose readers; ${people.size} person(s) lose at least one page.\n`);
}

main()
  .then(() => closePool())
  .catch(async (err: unknown) => {
    process.stderr.write(`access-inherit-report: ${err instanceof Error ? err.message : String(err)}\n`);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
