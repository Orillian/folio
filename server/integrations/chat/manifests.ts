/**
 * What an administrator pastes or uploads on the chat side: the Slack app manifest ("Create an
 * app → From a manifest") and the Teams app package (manifest.json + two icons, zipped), both
 * filled in with this instance's address. Served to instance admins by routes.ts and written by
 * tools/teams-app-package.sh; one generator, so the two can never differ.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { query } from '../../db/pool.js';
import { sitesDomain } from '../../publicSites.js';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
/** Slack accepts at most five unfurl domains per app. */
export const SLACK_MAX_UNFURL_DOMAINS = 5;

export interface PreviewDomains {
  /** The instance host (PUBLIC_URL's). */
  host: string;
  /** PUBLIC_SITES_DOMAIN, when published spaces get subdomains. */
  sitesDomain: string | null;
  /** Custom domains of published spaces. */
  customDomains: string[];
}

export async function previewDomains(base: string): Promise<PreviewDomains> {
  const host = new URL(base).hostname.toLowerCase();
  const rows = await query<{ d: string }>(`SELECT DISTINCT lower(public_domain) AS d FROM spaces WHERE visibility = 'public' AND public_domain IS NOT NULL AND public_domain <> '' ORDER BY 1`).catch(() => []);
  return { host, sitesDomain: sitesDomain(), customDomains: rows.map((r) => r.d).filter((d) => d !== host) };
}

/** Slack: a registered domain also matches its subdomains, so PUBLIC_SITES_DOMAIN covers every site subdomain. */
export function slackUnfurlDomains(d: PreviewDomains): string[] {
  return [...new Set([d.host, ...(d.sitesDomain ? [d.sitesDomain] : []), ...d.customDomains])].slice(0, SLACK_MAX_UNFURL_DOMAINS);
}

/** Teams: a `*.` wildcard matches exactly one label. */
export function teamsDomains(d: PreviewDomains): string[] {
  return [...new Set([d.host, ...(d.sitesDomain ? [`*.${d.sitesDomain}`] : []), ...d.customDomains])];
}

/**
 * The Slack app: a bot with links:read/links:write subscribed to link_shared, and the redirect URL
 * of Sign in with Slack. The OpenID scopes (openid, profile) are not app scopes: they are asked for
 * by that sign-in request itself, in its own OAuth flow (Slack requires the two kinds apart).
 */
export function slackManifestYaml(base: string, d: PreviewDomains): string {
  const list = (items: string[], indent: string) => items.map((i) => `${indent}- ${i}`).join('\n');
  return `display_information:
  name: Folio
  description: Previews of Folio links, built with each person's own Folio access.
  background_color: "#1c1917"
features:
  bot_user:
    display_name: folio
    always_online: false
  unfurl_domains:
${list(slackUnfurlDomains(d), '    ')}
oauth_config:
  redirect_urls:
    - ${base}/api/integrations/slack/oidc/callback
  scopes:
    bot:
      - links:read
      - links:write
settings:
  event_subscriptions:
    request_url: ${base}/api/integrations/slack/events
    bot_events:
      - link_shared
  interactivity:
    is_enabled: true
    request_url: ${base}/api/integrations/slack/interactions
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`;
}

export function teamsManifest(base: string, appId: string, d: PreviewDomains, version = '1.0.0'): Record<string, unknown> {
  return {
    $schema: 'https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json',
    manifestVersion: '1.17',
    version,
    id: appId,
    developer: { name: 'Folio', websiteUrl: base, privacyUrl: base, termsOfUseUrl: base },
    name: { short: 'Folio', full: 'Folio link previews' },
    description: {
      short: 'Previews of Folio links in Teams messages.',
      full: 'Shows a card with the title, location, opening text and headings of a Folio page when its link is pasted into a message. Each person connects their own Folio account once; a card shows only what that person can open in Folio.',
    },
    icons: { color: 'color.png', outline: 'outline.png' },
    accentColor: '#FFFFFF',
    composeExtensions: [
      {
        botId: appId,
        commands: [],
        messageHandlers: [{ type: 'link', value: { domains: teamsDomains(d), supportsAnonymizedPayloads: true } }],
      },
    ],
    permissions: ['identity'],
    validDomains: [d.host],
  };
}

export async function teamsPackageZip(base: string, appId: string, d: PreviewDomains): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('manifest.json', `${JSON.stringify(teamsManifest(base, appId, d), null, 2)}\n`);
  zip.file('color.png', await fs.readFile(path.join(ASSETS, 'teams-color.png')));
  zip.file('outline.png', await fs.readFile(path.join(ASSETS, 'teams-outline.png')));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
