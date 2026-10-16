/**
 * Slack adapter of the chat link previews (Events API + chat.unfurl, docs.slack.dev
 * "Unfurling links in messages").
 *
 *   POST /api/integrations/slack/events        Events API request URL: url_verification, link_shared
 *   POST /api/integrations/slack/interactions  Interactivity request URL: acknowledges the
 *                                              "Open in Folio" button (a url button still posts here)
 *
 * Every request is authenticated by Slack's v0 signature: HMAC-SHA256 of `v0:<timestamp>:<raw
 * body>` with FOLIO_SLACK_SIGNING_SECRET, compared in constant time; a timestamp more than five
 * minutes away is refused (replay). The handler answers 200 at once and unfurls in the
 * background (Slack retries a slow answer); retried deliveries are recognized by event_id.
 *
 * link_shared: the poster (event.user, in event's team) is resolved to a Folio user through their
 * link (links.ts). Each Folio URL becomes a card (card.ts) for that user and goes back through
 * chat.unfurl with the bot token. A poster with no link gets Slack's unfurl-auth prompt, an
 * ephemeral message only they see (user_auth_url + user_auth_blocks with a "Connect Folio"
 * button); the message is remembered for 30 minutes and unfurled once they connect (a repeated
 * chat.unfurl with the same channel/ts updates the message, per the method reference). Share
 * links and public-site pages never need a link: their own public rules apply.
 *
 * Unfurls are visible to everyone in the channel — see card.ts for what a card leaves out
 * because of that.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { buildChatCard, type ChatCard, type ChatCardResult } from './card.js';
import { slackConfig } from './config.js';
import { chatFetch } from './http.js';
import { addPendingUnfurl, resolveLinkedUser, takePendingUnfurls } from './links.js';
import {
  CONNECT_FOLIO,
  NOACCESS_TEXT,
  NOACCESS_TITLE,
  OPEN_IN_FOLIO,
  breadcrumbLine,
  headingsText,
  kindLine,
  tagsText,
  truncate,
} from './render.js';

export const SLACK_REPLAY_WINDOW_SECONDS = 5 * 60;
/** Links unfurled per message (Slack itself rarely sends more). */
export const MAX_LINKS_PER_EVENT = 10;
const SLACK_API = 'https://slack.com/api';

// ---------------------------------------------------------------------------
// Request signature
// ---------------------------------------------------------------------------

export type SignatureCheck = 'ok' | 'bad' | 'stale';

export function slackSignature(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
}

export function verifySlackSignature(secret: string, rawBody: string, timestamp: string | undefined, signature: string | undefined, nowMs = Date.now()): SignatureCheck {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return 'bad';
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SLACK_REPLAY_WINDOW_SECONDS) return 'stale';
  const expected = Buffer.from(slackSignature(secret, timestamp, rawBody));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected) ? 'ok' : 'bad';
}

// ---------------------------------------------------------------------------
// Block Kit
// ---------------------------------------------------------------------------

type Block = Record<string, unknown>;

const plain = (text: string, max = 3000) => ({ type: 'plain_text', text: truncate(text, max), emoji: true });
/** Escapes the three characters Slack's mrkdwn treats as control (`<!channel>`, links, mentions). */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function openButton(url: string): Block {
  return { type: 'actions', elements: [{ type: 'button', action_id: 'folio_open', text: plain(OPEN_IN_FOLIO, 75), url }] };
}

/** "Updated <date> by Name": the date in each reader's own time zone via Slack's date token. */
function updatedMrkdwn(card: ChatCard): string | undefined {
  if (!card.updatedAt) return undefined;
  const unix = Math.floor(new Date(card.updatedAt).getTime() / 1000);
  if (!Number.isFinite(unix)) return undefined;
  const by = card.updatedBy ? ` by ${escapeMrkdwn(truncate(card.updatedBy, 80))}` : '';
  return `<!date^${unix}^Updated {date_short_pretty}|Updated ${card.updatedAt.slice(0, 10)}>${by}`;
}

/** The unfurl blocks of one card. Page content is always `plain_text`: nothing in it is interpreted. */
export function slackBlocks(card: ChatCardResult): Block[] {
  if (card.status !== 'ok') {
    return [
      { type: 'section', text: plain(`🔒 ${NOACCESS_TITLE}`) },
      { type: 'context', elements: [plain(NOACCESS_TEXT, 2000)] },
      openButton(card.url),
    ];
  }
  const blocks: Block[] = [{ type: 'header', text: plain(`${card.icon} ${card.title}`, 150) }];
  const crumb = breadcrumbLine(card);
  if (crumb) blocks.push({ type: 'context', elements: [plain(crumb, 2000)] });
  if (card.excerpt) blocks.push({ type: 'section', text: plain(card.excerpt) });
  const headings = headingsText(card);
  if (headings) blocks.push({ type: 'section', text: plain(headings) });
  const facts: Record<string, unknown>[] = [];
  const kind = kindLine(card);
  if (kind) facts.push(plain(kind, 2000));
  const tags = tagsText(card);
  if (tags) facts.push(plain(tags, 2000));
  const updated = updatedMrkdwn(card);
  if (updated) facts.push({ type: 'mrkdwn', text: updated });
  if (facts.length) blocks.push({ type: 'context', elements: facts.slice(0, 10) });
  blocks.push(openButton(card.url));
  return blocks;
}

export function connectUrl(base: string): string {
  return `${base}/api/integrations/slack/connect`;
}

export function authPromptBlocks(base: string): Block[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: 'Connect your Folio account to see previews of Folio links you share. Previews show only what you can open in Folio.' } },
    { type: 'actions', elements: [{ type: 'button', action_id: 'folio_connect', style: 'primary', text: plain(CONNECT_FOLIO, 75), url: connectUrl(base) }] },
  ];
}

// ---------------------------------------------------------------------------
// Web API
// ---------------------------------------------------------------------------

export class SlackApiError extends Error {}

export async function slackApi(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cfg = slackConfig();
  if (!cfg) throw new SlackApiError('slack is not configured');
  const res = await chatFetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${cfg.botToken}` },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || json.ok !== true) throw new SlackApiError(`${method}: ${typeof json.error === 'string' ? json.error : `HTTP ${res.status}`}`);
  return json;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

interface LinkSharedEvent {
  type: 'link_shared';
  user?: string;
  channel?: string;
  message_ts?: string;
  unfurl_id?: string;
  source?: string;
  links?: Array<{ url?: string; domain?: string }>;
}

/** Where a chat.unfurl goes: a posted message (channel + ts) or the composer (unfurl_id + source). */
type UnfurlAddress = { channel: string; ts: string } | { unfurl_id: string; source: string };

interface PendingUnfurl {
  address: UnfurlAddress;
  urls: string[];
}

function addressOf(ev: LinkSharedEvent): UnfurlAddress | undefined {
  if (ev.source === 'composer' && ev.unfurl_id) return { unfurl_id: ev.unfurl_id, source: 'composer' };
  if (ev.channel && ev.message_ts) return { channel: ev.channel, ts: ev.message_ts };
  if (ev.unfurl_id && ev.source) return { unfurl_id: ev.unfurl_id, source: ev.source };
  return undefined;
}

async function cardsFor(urls: string[], teamId: string, slackUserId: string, base: string): Promise<{ unfurls: Record<string, { blocks: Block[] }>; needAuth: string[] }> {
  const viewer = await resolveLinkedUser('slack', teamId, slackUserId);
  const unfurls: Record<string, { blocks: Block[] }> = {};
  const needAuth: string[] = [];
  for (const url of urls) {
    const card = await buildChatCard(url, viewer, base);
    if (!card) continue;
    if (card.status === 'signin') {
      needAuth.push(url);
      continue;
    }
    unfurls[url] = { blocks: slackBlocks(card) };
  }
  return { unfurls, needAuth };
}

export async function handleLinkShared(teamId: string, ev: LinkSharedEvent, base: string, log?: FastifyBaseLogger): Promise<void> {
  if (!ev.user) return;
  const address = addressOf(ev);
  if (!address) return;
  const urls = [...new Set((ev.links ?? []).map((l) => l.url).filter((u): u is string => typeof u === 'string' && u.length <= 3000))].slice(0, MAX_LINKS_PER_EVENT);
  if (urls.length === 0) return;
  const { unfurls, needAuth } = await cardsFor(urls, teamId, ev.user, base);

  if (needAuth.length > 0 && !('unfurl_id' in address && address.source === 'composer')) {
    // A preview in the composer would prompt again when the message is posted: ask once, on the posted message.
    await addPendingUnfurl(teamId, ev.user, { address, urls: needAuth } satisfies PendingUnfurl);
    await slackApi('chat.unfurl', {
      ...address,
      unfurls: {},
      user_auth_url: connectUrl(base),
      user_auth_blocks: authPromptBlocks(base),
    }).catch((err: unknown) => log?.info({ err: String(err) }, 'slack unfurl auth prompt not shown'));
  }
  if (Object.keys(unfurls).length > 0) {
    await slackApi('chat.unfurl', { ...address, unfurls }).catch((err: unknown) => log?.warn({ err: String(err) }, 'slack chat.unfurl failed'));
  }
}

/** After a Slack user connects: the messages they posted while unconnected get their previews. */
export async function replayPendingUnfurls(teamId: string, slackUserId: string, base: string, log?: FastifyBaseLogger): Promise<void> {
  const pending = await takePendingUnfurls<PendingUnfurl>(teamId, slackUserId);
  for (const p of pending) {
    const { unfurls } = await cardsFor(p.urls, teamId, slackUserId, base);
    if (Object.keys(unfurls).length === 0) continue;
    await slackApi('chat.unfurl', { ...p.address, unfurls }).catch((err: unknown) => log?.info({ err: String(err) }, 'slack retroactive unfurl failed'));
  }
}

// Background work is tracked so tests (and shutdown) can wait for it.
const jobs = new Set<Promise<void>>();
export function runInBackground(job: () => Promise<void>, log?: FastifyBaseLogger): void {
  const p = job()
    .catch((err: unknown) => log?.error({ err: String(err) }, 'slack integration job failed'))
    .finally(() => jobs.delete(p));
  jobs.add(p);
}
export async function __drainSlackJobsForTests(): Promise<void> {
  while (jobs.size > 0) await Promise.allSettled([...jobs]);
}

const seenEvents = new Map<string, number>();
const SEEN_TTL_MS = 10 * 60 * 1000;
/** True the first time an event id is seen (Slack redelivers on a slow or failed answer). */
export function firstDelivery(eventId: string | undefined): boolean {
  if (!eventId) return true;
  const now = Date.now();
  if (seenEvents.size > 5000) for (const [id, at] of seenEvents) if (now - at > SEEN_TTL_MS) seenEvents.delete(id);
  const at = seenEvents.get(eventId);
  if (at !== undefined && now - at < SEEN_TTL_MS) return false;
  seenEvents.set(eventId, now);
  return true;
}
export function __resetSlackForTests(): void {
  seenEvents.clear();
}

export interface SlackEnvelope {
  type?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event?: { type?: string } & Record<string, unknown>;
}

/** What to answer an (already authenticated) Events API request with; queues the unfurl work. */
export function dispatchSlackEvent(envelope: SlackEnvelope, base: string, log?: FastifyBaseLogger): Record<string, unknown> {
  if (envelope.type === 'url_verification') return { challenge: typeof envelope.challenge === 'string' ? envelope.challenge : '' };
  if (envelope.type !== 'event_callback' || !envelope.event || !envelope.team_id) return {};
  const cfg = slackConfig();
  if (cfg?.teamId && envelope.team_id !== cfg.teamId) return {};
  if (!firstDelivery(envelope.event_id)) return {};
  if (envelope.event.type === 'link_shared') {
    const teamId = envelope.team_id;
    const ev = envelope.event as unknown as LinkSharedEvent;
    runInBackground(() => handleLinkShared(teamId, ev, base, log), log);
  }
  return {};
}
