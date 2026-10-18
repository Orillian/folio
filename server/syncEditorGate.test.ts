/**
 * 16.10.2026 (owner): "Sync now" (POST /api/spaces/:space/sync) is open to anyone who may edit the space —
 * it commits, pulls and pushes, which the scheduler does anyway. Destructive git actions stay space-admin
 * (connect-git, reset-to-remote: see server/connectGit.test.ts). Same Fastify-inject harness as that file.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as authStore from './auth/store.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import { HttpError } from './errors.js';
import * as session from './auth/session.js';
import * as storage from './storage.js';
import { registerRoutes } from './routes.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', session.requireSession);
    registerRoutes(protectedScope);
  });
  await app.ready();
  return app;
}

describe('POST /api/spaces/:space/sync — role gate', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let space: string;
  const cookies: Record<'admin' | 'editor' | 'viewer' | 'outsider', string> = { admin: '', editor: '', viewer: '', outsider: '' };

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    const users = {
      admin: await authStore.createUser({ email: `sg-admin-${stamp}@test.local`, name: 'SG Admin', passwordHash: 'x', isAdmin: false }),
      editor: await authStore.createUser({ email: `sg-editor-${stamp}@test.local`, name: 'SG Editor', passwordHash: 'x', isAdmin: false }),
      viewer: await authStore.createUser({ email: `sg-viewer-${stamp}@test.local`, name: 'SG Viewer', passwordHash: 'x', isAdmin: false }),
      outsider: await authStore.createUser({ email: `sg-out-${stamp}@test.local`, name: 'SG Out', passwordHash: 'x', isAdmin: false }),
    };
    for (const [k, u] of Object.entries(users)) cookies[k as keyof typeof cookies] = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(u.id)).token}`;
    const created = await storage.createSpace(`Sync gate ${stamp}`, users.admin.id);
    space = created.slug;
    await authStore.setMembership(space, users.admin.id, 'admin');
    await authStore.setMembership(space, users.editor.id, 'editor');
    await authStore.setMembership(space, users.viewer.id, 'viewer');
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await deleteTestSpace(space).catch(() => {});
    await teardownSchema();
  });

  const sync = (cookie?: string) => app.inject({ method: 'POST', url: `/api/spaces/${space}/sync`, headers: cookie ? { cookie } : {} });

  it('401 without a session, 403 for a viewer and for a non-member, allowed for an editor and the admin', async () => {
    expect((await sync()).statusCode).toBe(401);
    expect((await sync(cookies.viewer)).statusCode).toBe(403);
    expect((await sync(cookies.outsider)).statusCode).toBe(403);
    expect((await sync(cookies.editor)).statusCode).toBe(200);
    expect((await sync(cookies.admin)).statusCode).toBe(200);
  });
});
