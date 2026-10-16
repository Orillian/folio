/**
 * Slack adapter end to end: signed Events API requests into a real Fastify app on a real PG
 * schema, Slack's Web API and OpenID endpoints answered by a stub, the browser's "Connect Folio"
 * flow played request by request (Sign in with Slack → Folio consent → callback).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../../shared/contracts.js';
import * as authStore from '../../auth/store.js';
import { query, queryOne } from '../../db/pool.js';
import { deleteTestSpace, setUpTestSchema } from '../../db/testSchema.js';
import * as oauthStore from '../../oauth/store.js';
import * as pageAccess from '../../pageAccess.js';
import * as storage from '../../storage.js';
import { CONNECT_COOKIE } from './connect.js';
import { resolveLinkedUser } from './links.js';
import { __drainSlackJobsForTests, __resetSlackForTests, slackSignature, verifySlackSignature } from './slack.js';
import { BASE, approveFolioConsent, buildChatTestApp, cookieFrom, pathOf, resetChatFetch, sessionCookie, stubChatFetch, type RecordedCall } from './testHarness.js';

const SIGNING_SECRET = 'test-signing-secret';
const TEAM = 'T0TEST';
const ENV: Record<string, string> = {
  PUBLIC_URL: BASE,
  FOLIO_SLACK_SIGNING_SECRET: SIGNING_SECRET,
  FOLIO_SLACK_BOT_TOKEN: 'xoxb-test',
  FOLIO_SLACK_CLIENT_ID: '111.222',
  FOLIO_SLACK_CLIENT_SECRET: 'client-secret',
  FOLIO_SLACK_TEAM_ID: TEAM,
};

let teardown: () => Promise<void>;
let app: FastifyInstance;
const saved: Record<string, string | undefined> = {};
let space: string;
let alice: User;
let aliceCookie: string;
let guideId: string;
let secretId: string;
let calls: RecordedCall[];
let idTokenClaims: Record<string, unknown>;

function unsignedJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.c2ln`;
}

async function signedPost(url: string, body: string, opts: { ts?: number; secret?: string; contentType?: string } = {}) {
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  return app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': opts.contentType ?? 'application/json',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': slackSignature(opts.secret ?? SIGNING_SECRET, ts, body),
    },
    payload: body,
  });
}

let eventSeq = 0;
function linkShared(user: string, urls: string[], extra: Record<string, unknown> = {}) {
  eventSeq += 1;
  return JSON.stringify({
    type: 'event_callback',
    team_id: TEAM,
    event_id: `Ev${Date.now()}${eventSeq}`,
    event: { type: 'link_shared', user, channel: 'C123', message_ts: `1700000000.${String(eventSeq).padStart(6, '0')}`, source: 'conversations_history', links: urls.map((url) => ({ url, domain: 'folio.example.com' })), ...extra },
  });
}

const unfurlCalls = () => calls.filter((c) => c.url === 'https://slack.com/api/chat.unfurl');
const pageUrl = (id: string) => `${BASE}/s/${space}/p/${id}`;

/** The whole "Connect Folio" browser flow for Slack user `slackUser`, signed in to Folio as `cookie`. */
async function connect(slackUser: string, cookie: string): Promise<void> {
  const start = await app.inject({ method: 'GET', url: '/api/integrations/slack/connect' });
  expect(start.statusCode).toBe(302);
  const slackAuthorize = new URL(String(start.headers.location));
  expect(slackAuthorize.origin + slackAuthorize.pathname).toBe('https://slack.com/openid/connect/authorize');
  expect(slackAuthorize.searchParams.get('team')).toBe(TEAM);
  expect(slackAuthorize.searchParams.get('redirect_uri')).toBe(`${BASE}/api/integrations/slack/oidc/callback`);
  const connectCookie = cookieFrom(start, CONNECT_COOKIE);
  const state = slackAuthorize.searchParams.get('state')!;
  idTokenClaims = {
    iss: 'https://slack.com',
    aud: ENV.FOLIO_SLACK_CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: slackAuthorize.searchParams.get('nonce'),
    'https://slack.com/team_id': TEAM,
    'https://slack.com/user_id': slackUser,
    name: `Slack ${slackUser}`,
  };
  const oidc = await app.inject({ method: 'GET', url: `/api/integrations/slack/oidc/callback?code=slack-code&state=${encodeURIComponent(state)}`, headers: { cookie: connectCookie } });
  expect(oidc.statusCode).toBe(302);
  const folioAuthorize = String(oidc.headers.location);
  expect(folioAuthorize.startsWith(`${BASE}/oauth/authorize?`)).toBe(true);
  expect(new URL(folioAuthorize).searchParams.get('client_id')).toBe('folio_chat_slack');
  const back = await approveFolioConsent(app, folioAuthorize, cookie);
  expect(back.startsWith(`${BASE}/api/integrations/chat/callback?`)).toBe(true);
  const done = await app.inject({ method: 'GET', url: pathOf(back), headers: { cookie: connectCookie } });
  expect(done.statusCode).toBe(200);
  expect(done.body).toContain('Slack is connected');
  await __drainSlackJobsForTests();
}

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  teardown = await setUpTestSchema();
  app = await buildChatTestApp();
  const stamp = Date.now();
  alice = await authStore.createUser({ email: `slack-alice-${stamp}@test.local`, name: 'Alice', passwordHash: 'x', isAdmin: false });
  aliceCookie = await sessionCookie(alice.id);
  const owner = await authStore.createUser({ email: `slack-owner-${stamp}@test.local`, name: 'Owner', passwordHash: 'x', isAdmin: false });
  space = (await storage.createSpace(`Slack Space ${stamp}`, owner.id)).slug;
  await authStore.setMembership(space, owner.id, 'admin');
  await authStore.setMembership(space, alice.id, 'viewer');
  const dir = storage.getRepoDir(space);
  await fs.writeFile(path.join(dir, 'guide.md'), '# Guide\n\nHow to deploy <!channel> safely.\n\n## Install\n');
  await fs.writeFile(path.join(dir, 'secret.md'), '# Top secret\n\nHidden.\n');
  await storage.scanSpace(space);
  guideId = (await storage.getEntryIdByExactPath(space, 'guide.md'))!;
  secretId = (await storage.getEntryIdByExactPath(space, 'secret.md'))!;
  await pageAccess.setAccess(owner, await storage.requireEntry(secretId), 'restricted', []);
});

afterAll(async () => {
  resetChatFetch();
  await app.close();
  await deleteTestSpace(space);
  await teardown();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  __resetSlackForTests();
  calls = stubChatFetch({
    'https://slack.com/api/chat.unfurl': () => ({ ok: true }),
    'https://slack.com/api/openid.connect.token': () => ({ ok: true, access_token: 'xoxp-test', id_token: unsignedJwt(idTokenClaims) }),
  });
});
afterEach(() => resetChatFetch());

describe('request signature', () => {
  it('accepts a good signature, refuses a bad one and a replay older than five minutes', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const good = await signedPost('/api/integrations/slack/events', body);
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ challenge: 'abc123' });

    expect((await signedPost('/api/integrations/slack/events', body, { secret: 'wrong' })).statusCode).toBe(401);
    const old = Math.floor(Date.now() / 1000) - 6 * 60;
    expect((await signedPost('/api/integrations/slack/events', body, { ts: old })).statusCode).toBe(401);
    const tampered = await app.inject({
      method: 'POST',
      url: '/api/integrations/slack/events',
      headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)), 'x-slack-signature': slackSignature(SIGNING_SECRET, String(Math.floor(Date.now() / 1000)), body) },
      payload: body.replace('abc123', 'evil'),
    });
    expect(tampered.statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/integrations/slack/events', headers: { 'content-type': 'application/json' }, payload: body })).statusCode).toBe(401);
  });

  it('verifySlackSignature: ok, bad, stale', () => {
    const now = 1_800_000_000_000;
    const ts = String(now / 1000);
    expect(verifySlackSignature('s', 'body', ts, slackSignature('s', ts, 'body'), now)).toBe('ok');
    expect(verifySlackSignature('s', 'body', ts, slackSignature('t', ts, 'body'), now)).toBe('bad');
    expect(verifySlackSignature('s', 'body', ts, slackSignature('s', ts, 'body'), now + 301_000)).toBe('stale');
    expect(verifySlackSignature('s', 'body', undefined, 'v0=x', now)).toBe('bad');
  });

  it('acknowledges interactions (the Open in Folio button)', async () => {
    const payload = `payload=${encodeURIComponent(JSON.stringify({ type: 'block_actions' }))}`;
    const res = await signedPost('/api/integrations/slack/interactions', payload, { contentType: 'application/x-www-form-urlencoded' });
    expect(res.statusCode).toBe(200);
  });

  it('a platform without configuration answers 404', async () => {
    const prev = process.env.FOLIO_SLACK_BOT_TOKEN;
    delete process.env.FOLIO_SLACK_BOT_TOKEN;
    try {
      expect((await signedPost('/api/integrations/slack/events', '{}')).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/integrations/slack/connect' })).statusCode).toBe(404);
    } finally {
      process.env.FOLIO_SLACK_BOT_TOKEN = prev;
    }
  });
});

describe('link_shared', () => {
  it('an unconnected poster gets the unfurl-auth prompt; after connecting, the message is unfurled', async () => {
    const res = await signedPost('/api/integrations/slack/events', linkShared('U_ALICE', [pageUrl(guideId)]));
    expect(res.statusCode).toBe(200);
    await __drainSlackJobsForTests();
    const [prompt] = unfurlCalls();
    expect(prompt.headers.authorization).toBe('Bearer xoxb-test');
    const pb = prompt.body as Record<string, unknown>;
    expect(pb.channel).toBe('C123');
    expect(pb.unfurls).toEqual({});
    expect(pb.user_auth_url).toBe(`${BASE}/api/integrations/slack/connect`);
    expect(JSON.stringify(pb.user_auth_blocks)).toContain('Connect Folio');
    expect(JSON.stringify(pb)).not.toContain('Guide');

    calls.length = 0;
    await connect('U_ALICE', aliceCookie);
    const replay = unfurlCalls();
    expect(replay).toHaveLength(1);
    const rb = replay[0].body as { channel: string; ts: string; unfurls: Record<string, { blocks: unknown[] }> };
    expect(rb.channel).toBe('C123');
    expect(rb.ts).toBe((pb as { ts: string }).ts);
    expect(JSON.stringify(rb.unfurls[pageUrl(guideId)])).toContain('Guide');

    const link = await queryOne<{ access_token_enc: Buffer; platform_user_name: string }>(`SELECT * FROM chat_links WHERE platform = 'slack' AND platform_user_id = 'U_ALICE'`);
    expect(link?.platform_user_name).toBe('Slack U_ALICE');
    expect(link!.access_token_enc.toString('utf8')).not.toContain('folio_oat_'); // encrypted at rest
  });

  it('a connected poster: the card of a page they can open; title-less for one they cannot', async () => {
    await signedPost('/api/integrations/slack/events', linkShared('U_ALICE', [pageUrl(guideId), pageUrl(secretId), 'https://elsewhere.example.net/x']));
    await __drainSlackJobsForTests();
    const [call] = unfurlCalls();
    const unfurls = (call.body as { unfurls: Record<string, { blocks: Array<Record<string, unknown>> }> }).unfurls;
    expect(Object.keys(unfurls).sort()).toEqual([pageUrl(guideId), pageUrl(secretId)].sort());
    const guide = unfurls[pageUrl(guideId)].blocks;
    expect(guide[0]).toEqual({ type: 'header', text: { type: 'plain_text', text: '📄 Guide', emoji: true } });
    // page text goes out as plain_text with markup stripped: a "<!channel>" in a page never pings anyone
    expect(JSON.stringify(guide)).toContain('"type":"plain_text","text":"How to deploy safely."');
    const button = guide.find((b) => b.type === 'actions') as { elements: Array<{ url: string; text: { text: string } }> };
    expect(button.elements[0]).toMatchObject({ url: pageUrl(guideId), text: { text: 'Open in Folio' } });
    const secret = JSON.stringify(unfurls[pageUrl(secretId)]);
    expect(secret).not.toContain('Top secret');
    expect(secret).toContain('Folio page');
  });

  it('a redelivered event (same event_id) is unfurled once', async () => {
    const body = linkShared('U_ALICE', [pageUrl(guideId)]);
    await signedPost('/api/integrations/slack/events', body);
    await signedPost('/api/integrations/slack/events', body);
    await __drainSlackJobsForTests();
    expect(unfurlCalls()).toHaveLength(1);
  });

  it('another workspace is ignored', async () => {
    const body = JSON.parse(linkShared('U_ALICE', [pageUrl(guideId)]));
    body.team_id = 'T_OTHER';
    await signedPost('/api/integrations/slack/events', JSON.stringify(body));
    await __drainSlackJobsForTests();
    expect(unfurlCalls()).toHaveLength(0);
  });

  it('a composer preview of an unconnected poster does not prompt (the posted message will)', async () => {
    await signedPost('/api/integrations/slack/events', linkShared('U_NOBODY', [pageUrl(guideId)], { source: 'composer', unfurl_id: 'U1', channel: 'COMPOSER' }));
    await __drainSlackJobsForTests();
    expect(unfurlCalls()).toHaveLength(0);
  });
});

describe('the link itself', () => {
  it('refreshes an expired access token by rotation, once, even when two previews race', async () => {
    await query(`UPDATE chat_links SET access_expires_at = now() - interval '1 hour' WHERE platform_user_id = 'U_ALICE'`);
    const [a, b] = await Promise.all([resolveLinkedUser('slack', TEAM, 'U_ALICE'), resolveLinkedUser('slack', TEAM, 'U_ALICE')]);
    expect(a?.id).toBe(alice.id);
    expect(b?.id).toBe(alice.id);
    const row = await queryOne<{ grant_id: string; fresh: boolean }>(`SELECT grant_id, access_expires_at > now() AS fresh FROM chat_links WHERE platform_user_id = 'U_ALICE'`);
    expect(row?.fresh).toBe(true);
    const grant = await queryOne<{ revoked_at: string | null }>('SELECT revoked_at FROM oauth_grants WHERE id = $1', [row!.grant_id]);
    expect(grant?.revoked_at).toBeNull();
  });

  it('the Folio side controls it: Chat apps lists and disconnects it; a revoked grant ends the previews', async () => {
    const mine = await app.inject({ method: 'GET', url: '/api/me/chat-links', headers: { cookie: aliceCookie } });
    expect(mine.statusCode).toBe(200);
    const links = mine.json().links as Array<{ id: string; platform: string }>;
    expect(links).toEqual([expect.objectContaining({ platform: 'slack', platformUserName: 'Slack U_ALICE' })]);
    // not listed among the MCP "Connected apps"
    expect(await oauthStore.listConnections(alice.id)).toEqual([]);

    const row = await queryOne<{ grant_id: string }>(`SELECT grant_id FROM chat_links WHERE platform_user_id = 'U_ALICE'`);
    await oauthStore.revokeGrant(row!.grant_id);
    expect(await resolveLinkedUser('slack', TEAM, 'U_ALICE')).toBeNull();

    await connect('U_ALICE', aliceCookie);
    expect((await resolveLinkedUser('slack', TEAM, 'U_ALICE'))?.id).toBe(alice.id);
    const again = (await app.inject({ method: 'GET', url: '/api/me/chat-links', headers: { cookie: aliceCookie } })).json().links as Array<{ id: string }>;
    const del = await app.inject({ method: 'DELETE', url: `/api/me/chat-links/${again[0].id}`, headers: { cookie: aliceCookie } });
    expect(del.statusCode).toBe(200);
    expect(await resolveLinkedUser('slack', TEAM, 'U_ALICE')).toBeNull();
  });

  it('refuses a callback without the browser cookie, and a Slack identity of another workspace', async () => {
    const start = await app.inject({ method: 'GET', url: '/api/integrations/slack/connect' });
    const state = new URL(String(start.headers.location)).searchParams.get('state')!;
    const noCookie = await app.inject({ method: 'GET', url: `/api/integrations/slack/oidc/callback?code=x&state=${encodeURIComponent(state)}` });
    expect(noCookie.statusCode).toBe(400);

    const start2 = await app.inject({ method: 'GET', url: '/api/integrations/slack/connect' });
    const authorize = new URL(String(start2.headers.location));
    idTokenClaims = {
      iss: 'https://slack.com',
      aud: ENV.FOLIO_SLACK_CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce: authorize.searchParams.get('nonce'),
      'https://slack.com/team_id': 'T_OTHER',
      'https://slack.com/user_id': 'U_X',
    };
    const wrong = await app.inject({
      method: 'GET',
      url: `/api/integrations/slack/oidc/callback?code=x&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
      headers: { cookie: cookieFrom(start2, CONNECT_COOKIE) },
    });
    expect(wrong.statusCode).toBe(403);
  });

  it('an admin sees the status (no secrets) and every link', async () => {
    const admin = await authStore.createUser({ email: `slack-admin-${Date.now()}@test.local`, name: 'Admin', passwordHash: 'x', isAdmin: true });
    const cookie = await sessionCookie(admin.id);
    const status = await app.inject({ method: 'GET', url: '/api/admin/integrations/chat', headers: { cookie } });
    expect(status.statusCode).toBe(200);
    const info = status.json();
    expect(info.slack.configured).toBe(true);
    expect(info.slack.endpoints.eventsRequestUrl).toBe(`${BASE}/api/integrations/slack/events`);
    expect(info.slack.domains).toEqual(['folio.example.com']);
    expect(JSON.stringify(info)).not.toContain(SIGNING_SECRET);
    expect(JSON.stringify(info)).not.toContain('xoxb-test');
    expect((await app.inject({ method: 'GET', url: '/api/admin/integrations/chat', headers: { cookie: aliceCookie } })).statusCode).toBe(403);
    const manifest = await app.inject({ method: 'GET', url: '/api/admin/integrations/chat/slack-manifest.yaml', headers: { cookie } });
    expect(manifest.body).toContain('request_url: https://folio.example.com/api/integrations/slack/events');
    expect(manifest.body).toContain('- link_shared');
  });
});
