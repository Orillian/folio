import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EMBED_MAX_DEPTH, type EmbedPayload } from '@shared/contracts';
import { Markdown } from './index';
import type { MarkdownPublicSite } from './publicSite';
import { fragmentHash } from './wikilinks';
import './i18n/register';

/**
 * `![[Note]]` / `![[Note#Heading]]` / `![[Note#^block]]` in the reading view
 * (Obsidian vault compatibility, wave 2): the embedded note (or its section,
 * or its block) drawn read-only inside the page, under a link to its source.
 * The text comes from `GET /api/pages/:id/embed` (the public counterpart on a
 * public site), which checks the READER's rights on the server; nothing here
 * decides who may see what.
 *
 * Depth and cycles: `depth` is the nesting level of this embed (1 = inside the
 * page being shown), the server refuses above EMBED_MAX_DEPTH, and `chain` is
 * the ids of the pages this one is nested in - an embed of a page already in
 * the chain is not fetched, a note says so instead.
 */

export interface EmbedViewProps {
  pageId: string;
  /** As written after `#` in `![[Note#...]]`, or null for the whole note. */
  fragment: string | null;
  /** The name written in the link - shown until the note arrives. */
  label: string;
  depth: number;
  /** Ids of the pages above this embed, the one being shown first. */
  chain: readonly string[];
  publicSite?: MarkdownPublicSite;
}

type EmbedProblem = 'missing' | 'fragment' | 'forbidden' | 'unsupported' | 'failed';
type EmbedState = { status: 'loading' } | { status: 'ready'; payload: EmbedPayload } | { status: 'problem'; problem: EmbedProblem };

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; state: EmbedState }>();
const inflight = new Map<string, Promise<EmbedState>>();

function embedUrl(pageId: string, fragment: string | null, depth: number, publicSpace: string | undefined): string {
  const query = new URLSearchParams({ depth: String(depth) });
  if (fragment) query.set('fragment', fragment);
  const base = publicSpace
    ? `/api/public/spaces/${encodeURIComponent(publicSpace)}/pages/${encodeURIComponent(pageId)}/embed`
    : `/api/pages/${encodeURIComponent(pageId)}/embed`;
  return `${base}?${query.toString()}`;
}

async function load(url: string): Promise<EmbedState> {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (res.ok) return { status: 'ready', payload: (await res.json()) as EmbedPayload };
    const message = ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? '';
    if (res.status === 404) return { status: 'problem', problem: /fragment/i.test(message) ? 'fragment' : 'missing' };
    if (res.status === 403 || res.status === 401) return { status: 'problem', problem: 'forbidden' };
    if (res.status === 400) return { status: 'problem', problem: 'unsupported' };
    return { status: 'problem', problem: 'failed' };
  } catch {
    return { status: 'problem', problem: 'failed' };
  }
}

/** One request per embed per half minute: a re-render of the page (a language switch, a late wikilink answer) redraws its embeds without asking again. */
function fetchEmbed(url: string): Promise<EmbedState> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.state);
  const pending = inflight.get(url);
  if (pending) return pending;
  const request = load(url)
    .then((state) => {
      if (state.status === 'ready') cache.set(url, { at: Date.now(), state });
      return state;
    })
    .finally(() => {
      inflight.delete(url);
    });
  inflight.set(url, request);
  return request;
}

/** Testing hook. */
export function clearEmbedCache(): void {
  cache.clear();
  inflight.clear();
}

export function EmbedView({ pageId, fragment, label, depth, chain, publicSite }: EmbedViewProps) {
  const { t } = useTranslation('markdown');
  const cycle = chain.includes(pageId);
  const tooDeep = depth > EMBED_MAX_DEPTH;
  const publicSpace = publicSite?.space;
  const url = embedUrl(pageId, fragment, depth, publicSpace);
  // One stable object per (depth, chain): <Markdown> keeps its rendered output while its props are the same.
  const chainKey = chain.join('|');
  const nested = useMemo(() => ({ depth, chain: [...chain, pageId] }), [depth, chainKey, pageId]);
  const [state, setState] = useState<EmbedState>(() => {
    const hit = cache.get(url);
    return hit ? hit.state : { status: 'loading' };
  });

  useEffect(() => {
    if (cycle || tooDeep) return;
    let cancelled = false;
    void fetchEmbed(url).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [url, cycle, tooDeep]);

  if (cycle) return <p className="folio-embed__note">{t('embed.cycle', { title: label })}</p>;
  if (tooDeep) return <p className="folio-embed__note">{t('embed.depth', { max: EMBED_MAX_DEPTH })}</p>;
  if (state.status === 'loading') return <p className="folio-embed__note">{t('embed.loading', { title: label })}</p>;
  if (state.status === 'problem') {
    return <p className="folio-embed__note folio-embed__note--problem">{t(`embed.${state.problem}`, { title: label })}</p>;
  }

  const { payload } = state;
  const hash = fragmentHash(fragment);
  const href = publicSite ? `${publicSite.pageUrl(payload.id)}${hash}` : `/s/${encodeURIComponent(payload.space)}/p/${encodeURIComponent(payload.id)}${hash}`;
  return (
    <>
      <a className="folio-embed__title" href={href} data-folio-nav={href} title={t('embed.open', { title: payload.title })}>
        {payload.title}
        {fragment ? <span className="folio-embed__fragment"> &rsaquo; {fragment}</span> : null}
      </a>
      <Markdown
        markdown={payload.markdown}
        space={payload.space}
        pagePath={payload.path}
        pageId={payload.id}
        publicSite={publicSite}
        embedded={nested}
      />
    </>
  );
}
