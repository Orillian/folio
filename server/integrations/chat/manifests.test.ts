/** The Slack manifest and the Teams package carry this instance's addresses and the documented shape. */
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { slackManifestYaml, slackUnfurlDomains, teamsDomains, teamsManifest, teamsPackageZip, type PreviewDomains } from './manifests.js';

const BASE = 'https://folio.example.com';
const D: PreviewDomains = { host: 'folio.example.com', sitesDomain: 'sites.example.com', customDomains: ['docs.example.org'] };

describe('chat app manifests', () => {
  it('Slack: link_shared, links scopes, the Sign in with Slack redirect, every preview domain', () => {
    const yaml = slackManifestYaml(BASE, D);
    expect(yaml).toContain('request_url: https://folio.example.com/api/integrations/slack/events');
    expect(yaml).toContain('request_url: https://folio.example.com/api/integrations/slack/interactions');
    expect(yaml).toContain('- https://folio.example.com/api/integrations/slack/oidc/callback');
    expect(yaml).not.toContain('openid'); // asked for by the sign-in request, never an app scope
    for (const line of ['- links:read', '- links:write', '- link_shared', '- folio.example.com', '- sites.example.com', '- docs.example.org']) expect(yaml).toContain(line);
    expect(slackUnfurlDomains({ ...D, customDomains: ['a.x', 'b.x', 'c.x', 'd.x', 'e.x'] })).toHaveLength(5);
  });

  it('Teams: a link message handler with zero-install, the bot id, wildcard for site subdomains', async () => {
    const m = teamsManifest(BASE, 'app-id', D) as { composeExtensions: Array<{ botId: string; messageHandlers: Array<{ type: string; value: { domains: string[]; supportsAnonymizedPayloads: boolean } }> }>; validDomains: string[]; id: string };
    expect(m.id).toBe('app-id');
    expect(m.composeExtensions[0].botId).toBe('app-id');
    expect(m.composeExtensions[0].messageHandlers[0]).toEqual({ type: 'link', value: { domains: ['folio.example.com', '*.sites.example.com', 'docs.example.org'], supportsAnonymizedPayloads: true } });
    expect(m.validDomains).toEqual(['folio.example.com']);
    expect(teamsDomains({ host: 'h.example.com', sitesDomain: null, customDomains: [] })).toEqual(['h.example.com']);

    const zip = await JSZip.loadAsync(await teamsPackageZip(BASE, 'app-id', D));
    expect(Object.keys(zip.files).sort()).toEqual(['color.png', 'manifest.json', 'outline.png']);
    const png = await zip.file('color.png')!.async('nodebuffer');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(JSON.parse(await zip.file('manifest.json')!.async('string')).icons).toEqual({ color: 'color.png', outline: 'outline.png' });
  });
});
