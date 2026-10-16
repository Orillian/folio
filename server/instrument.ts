/**
 * Imported FIRST by server/index.ts: Sentry must be initialised before the app's own modules (fastify, pg, ioredis)
 * load, or its instrumentation cannot see them. With no SENTRY_DSN this does nothing.
 */
import { loadEnv } from './env.js';
import { initSentry } from './sentry.js';

loadEnv();
initSentry();
