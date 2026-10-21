/**
 * The pure half of the artifact bridge (docs/spec-artifacts.md §3): which messages from the frame are ours, the
 * limits a stored value has to respect, and the answer to every request against an in-memory ArtifactState.
 * useArtifactBridge.ts wires it to the iframe, localStorage and the API.
 */
import {
  ARTIFACT_LIMITS,
  type ArtifactBridgeRequest,
  type ArtifactBridgeResponse,
  type ArtifactState,
} from '@shared/contracts';

const OPS = new Set(['init', 'get', 'set', 'delete', 'list']);

/** True for a well-formed request of the bridge protocol; anything else is somebody else's message and is ignored. */
export function isBridgeRequest(data: unknown): data is ArtifactBridgeRequest {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (d.folio !== 'artifact' || typeof d.id !== 'number' || typeof d.op !== 'string' || !OPS.has(d.op)) return false;
  if (d.op === 'init') return true;
  if (typeof d.shared !== 'boolean') return false;
  if (d.op === 'list') return typeof d.prefix === 'string';
  if (typeof d.key !== 'string') return false;
  return d.op !== 'set' || typeof d.value === 'string';
}

export const SHARED_NEEDS_SIGN_IN = 'Shared state needs sign-in';

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** An error text when the key or value breaks ARTIFACT_LIMITS (or the personal total would), otherwise null. */
export function limitError(state: ArtifactState, key: string, value: string | null, shared: boolean): string | null {
  if (key.length === 0 || key.length > ARTIFACT_LIMITS.maxStateKeyChars) {
    return `Keys must be 1-${ARTIFACT_LIMITS.maxStateKeyChars} characters`;
  }
  if (value === null) return null;
  const size = byteLength(value);
  if (size > ARTIFACT_LIMITS.maxStateValueBytes) {
    return `A value is limited to ${ARTIFACT_LIMITS.maxStateValueBytes / 1024} KB`;
  }
  const bucket = shared ? state.shared : state.personal;
  let total = size;
  for (const [k, v] of Object.entries(bucket)) if (k !== key) total += byteLength(v);
  if (total > ARTIFACT_LIMITS.maxStateTotalBytes) {
    return `Stored state is limited to ${ARTIFACT_LIMITS.maxStateTotalBytes / (1024 * 1024)} MB`;
  }
  return null;
}

export interface BridgeEffect {
  response: ArtifactBridgeResponse;
  /** A write the caller has to persist (personal or shared bucket, null = delete), or undefined for a read / a refused request. */
  write?: { shared: boolean; key: string; value: string | null };
}

/**
 * Answers one request. A write is applied to `state` here (so a read right after it sees it) and handed back in
 * `write` for the caller to persist. `canWriteShared` is false when the reader has no server-side state.
 */
export function answerRequest(req: ArtifactBridgeRequest, state: ArtifactState, canWriteShared: boolean): BridgeEffect {
  const base = { folio: 'artifact', id: req.id } as const;
  const refuse = (error: string): BridgeEffect => ({ response: { ...base, ok: false, error } });
  if (req.op === 'init') return { response: { ...base, ok: true, state } };
  const bucket = req.shared ? state.shared : state.personal;
  if (req.op === 'get') return { response: { ...base, ok: true, value: Object.hasOwn(bucket, req.key) ? bucket[req.key] : null } };
  if (req.op === 'list') {
    const keys = Object.keys(bucket)
      .filter((k) => k.startsWith(req.prefix))
      .sort();
    return { response: { ...base, ok: true, keys } };
  }
  if (req.shared && !canWriteShared) return refuse(SHARED_NEEDS_SIGN_IN);
  const value = req.op === 'set' ? req.value : null;
  const error = limitError(state, req.key, value, req.shared);
  if (error) return refuse(error);
  if (value === null) delete bucket[req.key];
  else bucket[req.key] = value;
  return { response: { ...base, ok: true, ...(value === null ? {} : { value }) }, write: { shared: req.shared, key: req.key, value } };
}

/** The personal state saved in the parent's localStorage for a reader without server-side state. */
export function localStateKey(pageId: string): string {
  return `folio:artifact:${pageId}`;
}

export function readLocalPersonal(pageId: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(localStateKey(pageId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** False when the browser refused the write (private window, quota, blocked storage). */
export function writeLocalPersonal(pageId: string, personal: Record<string, string>): boolean {
  try {
    localStorage.setItem(localStateKey(pageId), JSON.stringify(personal));
    return true;
  } catch {
    return false;
  }
}
