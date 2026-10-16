/**
 * HTTP surface of the chat link previews (Slack, Microsoft Teams). Two registrations:
 *
 * `registerChatIntegrationRoutes(app)` — the PUBLIC scope (no Folio session; each route
 * authenticates its caller itself):
 *   POST /api/integrations/slack/events        Slack Events API (v0 signature)          slack.ts
 *   POST /api/integrations/slack/interactions  Slack interactivity ack (v0 signature)   slack.ts
 *   POST /api/integrations/teams/messages      Bot Framework messaging (JWT)            teams.ts
 *   GET  /api/integrations/slack/connect, /slack/oidc/callback,
 *        /teams/connect, /chat/callback        "Connect Folio" (browser)                connect.ts
 * A platform that is not configured answers 404 on its routes.
 *
 * `registerChatIntegrationProtectedRoutes(scope)` — inside the session scope, COOKIE ONLY (a PAT
 * or OAuth token never manages links, exactly like Connected apps):
 *   GET/DELETE /api/me/chat-links(/:id)                      the person's own links
 *   GET        /api/admin/integrations/chat                  instance admin: status, endpoints, counts
 *   GET/DELETE /api/admin/integrations/chat/links(/:id)      instance admin: every link, disconnect
 *   GET        /api/admin/integrations/chat/slack-manifest.yaml, /teams-package.zip
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ChatIntegrationsAdminInfo } from '../../../shared/contracts.js';
import * as session from '../../auth/session.js';
import { badRequest, notFound } from '../../errors.js';
import { issuerFor } from '../../oauth/routes.js';
import { chatEnvPresence, slackConfig, teamsConfig } from './config.js';
import { registerChatConnectRoutes, slackOidcCallbackUrl } from './connect.js';
import { adminDeleteLink, adminListLinks, chatCallbackUrl, countLinks, deleteLinkForUser, listLinksForUser } from './links.js';
import { previewDomains, slackManifestYaml, slackUnfurlDomains, teamsDomains, teamsPackageZip } from './manifests.js';
import { connectUrl as slackConnectUrl, dispatchSlackEvent, verifySlackSignature, type SlackEnvelope } from './slack.js';
import { handleTeamsActivity, verifyBotFrameworkRequest, type TeamsActivity } from './teams.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const header = (request: FastifyRequest, name: string): string | undefined => {
  const v = request.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export async function registerChatIntegrationRoutes(app: FastifyInstance): Promise<void> {
  // Slack signs the RAW body: this scope keeps it as a string instead of parsing it.
  await app.register(async (slack) => {
    const raw = (_req: unknown, body: string | Buffer, done: (err: Error | null, body?: unknown) => void) => done(null, typeof body === 'string' ? body : body.toString('utf8'));
    slack.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 1024 * 1024 }, raw);
    slack.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 * 1024 }, raw);

    const authenticate = (request: FastifyRequest): { ok: true; body: string } | { ok: false; status: number } => {
      const cfg = slackConfig();
      if (!cfg) return { ok: false, status: 404 };
      const body = typeof request.body === 'string' ? request.body : '';
      const check = verifySlackSignature(cfg.signingSecret, body, header(request, 'x-slack-request-timestamp'), header(request, 'x-slack-signature'));
      return check === 'ok' ? { ok: true, body } : { ok: false, status: 401 };
    };

    slack.post('/api/integrations/slack/events', async (request, reply) => {
      const auth = authenticate(request);
      if (!auth.ok) return reply.status(auth.status).send({ error: auth.status === 404 ? 'not found' : 'invalid signature' });
      let envelope: SlackEnvelope;
      try {
        envelope = JSON.parse(auth.body) as SlackEnvelope;
      } catch {
        return reply.status(400).send({ error: 'invalid json' });
      }
      return reply.status(200).send(dispatchSlackEvent(envelope, issuerFor(request), request.log));
    });

    // A url button in an unfurl still posts an interaction; it only needs an acknowledgement.
    slack.post('/api/integrations/slack/interactions', async (request, reply) => {
      const auth = authenticate(request);
      if (!auth.ok) return reply.status(auth.status).send({ error: auth.status === 404 ? 'not found' : 'invalid signature' });
      return reply.status(200).send('');
    });
  });

  app.post('/api/integrations/teams/messages', async (request, reply) => {
    const cfg = teamsConfig();
    if (!cfg) return reply.status(404).send({ error: 'not found' });
    const activity = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as TeamsActivity;
    const auth = await verifyBotFrameworkRequest(header(request, 'authorization'), activity, cfg.appId);
    if (!auth.ok) {
      request.log.info({ reason: auth.reason }, 'teams request refused');
      return reply.status(auth.status).send({ error: 'unauthorized' });
    }
    const out = await handleTeamsActivity(activity, issuerFor(request), cfg);
    return reply.status(out.status).send(out.body);
  });

  registerChatConnectRoutes(app);
}

async function adminInfo(base: string): Promise<ChatIntegrationsAdminInfo> {
  const [counts, domains] = await Promise.all([countLinks(), previewDomains(base)]);
  const env = chatEnvPresence();
  return {
    slack: {
      configured: slackConfig() !== null,
      env: env.slack,
      endpoints: {
        eventsRequestUrl: `${base}/api/integrations/slack/events`,
        interactivityRequestUrl: `${base}/api/integrations/slack/interactions`,
        redirectUrl: slackOidcCallbackUrl(base),
        connectUrl: slackConnectUrl(base),
      },
      domains: slackUnfurlDomains(domains),
      linkedUsers: counts.slack,
    },
    teams: {
      configured: teamsConfig() !== null,
      env: env.teams,
      endpoints: {
        messagingEndpoint: `${base}/api/integrations/teams/messages`,
        folioCallbackUrl: chatCallbackUrl(base),
      },
      domains: teamsDomains(domains),
      linkedUsers: counts.teams,
    },
  };
}

export function registerChatIntegrationProtectedRoutes(scope: FastifyInstance): void {
  scope.get('/api/me/chat-links', async (request) => {
    session.requireCookieAuth(request);
    return { links: await listLinksForUser(request.authUser!.id) };
  });
  scope.delete('/api/me/chat-links/:id', async (request) => {
    session.requireCookieAuth(request);
    const { id } = request.params as { id: string };
    if (!UUID_RE.test(id) || !(await deleteLinkForUser(request.authUser!.id, id))) throw notFound('chat link');
    return { ok: true };
  });

  const requireAdmin = (request: FastifyRequest) => {
    session.requireCookieAuth(request);
    return session.requireInstanceAdmin(request);
  };

  scope.get('/api/admin/integrations/chat', async (request): Promise<ChatIntegrationsAdminInfo> => {
    requireAdmin(request);
    return adminInfo(issuerFor(request));
  });
  scope.get('/api/admin/integrations/chat/links', async (request) => {
    requireAdmin(request);
    return { links: await adminListLinks() };
  });
  scope.delete('/api/admin/integrations/chat/links/:id', async (request) => {
    const admin = requireAdmin(request);
    const { id } = request.params as { id: string };
    if (!UUID_RE.test(id) || !(await adminDeleteLink(admin.id, id))) throw notFound('chat link');
    return { ok: true };
  });
  scope.get('/api/admin/integrations/chat/slack-manifest.yaml', async (request, reply) => {
    requireAdmin(request);
    const base = issuerFor(request);
    return reply.type('text/yaml; charset=utf-8').header('cache-control', 'no-store').send(slackManifestYaml(base, await previewDomains(base)));
  });
  scope.get('/api/admin/integrations/chat/teams-package.zip', async (request, reply) => {
    requireAdmin(request);
    const appId = (process.env.FOLIO_TEAMS_APP_ID ?? '').trim();
    if (!appId) throw badRequest('set FOLIO_TEAMS_APP_ID first: the package names the bot by its app id');
    const base = issuerFor(request);
    const zip = await teamsPackageZip(base, appId, await previewDomains(base));
    return reply
      .type('application/zip')
      .header('content-disposition', 'attachment; filename="folio-teams-app.zip"')
      .header('cache-control', 'no-store')
      .send(zip);
  });
}
