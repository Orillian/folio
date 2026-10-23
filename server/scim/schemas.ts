/**
 * SCIM request bodies (zod) and the static discovery documents (RFC 7643 §5-7, RFC 7644 §4).
 *
 * Bodies are parsed leniently: identity providers send many attributes Folio has no use for (title, addresses,
 * phoneNumbers, the enterprise extension, Okta's `password`, `locale`...), which are ignored, never an error.
 * What Folio does use is checked strictly: a missing userName, a non-boolean `active`, an unknown PATCH `op` are
 * 400s in the SCIM error format. Entra ID sends booleans as the strings "True" / "False": accepted.
 */
import { z } from 'zod';
import { issueMessage } from '../validate.js';
import { scimBadRequest } from './errors.js';

export const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const ENTERPRISE_USER_SCHEMA = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
export const LIST_RESPONSE_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const PATCH_OP_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const SPC_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';
const RESOURCE_TYPE_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:ResourceType';
const SCHEMA_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Schema';

/** Page size cap for list requests (also announced as filter.maxResults). */
export const SCIM_MAX_RESULTS = 200;

/** true / false, or Entra's "True" / "False". Anything else is a 400. */
export function scimBoolean(value: unknown, what = 'active'): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === 'true';
  throw scimBadRequest(`"${what}" must be a boolean`);
}

const optionalText = (max: number) => z.string().max(max).nullish();

export const scimNameSchema = z.looseObject({
  formatted: optionalText(300),
  givenName: optionalText(200),
  familyName: optionalText(200),
  middleName: optionalText(200),
});
export type ScimName = z.infer<typeof scimNameSchema>;

export const scimEmailSchema = z.looseObject({
  value: z.string().trim().max(320),
  type: optionalText(50),
  primary: z.unknown().optional(),
});
export type ScimEmail = z.infer<typeof scimEmailSchema>;

export const scimUserSchema = z.looseObject({
  schemas: z.array(z.string()).optional(),
  userName: z.string().trim().min(1, 'userName is required').max(320),
  externalId: optionalText(500),
  name: scimNameSchema.nullish(),
  displayName: optionalText(300),
  emails: z.array(scimEmailSchema).max(50).nullish(),
  active: z.unknown().optional(),
});
export type ScimUserInput = z.infer<typeof scimUserSchema>;

export const scimMemberSchema = z.looseObject({ value: z.string().trim().min(1).max(100), display: z.string().nullish() });

export const scimGroupSchema = z.looseObject({
  schemas: z.array(z.string()).optional(),
  displayName: z.string().trim().min(1, 'displayName is required').max(200),
  externalId: optionalText(500),
  members: z.array(scimMemberSchema).max(10_000).nullish(),
});
export type ScimGroupInput = z.infer<typeof scimGroupSchema>;

export const scimPatchOperationSchema = z.looseObject({
  op: z.string().min(1),
  path: z.string().max(500).optional(),
  value: z.unknown().optional(),
});
export type ScimPatchOperation = { op: 'add' | 'replace' | 'remove'; path?: string; value?: unknown };

const scimPatchSchema = z.looseObject({
  schemas: z.array(z.string()).optional(),
  Operations: z.array(scimPatchOperationSchema).min(1, 'Operations must not be empty').max(1000),
});

/** zod -> SCIM 400 invalidValue (an object that is not one at all -> invalidSyntax). */
export function parseScim<T>(schema: z.ZodType<T>, body: unknown): T {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw scimBadRequest('the request body must be a JSON object', 'invalidSyntax');
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw scimBadRequest(issueMessage(parsed.error.issues[0]));
  return parsed.data;
}

/** A PatchOp body: `Operations` (some clients write `operations`), each op normalized to lower case. */
export function parsePatch(body: unknown): ScimPatchOperation[] {
  const raw = typeof body === 'object' && body !== null && !Array.isArray(body) && !('Operations' in body) && 'operations' in body
    ? { ...(body as Record<string, unknown>), Operations: (body as Record<string, unknown>).operations }
    : body;
  const parsed = parseScim(scimPatchSchema, raw);
  if (parsed.schemas && !parsed.schemas.includes(PATCH_OP_SCHEMA)) throw scimBadRequest(`a PATCH body must use the ${PATCH_OP_SCHEMA} schema`, 'invalidSyntax');
  return parsed.Operations.map((op) => {
    const name = op.op.trim().toLowerCase();
    if (name !== 'add' && name !== 'replace' && name !== 'remove') throw scimBadRequest(`unknown PATCH op "${op.op}"`, 'invalidSyntax');
    if (name === 'remove' && !op.path?.trim() && op.value === undefined) throw scimBadRequest('a "remove" operation needs a path', 'noTarget');
    if (name !== 'remove' && op.value === undefined) throw scimBadRequest(`an "${name}" operation needs a value`, 'invalidValue');
    return { op: name, ...(op.path?.trim() ? { path: op.path.trim() } : {}), ...(op.value !== undefined ? { value: op.value } : {}) };
  });
}

/** Strips a core schema URN prefix (`urn:…:core:2.0:User:userName` -> `userName`). */
export function stripCoreUrn(path: string): string {
  return path.replace(/^urn:ietf:params:scim:schemas:core:2\.0:(User|Group):/i, '');
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export function serviceProviderConfig(baseUrl: string): Record<string, unknown> {
  return {
    schemas: [SPC_SCHEMA],
    documentationUri: 'https://github.com/evergreen-it-dev/folio/blob/main/docs/INSTALL.md#scim-provisioning',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: SCIM_MAX_RESULTS },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'Bearer token',
        description: 'The SCIM token generated for this provider in Folio, /admin/auth.',
        primary: true,
      },
    ],
    meta: { resourceType: 'ServiceProviderConfig', location: `${baseUrl}/ServiceProviderConfig` },
  };
}

export function resourceTypes(baseUrl: string): Array<Record<string, unknown>> {
  return [
    {
      schemas: [RESOURCE_TYPE_SCHEMA],
      id: 'User',
      name: 'User',
      endpoint: '/Users',
      description: 'A Folio account',
      schema: USER_SCHEMA,
      schemaExtensions: [],
      meta: { resourceType: 'ResourceType', location: `${baseUrl}/ResourceTypes/User` },
    },
    {
      schemas: [RESOURCE_TYPE_SCHEMA],
      id: 'Group',
      name: 'Group',
      endpoint: '/Groups',
      description: 'A Folio group',
      schema: GROUP_SCHEMA,
      schemaExtensions: [],
      meta: { resourceType: 'ResourceType', location: `${baseUrl}/ResourceTypes/Group` },
    },
  ];
}

function attr(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    type: 'string',
    multiValued: false,
    required: false,
    caseExact: false,
    mutability: 'readWrite',
    returned: 'default',
    uniqueness: 'none',
    ...extra,
  };
}

export function schemaDocuments(baseUrl: string): Array<Record<string, unknown>> {
  return [
    {
      schemas: [SCHEMA_SCHEMA],
      id: USER_SCHEMA,
      name: 'User',
      description: 'User account',
      attributes: [
        attr('userName', { required: true, uniqueness: 'server' }),
        attr('externalId', { caseExact: true }),
        attr('name', {
          type: 'complex',
          subAttributes: [attr('formatted'), attr('givenName'), attr('familyName')],
        }),
        attr('displayName'),
        attr('emails', {
          type: 'complex',
          multiValued: true,
          subAttributes: [attr('value'), attr('type'), attr('primary', { type: 'boolean' })],
        }),
        attr('active', { type: 'boolean' }),
      ],
      meta: { resourceType: 'Schema', location: `${baseUrl}/Schemas/${USER_SCHEMA}` },
    },
    {
      schemas: [SCHEMA_SCHEMA],
      id: GROUP_SCHEMA,
      name: 'Group',
      description: 'Group',
      attributes: [
        attr('displayName', { required: true }),
        attr('externalId', { caseExact: true }),
        attr('members', {
          type: 'complex',
          multiValued: true,
          subAttributes: [attr('value', { mutability: 'immutable', caseExact: true }), attr('display', { mutability: 'readOnly' }), attr('type', { mutability: 'immutable' })],
        }),
      ],
      meta: { resourceType: 'Schema', location: `${baseUrl}/Schemas/${GROUP_SCHEMA}` },
    },
  ];
}
