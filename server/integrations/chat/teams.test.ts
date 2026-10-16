/**
 * Teams adapter end to end: Bot Framework JWTs signed with a locally generated key whose JWKS (and
 * OpenID metadata) a stub serves in place of login.botframework.com; link-unfurling invokes into
 * a real Fastify app on a real PG schema; the sign-in popup flow played request by request.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../../shared/contracts.js';
import * as authStore from '../../auth/store.js';
import { deleteTestSpace, setUpTestSchema } from '../../db/testSchema.js';
import * as pageAccess from '../../pageAccess.js';
import * as shares from '../../shares.js';
import * as storage from '../../storage.js';
import type { ChatCard } from './card.js';
import { CONNECT_COOKIE } from './connect.js';
import { BOT_ISSUER, BOT_OPENID_METADATA_URL, __resetTeamsKeysForTests, teamsCard } from './teams.js';
import { BASE, approveFolioConsent, buildChatTestApp, cookieFrom, pathOf, resetChatFetch, sessionCookie, stubChatFetch } from './testHarness.js';
import { verifyTicket } from './ticket.js';

const APP_ID = '00000000-1111-2222-3333-444444444444';
const TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SERVICE_URL = 'https://smba.trafficmanager.net/emea/';
const JWKS_URL = 'https://login.botframework.com/v1/.well-known/keys';
const ENV: Record<string, string> = { PUBLIC_URL: BASE, FOLIO_TEAMS_APP_ID: APP_ID, FOLIO_TEAMS_TENANT_ID: TENANT };

let teardown: () => Promise<void>;
let app: FastifyInstance;
const saved: Record<string, string | undefined> = {};
let privateKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: Array<JWK & { endorsements?: string[] }>;
let space: string;
let bob: User;
let bobCookie: string;
let guideId: string;
let secretId: string;

async function botToken(claims: Record<string, unknown> = {}, opts: { kid?: string; key?: CryptoKey; issuer?: string; audience?: string; exp?: string | number } = {}): Promise<string> {
  return new SignJWT({ serviceUrl: SERVICE_URL, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? 'test-key' })
    .setIssuer(opts.issuer ?? BOT_ISSUER)
    .setAudience(opts.audience ?? APP_ID)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(opts.key ?? privateKey);
}

function invoke(name: string, url: string, extra: { aad?: string | null; state?: string; tenant?: string; serviceUrl?: string; channelId?: string } = {}) {
  return {
    type: 'invoke',
    name,
    channelId: extra.channelId ?? 'msteams',
    serviceUrl: extra.serviceUrl ?? SERVICE_URL,
    from: extra.aad === null ? { id: 'redacted', name: 'redacted' } : { id: '29:abc', name: 'Bob Teams', aadObjectId: extra.aad ?? 'aad-bob' },
    conversation: { tenantId: extra.tenant ?? TENANT },
    channelData: { tenant: { id: extra.tenant ?? TENANT } },
    value: { url, ...(extra.state ? { state: extra.state } : {}) },
  };
}

async function post(activity: unknown, token?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/integrations/teams/messages',
    headers: { 'content-type': 'application/json', ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}) },
    payload: JSON.stringify(activity),
  });
}

const pageUrl = (id: string) => `${BASE}/s/${space}/p/${id}`;

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  teardown = await setUpTestSchema();
  app = await buildChatTestApp();
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  const pub = await exportJWK(pair.publicKey);
  const unendorsed = await exportJWK((await generateKeyPair('RS256', { extractable: true })).publicKey);
  jwks = [
    { ...pub, kid: 'test-key', use: 'sig', endorsements: ['msteams', 'skype'] },
    { ...unendorsed, kid: 'webchat-only', use: 'sig', endorsements: ['webchat'] },
  ];

  const stamp = Date.now();
  bob = await authStore.createUser({ email: `teams-bob-${stamp}@test.local`, name: 'Bob', passwordHash: 'x', isAdmin: false });
  bobCookie = await sessionCookie(bob.id);
  const owner = await authStore.createUser({ email: `teams-owner-${stamp}@test.local`, name: 'Owner', passwordHash: 'x', isAdmin: false });
  space = (await storage.createSpace(`Teams Space ${stamp}`, owner.id)).slug;
  await authStore.setMembership(space, owner.id, 'admin');
  await authStore.setMembership(space, bob.id, 'viewer');
  const dir = storage.getRepoDir(space);
  await fs.writeFile(path.join(dir, 'guide.md'), '# Guide\n\nHow we *ship* releases.\n\n## Checklist\n');
  await fs.writeFile(path.join(dir, 'secret.md'), '# Board minutes\n\nConfidential.\n');
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
  __resetTeamsKeysForTests();
  stubChatFetch({
    [BOT_OPENID_METADATA_URL]: () => ({ issuer: BOT_ISSUER, jwks_uri: JWKS_URL, id_token_signing_alg_values_supported: ['RS256'] }),
    [JWKS_URL]: () => ({ keys: jwks }),
  });
});

describe('Bot Framework JWT', () => {
  const activity = () => invoke('composeExtension/queryLink', `${BASE}/s/x/p/y`);

  it('accepts a correctly signed token for this bot', async () => {
    expect((await post(activity(), await botToken())).statusCode).toBe(200);
  });

  it.each([
    ['no Authorization header', async () => undefined, 401],
    ['wrong audience', async () => botToken({}, { audience: 'another-bot' }), 401],
    ['wrong issuer', async () => botToken({}, { issuer: 'https://sts.windows.net/x/' }), 401],
    ['expired (beyond the 5 min skew)', async () => botToken({}, { exp: Math.floor(Date.now() / 1000) - 600 }), 401],
    ['signed by an unknown key', async () => botToken({}, { key: otherKey }), 401],
    ['unknown key id', async () => botToken({}, { kid: 'nope' }), 401],
    ['key not endorsed for msteams', async () => botToken({}, { kid: 'webchat-only' }), 403],
    ['serviceUrl claim of another service', async () => botToken({ serviceUrl: 'https://evil.example.net/' }), 403],
  ])('refuses: %s', async (_label, token, status) => {
    expect((await post(activity(), await token())).statusCode).toBe(status);
  });

  it('refuses an unsigned token', async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = `${b64({ alg: 'none', kid: 'test-key' })}.${b64({ iss: BOT_ISSUER, aud: APP_ID, serviceUrl: SERVICE_URL, exp: 9999999999 })}.`;
    expect((await post(activity(), forged)).statusCode).toBe(401);
  });

  it('refuses another tenant', async () => {
    const res = await post(invoke('composeExtension/queryLink', pageUrl(guideId), { tenant: 'ffffffff-0000-0000-0000-000000000000' }), await botToken());
    expect(res.statusCode).toBe(403);
  });
});

describe('composeExtension/queryLink', () => {
  it('unconnected: an auth response; the sign-in popup flow then links this Teams user only', async () => {
    const first = await post(invoke('composeExtension/queryLink', pageUrl(guideId)), await botToken());
    expect(first.statusCode).toBe(200);
    const ext = first.json().composeExtension;
    expect(ext.type).toBe('auth');
    const action = ext.suggestedActions.actions[0];
    expect(action).toMatchObject({ type: 'openUrl', title: 'Connect Folio' });
    expect(JSON.stringify(first.json())).not.toContain('Guide');
    const signIn = new URL(action.value);
    expect(signIn.origin + signIn.pathname).toBe(`${BASE}/api/integrations/teams/connect`);
    expect(verifyTicket(signIn.searchParams.get('ticket')!)).toEqual({ tenantId: TENANT, platformUserId: 'aad-bob', platformUserName: 'Bob Teams' });

    const start = await app.inject({ method: 'GET', url: pathOf(action.value) });
    expect(start.statusCode).toBe(302);
    const connectCookie = cookieFrom(start, CONNECT_COOKIE);
    expect(new URL(String(start.headers.location)).searchParams.get('client_id')).toBe('folio_chat_teams');
    const back = await approveFolioConsent(app, String(start.headers.location), bobCookie);
    const finish = await app.inject({ method: 'GET', url: pathOf(back), headers: { cookie: connectCookie } });
    expect(finish.statusCode).toBe(200);
    expect(finish.headers['content-security-policy']).toContain("script-src https://res.cdn.office.net 'nonce-");
    expect(finish.body).toContain('authentication.notifySuccess');
    const magic = /data-code="([^"]+)"/.exec(finish.body)![1];

    // Still unlinked until Teams hands the code back — and only for the Teams user it was made for.
    const intruder = await post(invoke('composeExtension/queryLink', pageUrl(guideId), { aad: 'aad-mallory', state: magic }), await botToken());
    expect(intruder.json().composeExtension.type).toBe('auth');

    const linked = await post(invoke('composeExtension/queryLink', pageUrl(guideId), { state: magic }), await botToken());
    const result = linked.json().composeExtension;
    expect(result.type).toBe('result');
    expect(result.suggestedActions.actions[0]).toEqual({ type: 'setCachePolicy', value: '{"type":"no-cache"}' });
    const attachment = result.attachments[0];
    expect(attachment.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(attachment.preview.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(attachment.content.version).toBe('1.3');
    expect(JSON.stringify(attachment.content)).toContain('📄 Guide');
    expect(attachment.content.actions).toEqual([{ type: 'Action.OpenUrl', title: 'Open in Folio', url: pageUrl(guideId) }]);

    // the code is single use
    const replay = await post(invoke('composeExtension/queryLink', pageUrl(guideId), { aad: 'aad-other', state: magic }), await botToken());
    expect(replay.json().composeExtension.type).toBe('auth');
  });

  it('connected: a restricted page gives the title-less card', async () => {
    const res = await post(invoke('composeExtension/queryLink', pageUrl(secretId)), await botToken());
    const body = JSON.stringify(res.json());
    expect(res.json().composeExtension.type).toBe('result');
    expect(body).not.toContain('Board minutes');
    expect(body).toContain('Folio page');
  });

  it('a link that is not Folio\'s gets an empty result', async () => {
    const res = await post(invoke('composeExtension/queryLink', 'https://elsewhere.example.net/a'), await botToken());
    expect(res.json()).toEqual({ composeExtension: { type: 'result', attachmentLayout: 'list', attachments: [] } });
  });
});

describe('composeExtension/anonymousQueryLink (zero install)', () => {
  it('a share link unfurls without any identity; a member page asks to sign in with a content-free card', async () => {
    const link = await shares.createShareLink(guideId, bob.id, 'view', BASE);
    const shared = await post(invoke('composeExtension/anonymousQueryLink', link.url, { aad: null }), await botToken());
    expect(shared.json().composeExtension.type).toBe('result');
    expect(JSON.stringify(shared.json())).toContain('Guide');

    const member = await post(invoke('composeExtension/anonymousQueryLink', pageUrl(guideId), { aad: null }), await botToken());
    const ext = member.json().composeExtension;
    expect(ext.type).toBe('auth');
    expect(ext.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(JSON.stringify(ext)).not.toContain('Guide');
  });
});

describe('Adaptive Card', () => {
  it('renders the card model (snapshot); page text only ever in TextRun', () => {
    const card: ChatCard = {
      status: 'ok',
      url: 'https://folio.example.com/s/eng/p/01ABC',
      title: 'Release *process*',
      icon: '🚀',
      kind: 'doc',
      breadcrumb: ['Engineering', 'Handbook'],
      excerpt: 'How we ship [releases](javascript:alert(1)).',
      headings: ['Prepare', 'Ship'],
      tags: ['release'],
      updatedAt: '2026-10-15T09:30:00.000Z',
      updatedBy: 'Ada',
      access: 'member',
    };
    expect(teamsCard(card)).toMatchInlineSnapshot(`
      {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "actions": [
          {
            "title": "Open in Folio",
            "type": "Action.OpenUrl",
            "url": "https://folio.example.com/s/eng/p/01ABC",
          },
        ],
        "body": [
          {
            "inlines": [
              {
                "size": "Medium",
                "text": "🚀 Release *process*",
                "type": "TextRun",
                "weight": "Bolder",
              },
            ],
            "type": "RichTextBlock",
          },
          {
            "inlines": [
              {
                "isSubtle": true,
                "size": "Small",
                "text": "Engineering / Handbook",
                "type": "TextRun",
              },
            ],
            "type": "RichTextBlock",
          },
          {
            "inlines": [
              {
                "text": "How we ship [releases](javascript:alert(1)).",
                "type": "TextRun",
              },
            ],
            "type": "RichTextBlock",
          },
          {
            "inlines": [
              {
                "text": "• Prepare
      • Ship",
                "type": "TextRun",
              },
            ],
            "type": "RichTextBlock",
          },
          {
            "inlines": [
              {
                "isSubtle": true,
                "size": "Small",
                "text": "#release",
                "type": "TextRun",
              },
            ],
            "type": "RichTextBlock",
          },
          {
            "inlines": [
              {
                "isSubtle": true,
                "size": "Small",
                "text": "Updated 2026-10-15 by Ada",
                "type": "TextRun",
              },
            ],
            "type": "RichTextBlock",
          },
        ],
        "type": "AdaptiveCard",
        "version": "1.3",
      }
    `);
  });
});
