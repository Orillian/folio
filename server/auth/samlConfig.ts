/**
 * SAML 2.0 provider settings (docs/AUTH.md): normalizing what the admin screen or FOLIO_SAML_<SLUG>_* gave,
 * reading IdP metadata (entity ID, SSO URL, signing certificates) and the certificates themselves.
 * The sign-in itself is saml.ts.
 *
 * Every XML document Folio reads from outside (IdP metadata, a SAMLResponse) is refused when it carries a DOCTYPE
 * or an ENTITY declaration: SAML never needs one, and refusing them up front rules out entity-expansion and
 * external-entity tricks whatever the XML parser would do with them.
 */
import { X509Certificate, createPublicKey } from 'node:crypto';
import { parseDomFromString, xpath } from '@node-saml/node-saml/lib/xml.js';
import type { SamlConfigInput, SamlNameIdFormat, SamlProviderConfig } from '../../shared/contracts.js';

export const NAMEID_FORMAT_URNS: Record<SamlNameIdFormat, string> = {
  email: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  persistent: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  unspecified: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
};
export const NAMEID_TRANSIENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';

const BINDING_REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const BINDING_POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';

export const EMPTY_SAML_CONFIG: SamlProviderConfig = {
  metadataUrl: '',
  metadataXml: '',
  idpEntityId: '',
  ssoUrl: '',
  idpCert: '',
  spEntityId: '',
  nameIdFormat: 'persistent',
  emailAuthoritative: false,
  allowIdpInitiated: false,
};

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** A stored / submitted config with every field present (unknown values dropped). */
export function normalizeSamlConfig(raw: unknown): SamlProviderConfig {
  const m = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const format = m.nameIdFormat;
  return {
    metadataUrl: str(m.metadataUrl),
    metadataXml: typeof m.metadataXml === 'string' ? m.metadataXml.trim() : '',
    idpEntityId: str(m.idpEntityId),
    ssoUrl: str(m.ssoUrl),
    idpCert: typeof m.idpCert === 'string' ? m.idpCert.trim() : '',
    spEntityId: str(m.spEntityId),
    nameIdFormat: format === 'email' || format === 'persistent' || format === 'unspecified' ? format : EMPTY_SAML_CONFIG.nameIdFormat,
    emailAuthoritative: m.emailAuthoritative === true,
    allowIdpInitiated: m.allowIdpInitiated === true,
  };
}

/** `current` with `patch` applied: an omitted field is kept, '' clears it. */
export function mergeSamlConfig(current: SamlProviderConfig | null, patch: SamlConfigInput | undefined): SamlProviderConfig {
  const base = current ?? EMPTY_SAML_CONFIG;
  if (!patch) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v;
  return normalizeSamlConfig(out);
}

/** Throws when an XML document from outside declares a DOCTYPE or an entity. */
export function rejectDoctype(xml: string): void {
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) throw new Error('XML with a DOCTYPE or ENTITY declaration is not accepted');
}

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

function wrapPem(base64: string, label = 'CERTIFICATE'): string {
  const body = base64.replace(/\s+/g, '');
  return `-----BEGIN ${label}-----\n${body.replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END ${label}-----\n`;
}

/**
 * One or more signing certificates: PEM blocks (CERTIFICATE, or PUBLIC KEY) or one bare base64 certificate (what IdP
 * metadata and most admin screens show). Each one is parsed; anything that is not a certificate or key throws.
 */
export function parseCertificates(raw: string): string[] {
  const text = raw.trim();
  if (!text) return [];
  const blocks = text.match(/-----BEGIN ([A-Z ]+)-----[\s\S]*?-----END \1-----/g);
  const pems = blocks ? blocks.map((b) => b.trim() + '\n') : [wrapPem(text)];
  for (const pem of pems) {
    try {
      if (pem.includes('BEGIN CERTIFICATE')) new X509Certificate(pem);
      else if (pem.includes('BEGIN PUBLIC KEY')) createPublicKey(pem);
      else throw new Error('not a certificate');
    } catch {
      throw new Error('the IdP certificate is not a valid PEM / base64 X.509 certificate');
    }
  }
  return pems;
}

// ---------------------------------------------------------------------------
// IdP metadata
// ---------------------------------------------------------------------------

export interface IdpMetadata {
  entityId: string;
  ssoUrl: string;
  ssoBinding: 'redirect' | 'post';
  certs: string[];
}

interface XmlElement {
  getAttribute(name: string): string | null;
  textContent: string | null;
}

/** entityID, the SingleSignOnService (HTTP-Redirect preferred over HTTP-POST) and the signing certificates of the first IdP in the document. */
export async function parseIdpMetadata(xml: string): Promise<IdpMetadata> {
  rejectDoctype(xml);
  let doc: unknown;
  try {
    doc = await parseDomFromString(xml);
  } catch (err) {
    throw new Error(`the IdP metadata is not valid XML (${err instanceof Error ? err.message : String(err)})`);
  }
  const select = (node: unknown, path: string) => xpath.selectElements(node as never, path) as unknown as XmlElement[];
  const entity = select(doc, "//*[local-name()='EntityDescriptor'][*[local-name()='IDPSSODescriptor']]")[0];
  if (!entity) throw new Error('the metadata has no IdP (no EntityDescriptor with an IDPSSODescriptor)');
  const entityId = (entity.getAttribute('entityID') ?? '').trim();
  if (!entityId) throw new Error('the IdP metadata has no entityID');
  const idp = select(entity, "./*[local-name()='IDPSSODescriptor']")[0];
  const services = select(idp, "./*[local-name()='SingleSignOnService']");
  const redirect = services.find((s) => s.getAttribute('Binding') === BINDING_REDIRECT);
  const post = services.find((s) => s.getAttribute('Binding') === BINDING_POST);
  const service = redirect ?? post;
  const keys = select(idp, "./*[local-name()='KeyDescriptor']").filter((k) => {
    const use = k.getAttribute('use');
    return !use || use === 'signing';
  });
  const certs: string[] = [];
  for (const key of keys) {
    for (const c of select(key, ".//*[local-name()='X509Certificate']")) {
      const text = (c.textContent ?? '').trim();
      if (text) certs.push(...parseCertificates(text));
    }
  }
  return {
    entityId,
    ssoUrl: (service?.getAttribute('Location') ?? '').trim(),
    ssoBinding: service && service === post ? 'post' : 'redirect',
    certs: Array.from(new Set(certs)),
  };
}

/**
 * What a save must contain to be usable: the metadata (URL or XML), or SSO URL + certificate + IdP entity ID.
 * Pasted metadata XML and certificates are parsed here, so a typo is a 400 at save, not a failed sign-in later.
 * Returns the IdP entity ID when it is known without a network call (explicit, or from the pasted XML).
 */
export async function validateSamlConfig(cfg: SamlProviderConfig): Promise<{ idpEntityId: string }> {
  let fromXml: IdpMetadata | undefined;
  if (cfg.metadataXml) fromXml = await parseIdpMetadata(cfg.metadataXml);
  if (cfg.idpCert) parseCertificates(cfg.idpCert);
  if (!cfg.metadataUrl && !fromXml) {
    const missing = [!cfg.ssoUrl && 'SSO URL', !cfg.idpCert && 'IdP certificate', !cfg.idpEntityId && 'IdP entity ID'].filter(Boolean);
    if (missing.length) throw new Error(`without IdP metadata (URL or XML), set the ${missing.join(', ')}`);
  }
  if (fromXml && !(cfg.ssoUrl || fromXml.ssoUrl)) throw new Error('the IdP metadata has no SingleSignOnService: set the SSO URL');
  if (fromXml && !(cfg.idpCert || fromXml.certs.length)) throw new Error('the IdP metadata has no signing certificate: set the IdP certificate');
  return { idpEntityId: cfg.idpEntityId || fromXml?.entityId || '' };
}
