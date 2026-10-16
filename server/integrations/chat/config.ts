/**
 * Environment of the chat link previews (Slack, Microsoft Teams). Read on every call, never
 * cached, so a test (or an operator restarting with new variables) sees the current values.
 * Nothing here ever returns a secret to a caller that shows it: `chatEnvPresence` reports only
 * whether each variable is present.
 */
import type { ChatPlatform } from '../../../shared/contracts.js';
import { hasSecretConfigured } from '../../secretCrypto.js';
import { loadEnv } from '../../env.js';

export type { ChatPlatform };

function env(name: string): string {
  loadEnv();
  return (process.env[name] ?? '').trim();
}

export interface SlackConfig {
  signingSecret: string;
  botToken: string;
  clientId: string;
  clientSecret: string;
  /** Optional: the one workspace (team id, `T…`) allowed to connect. Empty = whichever workspace the app is installed in. */
  teamId: string;
}

export interface TeamsConfig {
  appId: string;
  /** The Entra tenant the bot is registered in (single-tenant); requests from any other tenant are refused. */
  tenantId: string;
}

/** Slack: all four of signing secret, bot token, client id and client secret, plus FOLIO_SECRET for the tokens at rest. */
export function slackConfig(): SlackConfig | null {
  const cfg: SlackConfig = {
    signingSecret: env('FOLIO_SLACK_SIGNING_SECRET'),
    botToken: env('FOLIO_SLACK_BOT_TOKEN'),
    clientId: env('FOLIO_SLACK_CLIENT_ID'),
    clientSecret: env('FOLIO_SLACK_CLIENT_SECRET'),
    teamId: env('FOLIO_SLACK_TEAM_ID'),
  };
  if (!cfg.signingSecret || !cfg.botToken || !cfg.clientId || !cfg.clientSecret || !hasSecretConfigured()) return null;
  return cfg;
}

/** Teams: the bot's app id and its tenant, plus FOLIO_SECRET. */
export function teamsConfig(): TeamsConfig | null {
  const cfg: TeamsConfig = { appId: env('FOLIO_TEAMS_APP_ID'), tenantId: env('FOLIO_TEAMS_TENANT_ID') };
  if (!cfg.appId || !cfg.tenantId || !hasSecretConfigured()) return null;
  return cfg;
}

/** Which variables are present, by name (never their values) — the admin page's checklist. */
export function chatEnvPresence(): Record<ChatPlatform, Record<string, boolean>> {
  const has = (name: string) => env(name) !== '';
  return {
    slack: {
      FOLIO_SLACK_SIGNING_SECRET: has('FOLIO_SLACK_SIGNING_SECRET'),
      FOLIO_SLACK_BOT_TOKEN: has('FOLIO_SLACK_BOT_TOKEN'),
      FOLIO_SLACK_CLIENT_ID: has('FOLIO_SLACK_CLIENT_ID'),
      FOLIO_SLACK_CLIENT_SECRET: has('FOLIO_SLACK_CLIENT_SECRET'),
      FOLIO_SLACK_TEAM_ID: has('FOLIO_SLACK_TEAM_ID'),
      FOLIO_SECRET: hasSecretConfigured(),
    },
    teams: {
      FOLIO_TEAMS_APP_ID: has('FOLIO_TEAMS_APP_ID'),
      FOLIO_TEAMS_TENANT_ID: has('FOLIO_TEAMS_TENANT_ID'),
      FOLIO_TEAMS_APP_PASSWORD: has('FOLIO_TEAMS_APP_PASSWORD'),
      FOLIO_SECRET: hasSecretConfigured(),
    },
  };
}

export const PLATFORM_LABEL: Record<ChatPlatform, string> = { slack: 'Slack', teams: 'Microsoft Teams' };
