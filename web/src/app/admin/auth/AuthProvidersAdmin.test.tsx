// @vitest-environment jsdom
/**
 * /admin/auth — a SAML provider shows what to register at the IdP (SP entity ID, ACS URL, SP metadata URL) and
 * tests through /api/auth/saml/<slug>/start?test=1; the add dialog switches to the SAML fields and sends kind 'saml'.
 * The HTTP layer is a fetch stub; the server side lives in server/auth/saml.test.ts.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { AuthProviderInfo } from '@shared/contracts';
import { ToastProvider } from '../../ui/Toast';
import { AuthProvidersAdmin, testUrlFor } from './AuthProvidersAdmin';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BASE = 'https://folio.example.com/api/auth/saml/okta';
const SAML_PROVIDER: AuthProviderInfo = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'okta',
  kind: 'saml',
  source: 'db',
  displayName: 'Okta',
  issuer: 'http://www.okta.com/exk1',
  clientId: '',
  hasClientSecret: false,
  scopes: 'openid email profile',
  claimMapping: { email: 'email', name: 'name', groups: 'groups' },
  groupSync: { enabled: false, mode: 'name', mapping: {}, createMissing: false, allow: '' },
  allowedDomains: ['acme.test'],
  jitEnabled: false,
  jitDefaultSpaces: {},
  enforceSso: false,
  enabled: true,
  redirectUri: `${BASE}/acs`,
  saml: {
    metadataUrl: '',
    metadataXml: '',
    idpEntityId: 'http://www.okta.com/exk1',
    ssoUrl: 'https://acme.okta.com/app/x/sso/saml',
    idpCert: 'MIIB',
    spEntityId: '',
    nameIdFormat: 'persistent',
    emailAuthoritative: false,
    allowIdpInitiated: false,
  },
  samlSp: { entityId: `${BASE}/metadata`, acsUrl: `${BASE}/acs`, metadataUrl: `${BASE}/metadata` },
  identities: 0,
  createdAt: '2026-10-23T08:00:00.000Z',
  updatedAt: '2026-10-23T08:00:00.000Z',
};

function stubApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === '/api/admin/auth/providers' && (!init?.method || init.method === 'GET')) return json({ providers: [SAML_PROVIDER], secretConfigured: true });
    if (url === '/api/admin/auth/providers' && init?.method === 'POST') return json({ ...SAML_PROVIDER, id: 'new' }, 201);
    return json({ error: 'unexpected' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderAdmin() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <AuthProvidersAdmin />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('AuthProvidersAdmin: SAML', () => {
  it('a SAML card shows the SP entity ID, ACS URL and SP metadata URL; Test connection opens the SAML start', async () => {
    stubApi();
    const open = vi.fn();
    vi.stubGlobal('open', open);
    renderAdmin();
    expect(await screen.findByText('Okta')).toBeTruthy();
    expect(screen.getByText('SAML')).toBeTruthy();
    expect(screen.getByText('ACS (reply) URL')).toBeTruthy();
    expect(screen.getByText(`${BASE}/acs`)).toBeTruthy();
    expect(screen.getAllByText(`${BASE}/metadata`)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(open).toHaveBeenCalledWith('/api/auth/saml/okta/start?test=1', 'folio-sso-test', expect.any(String));
    expect(testUrlFor({ slug: 'kc', kind: 'oidc' })).toBe('/api/auth/oidc/kc/start?test=1');
  });

  it('the add dialog switches to the SAML fields and sends kind "saml" with its settings', async () => {
    const fetchMock = stubApi();
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: 'Add provider' }));
    expect(screen.getByLabelText('Issuer URL')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('SAML 2.0'));
    expect(screen.queryByLabelText('Issuer URL')).toBeNull();
    fireEvent.change(screen.getByLabelText('Button name'), { target: { value: 'Entra' } });
    fireEvent.change(screen.getByLabelText('Slug (in the URL)'), { target: { value: 'entra' } });
    fireEvent.change(screen.getByLabelText('IdP metadata URL'), { target: { value: 'https://login.example.com/federationmetadata.xml' } });
    fireEvent.click(screen.getByLabelText(/authoritative/));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST')!;
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({
      kind: 'saml',
      slug: 'entra',
      displayName: 'Entra',
      saml: { metadataUrl: 'https://login.example.com/federationmetadata.xml', nameIdFormat: 'persistent', emailAuthoritative: true, allowIdpInitiated: false },
    });
    expect(body.issuer).toBeUndefined();
    expect(body.clientId).toBeUndefined();
  });

  it('the group sync fieldset sends the mapping table, create-missing and the allowlist', async () => {
    const fetchMock = stubApi();
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: 'Add provider' }));
    fireEvent.change(screen.getByLabelText('Button name'), { target: { value: 'Keycloak' } });
    fireEvent.change(screen.getByLabelText('Slug (in the URL)'), { target: { value: 'kc' } });
    fireEvent.change(screen.getByLabelText('Issuer URL'), { target: { value: 'https://sso.example.com/realms/acme' } });
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'folio' } });
    expect(screen.queryByLabelText('Match IdP groups to Folio groups')).toBeNull();
    fireEvent.click(screen.getByLabelText(/Sync groups at sign-in/));
    fireEvent.change(screen.getByLabelText('Match IdP groups to Folio groups'), { target: { value: 'mapping' } });
    fireEvent.change(screen.getByLabelText(/Table: IdP group/), { target: { value: 'Engineering = eng\nnot valid\n/ops = Ops' } });
    fireEvent.click(screen.getByLabelText(/Create groups that do not exist yet/));
    fireEvent.change(screen.getByLabelText(/Only these IdP groups/), { target: { value: 'folio-' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST')!;
    expect(JSON.parse(String(init!.body)).groupSync).toEqual({ enabled: true, mode: 'mapping', mapping: { Engineering: 'eng' }, createMissing: true, allow: 'folio-' });
  });

  it('a card says whether group sync is on', async () => {
    stubApi();
    renderAdmin();
    expect(await screen.findByText('Okta')).toBeTruthy();
    expect(screen.getByText('Group sync')).toBeTruthy();
    expect(screen.getByText('off')).toBeTruthy();
  });
});
