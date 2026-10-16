/**
 * The card core of the chat link previews (Slack, Microsoft Teams): one Folio URL plus one
 * viewer in, one platform-neutral card model out. Both adapters (slack.ts, teams.ts) render
 * this model; neither ever reads a page itself, so the access rules live here only.
 *
 * Which URLs are Folio's (`classifyFolioUrl`): http(s) on the instance host (PUBLIC_URL's, or
 * the request's own when it is unset) —
 *   /s/<space>                 the space home        (needs a Folio user)
 *   /s/<space>/p/<id>          a page                (needs a Folio user)
 *   /s/<space>/d/<folder>      a folder              (shown as the space, needs a Folio user)
 *   /share/<token>[/p/<id>]    a share link          (the link's own rules, no user)
 *   /public/<slug>[/p/<id>]    a published space     (public-site rules, no user)
 * and `/`, `/p/<id>` on a published space's own host (its subdomain under PUBLIC_SITES_DOMAIN or
 * its custom domain). Anything else is not ours: `null`, the adapter leaves the link alone.
 *
 * Access is EXACTLY the page API's (`GET /api/pages/:id` → session.requirePageRole):
 * session.effectivePageRole decides — space role (explicit membership, or the implicit viewer of
 * an `instance`/`public` space), the page's own ACL (page_access: owner + grants), `.agent/**`
 * for space/instance admins only, a disabled user nothing. A page the viewer cannot open, an
 * unknown id and a deleted page all give the same `noaccess` card, which carries no title, no
 * space name, nothing but the URL the poster already pasted: it never confirms a page exists.
 *
 * A preview is posted INTO A CONVERSATION: everyone in that channel sees it, whatever their own
 * Folio rights (that is how Slack and Teams unfurls work — the card is built once, for the person
 * who shared the link). So for a page that is not open to its whole space (a page_access row, or
 * `.agent/**`) the card is `limited`: title and breadcrumb only — no text, no headings, no tags,
 * no table columns. And a breadcrumb never names a parent the viewer cannot read, nor a
 * restricted one: such a level shows as "…".
 */
import type { User } from '../../../shared/contracts.js';
import { PUBLIC_SITE_PATH_PREFIX } from '../../../shared/contracts.js';
import { isAgentPath } from '../../agentPath.js';
import * as session from '../../auth/session.js';
import { query, queryOne } from '../../db/pool.js';
import { resolveShareScope } from '../../export/shareScope.js';
import * as gitSync from '../../gitSync.js';
import {
  getPublicSpace,
  isPublicPage,
  mainHost,
  publicHomePageId,
  resolvePublicSiteByHost,
  type PublicSpace,
} from '../../publicSites.js';
import { publicUrlOrOrigin } from '../../publicUrl.js';
import { excerptFromMarkdown } from '../../shareMeta.js';
import * as storage from '../../storage.js';
import type { PageIndexEntry } from '../../storage.js';

export const EXCERPT_MAX_CHARS = 300;
export const MAX_HEADINGS = 6;
export const MAX_TAGS = 8;
export const MAX_COLUMNS = 8;
const UPDATED_BY_TIMEOUT_MS = 1500;

export type ChatCardKind = PageIndexEntry['kind'] | 'space';

export type FolioTarget =
  | { type: 'page'; space: string; pageId: string }
  | { type: 'space'; space: string }
  | { type: 'share'; token: string; pageId?: string }
  | { type: 'public'; site: PublicSpace; pageId?: string; hostMode: boolean };

export interface ChatCard {
  status: 'ok';
  /** Where "Open in Folio" goes: the URL as shared (it already works for whoever may open it). */
  url: string;
  title: string;
  /** The page's emoji icon, or a default per kind. */
  icon: string;
  kind: ChatCardKind;
  /** Space name, then parent pages; the page's own title is not repeated. */
  breadcrumb: string[];
  excerpt?: string;
  headings?: string[];
  tags?: string[];
  updatedAt?: string;
  updatedBy?: string;
  table?: { rows: number; columns: string[] };
  form?: { fields: number };
  /** pdf / office: the file extension, upper-case. */
  file?: string;
  /** The page is not open to its whole space: the card shows title and breadcrumb only. */
  limited?: boolean;
  /** Which rules built it: a Folio user's access, a share link, a public site. */
  access: 'member' | 'share' | 'public';
}

/** The viewer may not open it, or it does not exist (indistinguishable on purpose). */
export interface ChatNoAccessCard {
  status: 'noaccess';
  url: string;
}

/** The link needs a Folio user and the chat user has not connected one. */
export interface ChatSignInCard {
  status: 'signin';
  url: string;
}

export type ChatCardResult = ChatCard | ChatNoAccessCard | ChatSignInCard;

const KIND_ICON: Record<ChatCardKind, string> = {
  doc: '📄',
  table: '📊',
  board: '🖼️',
  form: '📝',
  pdf: '📕',
  office: '📎',
  canvas: '🗺️',
  base: '🗂️',
  space: '📚',
};

// ---------------------------------------------------------------------------
// URL classification
// ---------------------------------------------------------------------------

function safeDecode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

const PAGE_RE = /^\/s\/([^/]+)\/p\/([^/]+)\/?$/;
const SPACE_RE = /^\/s\/([^/]+)(?:\/(?:d\/.*)?)?$/;
const SHARE_RE = /^\/share\/([^/.]+)(?:\/p\/([^/]+))?\/?$/;
const PUBLIC_PATH_RE = new RegExp(`^${PUBLIC_SITE_PATH_PREFIX}/([a-z0-9][a-z0-9-]*)(?:/p/([^/]+))?/?$`);
const SITE_HOST_RE = /^\/(?:p\/([^/]+)\/?)?$/;

/**
 * What a URL points at on this instance, or undefined when it is not a Folio URL we preview.
 * `originFallback` is the instance origin to use when PUBLIC_URL is unset (the request's own).
 */
export async function classifyFolioUrl(raw: string, originFallback: string): Promise<FolioTarget | undefined> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const pathname = url.pathname;

  if (host === mainHost(originFallback)) {
    let m = PAGE_RE.exec(pathname);
    if (m) {
      const space = safeDecode(m[1]);
      const pageId = safeDecode(m[2]);
      return space && pageId ? { type: 'page', space, pageId } : undefined;
    }
    m = SHARE_RE.exec(pathname);
    if (m) {
      const token = safeDecode(m[1]);
      const pageId = m[2] ? safeDecode(m[2]) : undefined;
      if (!token || (m[2] && !pageId)) return undefined;
      return { type: 'share', token, ...(pageId ? { pageId } : {}) };
    }
    m = PUBLIC_PATH_RE.exec(pathname);
    if (m) {
      const site = await getPublicSpace(m[1]);
      const pageId = m[2] ? safeDecode(m[2]) : undefined;
      return site ? { type: 'public', site, hostMode: false, ...(pageId ? { pageId } : {}) } : undefined;
    }
    m = SPACE_RE.exec(pathname);
    if (m) {
      const space = safeDecode(m[1]);
      return space ? { type: 'space', space } : undefined;
    }
    return undefined;
  }

  // A published space on its own host (subdomain / custom domain).
  const site = await resolvePublicSiteByHost(host);
  if (!site) return undefined;
  const m = SITE_HOST_RE.exec(pathname);
  if (!m) return undefined;
  const pageId = m[1] ? safeDecode(m[1]) : undefined;
  return { type: 'public', site, hostMode: true, ...(pageId ? { pageId } : {}) };
}

/** True for targets a viewer without a Folio account can still get a full card for. */
export function isAnonymousTarget(target: FolioTarget): boolean {
  return target.type === 'share' || target.type === 'public';
}

// ---------------------------------------------------------------------------
// Content pieces
// ---------------------------------------------------------------------------

/** Plain text for a preview: no front matter, no headings (the card shows the title and lists headings), no markup. */
export function plainExcerpt(body: string, title: string, maxLen = EXCERPT_MAX_CHARS): string {
  let text = (body || '').replace(/^---[\s\S]*?\n---\s*\n/, '');
  // The page's own H1 is its title, and the card lists the headings: neither belongs in the text.
  text = text.replace(/^\s*#\s+(.+)\n/, (line, h1: string) => (h1.trim() === title.trim() ? '' : line));
  text = text
    .replace(/^#{1,6}\s+.*$/gm, ' ') // headings
    .replace(/^(?:\s*:{2,}.*)$/gm, ' ') // directive lines (::pagetree, :::callout, :::)
    .replace(/<[^>]+>/g, ' ') // inline HTML
    .replace(/!\[\[[^\]]*]]/g, ' ') // embeds
    .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?]]/g, (_m, target: string, label?: string) => label ?? target) // wikilinks
    .replace(/\$\$[\s\S]*?\$\$/g, ' ') // display math
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, ' ') // table separator rows
    .replace(/\|/g, ' ')
    .replace(/\^[A-Za-z0-9-]+\s*$/gm, ''); // block ids
  return excerptFromMarkdown(text, maxLen);
}

function defaultIcon(kind: ChatCardKind, icon?: string): string {
  // Only a short emoji-like value is an icon a chat client can show as text.
  if (icon && icon.length <= 8 && !/[a-z0-9:/]/i.test(icon)) return icon;
  return KIND_ICON[kind];
}

async function spaceName(space: string): Promise<string> {
  const row = await queryOne<{ name: string }>('SELECT name FROM spaces WHERE slug = $1', [space]);
  return row?.name ?? space;
}

async function headingsOf(pageId: string): Promise<string[]> {
  const rows = await query<{ text: string }>(
    'SELECT text FROM page_headings WHERE page_id = $1 AND level IN (2, 3) ORDER BY position LIMIT $2',
    [pageId, MAX_HEADINGS],
  );
  return rows.map((r) => r.text.trim()).filter(Boolean);
}

async function tagsOf(pageId: string): Promise<string[]> {
  const rows = await query<{ tag: string }>(
    `SELECT tag FROM (SELECT tag, MIN(COALESCE(line, -1)) AS first FROM page_tags WHERE page_id = $1 GROUP BY tag) t ORDER BY first, tag LIMIT $2`,
    [pageId, MAX_TAGS],
  );
  return rows.map((r) => r.tag);
}

async function isRestricted(entry: Pick<PageIndexEntry, 'id' | 'relPath'>): Promise<boolean> {
  if (isAgentPath(entry.relPath)) return true;
  return (await queryOne<{ id: string }>('SELECT page_id AS id FROM page_access WHERE page_id = $1', [entry.id])) !== undefined;
}

/** Last committer of the page file (git history), best effort and bounded: a slow or missing repo just leaves it out. */
async function updatedByOf(pageId: string): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const history = await Promise.race([
      gitSync.getPageHistory(pageId, 1),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), UPDATED_BY_TIMEOUT_MS);
      }),
    ]);
    const author = history[0]?.author?.trim();
    return author || undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The folders above a page, outermost first (the space root excluded): "a", "a/b" for "a/b/page.md". */
function ancestorDirs(entry: Pick<PageIndexEntry, 'dirPath' | 'isIndex'>): string[] {
  const own = entry.isIndex ? entry.dirPath.split('/').slice(0, -1).join('/') : entry.dirPath;
  if (!own) return [];
  const parts = own.split('/');
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

/**
 * Breadcrumb levels between the space and the page: each folder's index page title when `canRead`
 * says the viewer may see it and it is open to the whole space; "…" otherwise (a folder without an
 * index page shows its own name — it is visible in the tree to every reader of the space).
 */
async function parentTitles(entry: PageIndexEntry, canRead: (parent: PageIndexEntry) => Promise<boolean>): Promise<string[]> {
  const dirs = ancestorDirs(entry);
  if (dirs.length === 0) return [];
  const candidates = dirs.flatMap((d) => [`${d}/index.md`, `${d}/README.md`]);
  const rows = await query<{ id: string; path: string }>(
    'SELECT id, path FROM pages_index WHERE space_slug = $1 AND is_index AND path = ANY($2)',
    [entry.space, candidates],
  );
  const byPath = new Map(rows.map((r) => [r.path, r.id]));
  const out: string[] = [];
  for (const dir of dirs) {
    const id = byPath.get(`${dir}/index.md`) ?? byPath.get(`${dir}/README.md`);
    if (!id) {
      out.push(dir.split('/').pop()!);
      continue;
    }
    const parent = await storage.getEntry(id);
    out.push(parent && (await canRead(parent)) && !(await isRestricted(parent)) ? parent.title : '…');
  }
  return out;
}

interface ContentOptions {
  limited: boolean;
  withUpdatedBy: boolean;
}

/** Title, icon, excerpt, headings, tags and the per-kind facts of one page the caller may show. */
async function pageContent(entry: PageIndexEntry, opts: ContentOptions): Promise<Omit<ChatCard, 'status' | 'url' | 'breadcrumb' | 'access'>> {
  const base = {
    title: entry.title?.trim() || 'Untitled',
    icon: defaultIcon(entry.kind, entry.icon),
    kind: entry.kind as ChatCardKind,
    updatedAt: entry.updatedAt,
  };
  if (opts.limited) return { ...base, limited: true };
  const out: Omit<ChatCard, 'status' | 'url' | 'breadcrumb' | 'access'> = { ...base };
  if (entry.kind === 'doc') {
    const excerpt = plainExcerpt(entry.body ?? '', base.title);
    if (excerpt) out.excerpt = excerpt;
    const headings = await headingsOf(entry.id);
    if (headings.length) out.headings = headings;
  } else if (entry.kind === 'table') {
    try {
      const doc = await storage.readFreshTableDoc(entry.id);
      out.table = { rows: doc.rows.length, columns: doc.columns.map((c) => c.name).filter(Boolean).slice(0, MAX_COLUMNS) };
      const excerpt = plainExcerpt(`${doc.head}\n${doc.tail}`, base.title);
      if (excerpt) out.excerpt = excerpt;
    } catch {
      // unreadable file: title only
    }
  } else if (entry.kind === 'form') {
    try {
      const doc = await storage.readFreshFormDoc(entry.id);
      out.form = { fields: doc.fields.length };
      const excerpt = plainExcerpt(doc.description ?? '', base.title);
      if (excerpt) out.excerpt = excerpt;
    } catch {
      // unreadable file: title only
    }
  } else if (entry.kind === 'pdf' || entry.kind === 'office') {
    out.file = (entry.relPath.split('.').pop() ?? '').toUpperCase();
  }
  if (entry.kind !== 'board') {
    const tags = await tagsOf(entry.id);
    if (tags.length) out.tags = tags;
  }
  if (opts.withUpdatedBy) {
    const by = await updatedByOf(entry.id);
    if (by) out.updatedBy = by;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

async function memberPageCard(url: string, viewer: User, pageId: string): Promise<ChatCardResult> {
  let entry: PageIndexEntry | undefined;
  try {
    entry = await storage.getEntry(pageId);
  } catch {
    entry = undefined; // a synthetic folder id
  }
  if (!entry) return { status: 'noaccess', url };
  const role = await session.effectivePageRole(viewer, entry);
  if (!role) return { status: 'noaccess', url };
  const limited = await isRestricted(entry);
  const content = await pageContent(entry, { limited, withUpdatedBy: true });
  const breadcrumb = [await spaceName(entry.space), ...(await parentTitles(entry, async (p) => (await session.effectivePageRole(viewer, p)) !== undefined))];
  return { status: 'ok', url, breadcrumb, access: 'member', ...content };
}

async function memberSpaceCard(url: string, viewer: User, space: string): Promise<ChatCardResult> {
  if (!(await storage.spaceExists(space))) return { status: 'noaccess', url };
  if (!(await session.effectiveRole(viewer, space))) return { status: 'noaccess', url };
  const card: ChatCard = { status: 'ok', url, title: await spaceName(space), icon: KIND_ICON.space, kind: 'space', breadcrumb: [], access: 'member' };
  try {
    const home = await storage.resolve(space, '');
    const entry = await storage.getEntry(home.id);
    if (entry && entry.kind === 'doc' && (await session.effectivePageRole(viewer, entry)) && !(await isRestricted(entry))) {
      const excerpt = plainExcerpt(entry.body ?? '', entry.title);
      if (excerpt) card.excerpt = excerpt;
      const headings = await headingsOf(entry.id);
      if (headings.length) card.headings = headings;
      card.updatedAt = entry.updatedAt;
    }
  } catch {
    // a space without a root page: the name alone
  }
  return card;
}

/** A share link: the token is the credential. Its own page set (export/shareScope.ts), nothing else. */
async function shareCard(url: string, token: string, pageId: string | undefined): Promise<ChatCardResult> {
  const scope = await resolveShareScope(token).catch(() => undefined);
  if (!scope) return { status: 'noaccess', url };
  let entry = scope.root;
  if (pageId && pageId !== scope.root.id) {
    if (!scope.collected.ids.has(pageId)) return { status: 'noaccess', url };
    const child = await storage.getEntry(pageId);
    if (!child) return { status: 'noaccess', url };
    entry = child;
  }
  // The link was created for exactly this content: full card (the share page shows all of it), no committer names.
  const content = await pageContent(entry, { limited: false, withUpdatedBy: false });
  const breadcrumb = [await spaceName(entry.space)];
  if (entry.id !== scope.root.id) breadcrumb.push(scope.root.title?.trim() || 'Untitled');
  return { status: 'ok', url, breadcrumb, access: 'share', ...content };
}

/** A published space: the public page set (publicSites.ts), the site's name, no committer names. */
async function publicCard(url: string, target: Extract<FolioTarget, { type: 'public' }>): Promise<ChatCardResult> {
  const { site } = target;
  const pageId = target.pageId ?? (await publicHomePageId(site.slug));
  if (!pageId) {
    return { status: 'ok', url, title: site.name, icon: KIND_ICON.space, kind: 'space', breadcrumb: [], access: 'public' };
  }
  const entry = await storage.getEntry(pageId).catch(() => undefined);
  if (!entry || entry.space !== site.slug || !(await isPublicPage({ id: entry.id, space: entry.space, relPath: entry.relPath }))) {
    return { status: 'noaccess', url };
  }
  const content = await pageContent(entry, { limited: false, withUpdatedBy: false });
  const parents = await parentTitles(entry, (p) => isPublicPage({ id: p.id, space: p.space, relPath: p.relPath }));
  return { status: 'ok', url, breadcrumb: [site.name, ...parents], access: 'public', ...content };
}

/**
 * The card for `rawUrl` as seen by `viewer` (null: the chat user has no linked Folio account).
 * undefined: not a Folio URL — leave the link alone. Never throws for a bad URL or a missing page.
 */
export async function buildChatCard(rawUrl: string, viewer: User | null, originFallback: string): Promise<ChatCardResult | undefined> {
  const target = await classifyFolioUrl(rawUrl, originFallback);
  if (!target) return undefined;
  return buildCardForTarget(rawUrl, target, viewer);
}

export async function buildCardForTarget(rawUrl: string, target: FolioTarget, viewer: User | null): Promise<ChatCardResult> {
  if (target.type === 'share') return shareCard(rawUrl, target.token, target.pageId);
  if (target.type === 'public') return publicCard(rawUrl, target);
  if (!viewer || viewer.disabled) return { status: 'signin', url: rawUrl };
  if (target.type === 'page') return memberPageCard(rawUrl, viewer, target.pageId);
  return memberSpaceCard(rawUrl, viewer, target.space);
}

/** The instance base URL (PUBLIC_URL, else the request origin), no trailing slash. */
export function instanceBase(originFallback: string): string {
  return publicUrlOrOrigin(originFallback);
}
