/**
 * Microsoft Teams adapter of the chat link previews: a Bot Framework messaging endpoint that
 * answers the link-unfurling invokes of a message extension (learn.microsoft.com, Teams
 * "Link unfurling" and "Zero install link unfurling").
 *
 *   POST /api/integrations/teams/messages
 *
 * Authentication (Bot Framework "Authenticate requests from the Bot Connector service"): the
 * `Authorization: Bearer` JWT must be RS256-signed by a key from the Bot Connector's OpenID
 * metadata (https://login.botframework.com/v1/.well-known/openidconfiguration → jwks_uri; cached
 * 12 h, refetched at most every 5 min for an unknown key id), whose `endorsements` include the
 * activity's channelId; issuer https://api.botframework.com; audience = FOLIO_TEAMS_APP_ID;
 * 5 minutes clock skew; its `serviceUrl` claim equal to the activity's serviceUrl. Anything else
 * is a 401/403 before the activity is looked at. Single tenant: an activity from any tenant but
 * FOLIO_TEAMS_TENANT_ID is refused.
 *
 * Invokes (answered in the HTTP response itself — no outbound call, so the app password is not
 * needed for previews):
 *   composeExtension/queryLink           a link pasted by a Teams user: the card for their linked
 *                                        Folio user; not linked → an `auth` response whose sign-in
 *                                        URL carries a signed ticket (ticket.ts). After the popup,
 *                                        Teams re-sends the query with `value.state` = the one-time
 *                                        code, which completes the link (links.completeTeamsLink).
 *   composeExtension/anonymousQueryLink  zero-install: no identity. Share links and public pages get
 *                                        their card; anything else an `auth` response with a
 *                                        pre-auth card (Teams adds its own sign-in button).
 * The card is an Adaptive Card 1.3 (the link-unfurling limit), with the same card as preview, and
 * `setCachePolicy: no-cache`: Teams would otherwise cache a result for 30 minutes, and a card
 * built for one person must not be reused for another.
 */
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';
import { buildCardForTarget, classifyFolioUrl, type ChatCardResult } from './card.js';
import { teamsConfig, type TeamsConfig } from './config.js';
import { chatFetch } from './http.js';
import { completeTeamsLink, resolveLinkedUser } from './links.js';
import {
  CONNECT_FOLIO,
  NOACCESS_TEXT,
  NOACCESS_TITLE,
  OPEN_IN_FOLIO,
  SIGNIN_TEXT,
  breadcrumbLine,
  headingsText,
  kindLine,
  tagsText,
  truncate,
  updatedText,
} from './render.js';
import { signTicket } from './ticket.js';

export const BOT_OPENID_METADATA_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
export const BOT_ISSUER = 'https://api.botframework.com';
const KEY_CACHE_MS = 12 * 60 * 60 * 1000;
const KEY_REFETCH_MIN_MS = 5 * 60 * 1000;
const CLOCK_TOLERANCE_SECONDS = 5 * 60;
const ADAPTIVE = 'application/vnd.microsoft.card.adaptive';

// ---------------------------------------------------------------------------
// Bot Framework JWT
// ---------------------------------------------------------------------------

type BotJwk = JWK & { kid?: string; endorsements?: string[] };

let keyCache: { keys: BotJwk[]; fetchedAt: number } | null = null;
let lastFetchAt = 0;

async function fetchKeys(): Promise<BotJwk[]> {
  lastFetchAt = Date.now();
  const meta = (await (await chatFetch(BOT_OPENID_METADATA_URL)).json()) as { jwks_uri?: unknown; issuer?: unknown };
  if (typeof meta.jwks_uri !== 'string' || !meta.jwks_uri.startsWith('https://')) throw new Error('bot framework metadata has no https jwks_uri');
  const jwks = (await (await chatFetch(meta.jwks_uri)).json()) as { keys?: unknown };
  if (!Array.isArray(jwks.keys)) throw new Error('bot framework jwks has no keys');
  const keys = jwks.keys as BotJwk[];
  keyCache = { keys, fetchedAt: Date.now() };
  return keys;
}

async function keyFor(kid: string): Promise<BotJwk | undefined> {
  const fresh = keyCache && Date.now() - keyCache.fetchedAt < KEY_CACHE_MS;
  let keys = fresh ? keyCache!.keys : await fetchKeys();
  let found = keys.find((k) => k.kid === kid);
  if (!found && fresh && Date.now() - lastFetchAt > KEY_REFETCH_MIN_MS) {
    keys = await fetchKeys();
    found = keys.find((k) => k.kid === kid);
  }
  return found;
}

export function __resetTeamsKeysForTests(): void {
  keyCache = null;
  lastFetchAt = 0;
}

export type BotAuthResult = { ok: true } | { ok: false; status: 401 | 403; reason: string };

/** Validates the Bot Connector's JWT for `activity` (see the module doc for every check). */
export async function verifyBotFrameworkRequest(authorization: string | undefined, activity: { channelId?: unknown; serviceUrl?: unknown }, appId: string): Promise<BotAuthResult> {
  if (!authorization?.startsWith('Bearer ')) return { ok: false, status: 401, reason: 'missing bearer token' };
  const token = authorization.slice('Bearer '.length).trim();
  let kid: string | undefined;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== 'RS256') return { ok: false, status: 401, reason: 'unexpected alg' };
    kid = header.kid;
  } catch {
    return { ok: false, status: 401, reason: 'malformed token' };
  }
  if (!kid) return { ok: false, status: 401, reason: 'no key id' };
  let jwk: BotJwk | undefined;
  try {
    jwk = await keyFor(kid);
  } catch {
    return { ok: false, status: 401, reason: 'signing keys unavailable' };
  }
  if (!jwk) return { ok: false, status: 401, reason: 'unknown signing key' };
  const channelId = typeof activity.channelId === 'string' ? activity.channelId : '';
  if (!channelId || !Array.isArray(jwk.endorsements) || !jwk.endorsements.includes(channelId)) {
    return { ok: false, status: 403, reason: 'key not endorsed for this channel' };
  }
  try {
    const { endorsements: _e, ...plainJwk } = jwk;
    const key = await importJWK({ ...plainJwk, alg: 'RS256' }, 'RS256');
    const { payload } = await jwtVerify(token, key, { issuer: BOT_ISSUER, audience: appId, algorithms: ['RS256'], clockTolerance: CLOCK_TOLERANCE_SECONDS });
    if (typeof activity.serviceUrl !== 'string' || payload.serviceUrl !== activity.serviceUrl) return { ok: false, status: 403, reason: 'serviceUrl mismatch' };
    return { ok: true };
  } catch {
    return { ok: false, status: 401, reason: 'invalid token' };
  }
}

// ---------------------------------------------------------------------------
// Adaptive Cards (1.3). User content only ever goes in TextRun (no markdown is interpreted there).
// ---------------------------------------------------------------------------

type Element = Record<string, unknown>;

function runs(text: string, style: Record<string, unknown> = {}): Element {
  return { type: 'RichTextBlock', inlines: [{ type: 'TextRun', text, ...style }] };
}

function adaptive(body: Element[], url?: string, actionTitle = OPEN_IN_FOLIO): Element {
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.3',
    body,
    ...(url ? { actions: [{ type: 'Action.OpenUrl', title: actionTitle, url }] } : {}),
  };
}

export function teamsCard(card: ChatCardResult): Element {
  if (card.status !== 'ok') {
    return adaptive([runs(`🔒 ${NOACCESS_TITLE}`, { weight: 'Bolder', size: 'Medium' }), runs(card.status === 'signin' ? SIGNIN_TEXT : NOACCESS_TEXT, { isSubtle: true })], card.url);
  }
  const body: Element[] = [runs(truncate(`${card.icon} ${card.title}`, 200), { weight: 'Bolder', size: 'Medium' })];
  const crumb = breadcrumbLine(card);
  if (crumb) body.push(runs(truncate(crumb, 300), { isSubtle: true, size: 'Small' }));
  if (card.excerpt) body.push(runs(card.excerpt));
  const headings = headingsText(card);
  if (headings) body.push(runs(headings));
  for (const line of [kindLine(card), tagsText(card), updatedText(card)]) {
    if (line) body.push(runs(truncate(line, 500), { isSubtle: true, size: 'Small' }));
  }
  return adaptive(body, card.url);
}

function previewCard(card: ChatCardResult): Element {
  if (card.status !== 'ok') return adaptive([runs(`🔒 ${NOACCESS_TITLE}`, { weight: 'Bolder' })]);
  const body: Element[] = [runs(truncate(`${card.icon} ${card.title}`, 200), { weight: 'Bolder' })];
  const crumb = breadcrumbLine(card);
  if (crumb) body.push(runs(truncate(crumb, 300), { isSubtle: true, size: 'Small' }));
  return adaptive(body);
}

const NO_CACHE = { actions: [{ type: 'setCachePolicy', value: JSON.stringify({ type: 'no-cache' }) }] };

export function resultResponse(card: ChatCardResult): Record<string, unknown> {
  return {
    composeExtension: {
      type: 'result',
      attachmentLayout: 'list',
      attachments: [{ contentType: ADAPTIVE, content: teamsCard(card), preview: { contentType: ADAPTIVE, content: previewCard(card) } }],
      suggestedActions: NO_CACHE,
    },
  };
}

const EMPTY_RESULT = { composeExtension: { type: 'result', attachmentLayout: 'list', attachments: [] } };

export function teamsConnectUrl(base: string, ticket: string): string {
  return `${base}/api/integrations/teams/connect?ticket=${encodeURIComponent(ticket)}`;
}

function authResponse(signInUrl: string): Record<string, unknown> {
  return { composeExtension: { type: 'auth', suggestedActions: { actions: [{ type: 'openUrl', value: signInUrl, title: CONNECT_FOLIO }] } } };
}

function preAuthResponse(card: ChatCardResult): Record<string, unknown> {
  return { composeExtension: { type: 'auth', attachmentLayout: 'list', attachments: [{ contentType: ADAPTIVE, content: teamsCard(card) }] } };
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

export interface TeamsActivity {
  type?: string;
  name?: string;
  channelId?: string;
  serviceUrl?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  conversation?: { tenantId?: string };
  channelData?: { tenant?: { id?: string } };
  value?: { url?: unknown; state?: unknown };
}

function tenantOf(activity: TeamsActivity): string | undefined {
  return activity.channelData?.tenant?.id ?? activity.conversation?.tenantId;
}

export interface TeamsReply {
  status: number;
  body: Record<string, unknown>;
}

/** The HTTP answer to one already-authenticated activity. */
export async function handleTeamsActivity(activity: TeamsActivity, base: string, cfg: TeamsConfig = teamsConfig()!): Promise<TeamsReply> {
  if (activity.type !== 'invoke') return { status: 200, body: {} };
  if (tenantOf(activity) !== cfg.tenantId) return { status: 403, body: { error: 'tenant not allowed' } };
  const url = typeof activity.value?.url === 'string' ? activity.value.url : '';
  if (activity.name !== 'composeExtension/queryLink' && activity.name !== 'composeExtension/anonymousQueryLink') return { status: 200, body: {} };
  const target = url ? await classifyFolioUrl(url, base) : undefined;
  if (!target) return { status: 200, body: EMPTY_RESULT };

  if (activity.name === 'composeExtension/anonymousQueryLink') {
    const card = await buildCardForTarget(url, target, null);
    return { status: 200, body: card.status === 'signin' ? preAuthResponse(card) : resultResponse(card) };
  }

  const aad = activity.from?.aadObjectId;
  const tenantId = tenantOf(activity)!;
  let viewer = null;
  if (aad) {
    const identity = { tenantId, platformUserId: aad, platformUserName: activity.from?.name ?? null };
    const state = activity.value?.state;
    if (typeof state === 'string' && state.length > 0 && state.length <= 200) await completeTeamsLink(state, identity);
    viewer = await resolveLinkedUser('teams', tenantId, aad);
  }
  const card: ChatCardResult = await buildCardForTarget(url, target, viewer);
  if (card.status === 'signin') {
    if (!aad) return { status: 200, body: resultResponse(card) };
    const ticket = signTicket({ tenantId, platformUserId: aad, platformUserName: activity.from?.name ?? null });
    return { status: 200, body: authResponse(teamsConnectUrl(base, ticket)) };
  }
  return { status: 200, body: resultResponse(card) };
}

