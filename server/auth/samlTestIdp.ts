/**
 * Test-only: a SAML identity provider in a few functions — a fresh RSA key with a self-signed X.509 certificate
 * (built here in DER, no openssl needed), IdP metadata, and signed SAML Responses shaped like Entra ID / Okta /
 * Keycloak ones. Used by saml.test.ts; nothing in the server imports it.
 */
import { generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { signXml } from '@node-saml/node-saml/lib/xml.js';

// ---------------------------------------------------------------------------
// A self-signed certificate, DER by hand
// ---------------------------------------------------------------------------

function der(tag: number, content: Buffer): Buffer {
  const len = content.length;
  let header: Buffer;
  if (len < 0x80) header = Buffer.from([tag, len]);
  else {
    const bytes: number[] = [];
    for (let n = len; n > 0; n >>= 8) bytes.unshift(n & 0xff);
    header = Buffer.from([tag, 0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([header, content]);
}
const seq = (...items: Buffer[]) => der(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => der(0x31, Buffer.concat(items));
function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [];
    let n = p;
    do {
      chunk.unshift(n & 0x7f);
      n >>= 7;
    } while (n > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    out.push(...chunk);
  }
  return der(0x06, Buffer.from(out));
}
function int(bytes: Buffer): Buffer {
  return der(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}
function utcTime(d: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(s, 'ascii'));
}

export interface TestKey {
  privateKey: KeyObject;
  privateKeyPem: string;
  /** PEM certificate. */
  cert: string;
  /** The certificate body (base64, no header), as IdP metadata and admin screens carry it. */
  certBase64: string;
}

export function makeTestKey(cn = 'Folio Test IdP'): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sha256WithRsa = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
  const name = seq(set(seq(oid('2.5.4.3'), der(0x0c, Buffer.from(cn, 'utf8')))));
  const now = Date.now();
  const tbs = seq(
    der(0xa0, int(Buffer.from([2]))),
    int(randomBytes(8)),
    sha256WithRsa,
    name,
    seq(utcTime(new Date(now - 24 * 3600_000)), utcTime(new Date(now + 365 * 24 * 3600_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', tbs, privateKey);
  const certDer = seq(tbs, sha256WithRsa, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const certBase64 = certDer.toString('base64');
  const cert = `-----BEGIN CERTIFICATE-----\n${certBase64.replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;
  new X509Certificate(cert); // sanity: Node can parse it
  return { privateKey, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, cert, certBase64 };
}

// ---------------------------------------------------------------------------
// Metadata, requests, responses
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function idpMetadataXml(entityId: string, ssoUrl: string, certBase64: string, binding: 'redirect' | 'post' = 'redirect'): string {
  const b = binding === 'post' ? 'HTTP-POST' : 'HTTP-Redirect';
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${esc(entityId)}">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certBase64}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:${b}" Location="${esc(ssoUrl)}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
}

/** The AuthnRequest an HTTP-Redirect URL carries (SAMLRequest: deflate + base64). */
export function decodeRedirectRequest(location: string): { id: string; xml: string; relayState: string | null; url: URL } {
  const url = new URL(location);
  const raw = url.searchParams.get('SAMLRequest');
  if (!raw) throw new Error('no SAMLRequest in ' + location);
  const xml = inflateRawSync(Buffer.from(raw, 'base64')).toString('utf8');
  const id = /\sID="([^"]+)"/.exec(xml)?.[1];
  if (!id) throw new Error('no ID in the AuthnRequest');
  return { id, xml, relayState: url.searchParams.get('RelayState'), url };
}

export interface ResponseOptions {
  idpEntityId: string;
  audience: string;
  acsUrl: string;
  nameId: string;
  nameIdFormat?: string;
  inResponseTo?: string | null;
  attributes?: Record<string, string | string[]>;
  /** Offsets from now, in seconds. */
  notBeforeSec?: number;
  notOnOrAfterSec?: number;
  assertionId?: string;
  /** The assertion's Issuer (default idpEntityId). */
  assertionIssuer?: string;
  /** What gets signed: the assertion (default), only the outer Response, both, or nothing. */
  sign?: 'assertion' | 'response' | 'both' | 'none';
  key: TestKey;
  /** Prepended before the root element (e.g. a DOCTYPE). */
  prolog?: string;
}

export function buildSamlResponse(o: ResponseOptions): string {
  const now = Date.now();
  const iso = (offsetSec: number) => new Date(now + offsetSec * 1000).toISOString();
  const notBefore = iso(o.notBeforeSec ?? -30);
  const notOnOrAfter = iso(o.notOnOrAfterSec ?? 300);
  const assertionId = o.assertionId ?? `_a${randomBytes(12).toString('hex')}`;
  const responseId = `_r${randomBytes(12).toString('hex')}`;
  const irt = o.inResponseTo ? ` InResponseTo="${esc(o.inResponseTo)}"` : '';
  const attrs = Object.entries(o.attributes ?? {})
    .map(([name, value]) => {
      const values = (Array.isArray(value) ? value : [value]).map((v) => `<saml:AttributeValue xsi:type="xs:string">${esc(v)}</saml:AttributeValue>`).join('');
      return `<saml:Attribute Name="${esc(name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:unspecified">${values}</saml:Attribute>`;
    })
    .join('');
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ID="${assertionId}" Version="2.0" IssueInstant="${iso(0)}">` +
    `<saml:Issuer>${esc(o.assertionIssuer ?? o.idpEntityId)}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="${esc(o.nameIdFormat ?? 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent')}">${esc(o.nameId)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}" Recipient="${esc(o.acsUrl)}"${irt}/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${esc(o.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="${assertionId}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    (attrs ? `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` : '') +
    `</saml:Assertion>`;
  const signing = { privateKey: o.key.privateKeyPem, publicCert: o.key.cert, signatureAlgorithm: 'sha256' as const, digestAlgorithm: 'sha256' };
  let response =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" Version="2.0" IssueInstant="${iso(0)}" Destination="${esc(o.acsUrl)}"${irt}>` +
    `<saml:Issuer>${esc(o.idpEntityId)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    assertion +
    `</samlp:Response>`;
  const mode = o.sign ?? 'assertion';
  if (mode === 'assertion' || mode === 'both') {
    response = signXml(response, "//*[local-name(.)='Assertion']", { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' }, signing);
  }
  if (mode === 'response' || mode === 'both') {
    response = signXml(response, "/*[local-name(.)='Response']", { reference: "/*[local-name(.)='Response']/*[local-name(.)='Issuer']", action: 'after' }, signing);
  }
  return (o.prolog ?? '') + response;
}

export function encodeResponse(xml: string): string {
  return Buffer.from(xml, 'utf8').toString('base64');
}
