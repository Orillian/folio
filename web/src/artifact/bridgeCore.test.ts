import { describe, expect, it } from 'vitest';
import { ARTIFACT_LIMITS, type ArtifactState } from '@shared/contracts';
import { answerRequest, isBridgeRequest, limitError, SHARED_NEEDS_SIGN_IN } from './bridgeCore';

const state = (): ArtifactState => ({ personal: { 'a:1': 'x', 'a:2': 'y', b: 'z' }, shared: { s: 'shared' } });

describe('isBridgeRequest', () => {
  it('accepts only well-formed requests of the protocol', () => {
    expect(isBridgeRequest({ folio: 'artifact', id: 1, op: 'init' })).toBe(true);
    expect(isBridgeRequest({ folio: 'artifact', id: 2, op: 'get', key: 'k', shared: false })).toBe(true);
    expect(isBridgeRequest({ folio: 'artifact', id: 3, op: 'set', key: 'k', value: 'v', shared: true })).toBe(true);
    expect(isBridgeRequest({ folio: 'artifact', id: 4, op: 'list', prefix: '', shared: false })).toBe(true);
    expect(isBridgeRequest({ folio: 'other', id: 1, op: 'init' })).toBe(false);
    expect(isBridgeRequest({ folio: 'artifact', id: '1', op: 'init' })).toBe(false);
    expect(isBridgeRequest({ folio: 'artifact', id: 1, op: 'explode' })).toBe(false);
    expect(isBridgeRequest({ folio: 'artifact', id: 1, op: 'set', key: 'k', shared: false })).toBe(false);
    expect(isBridgeRequest({ folio: 'artifact', id: 1, op: 'get', key: 'k' })).toBe(false);
    expect(isBridgeRequest(null)).toBe(false);
    expect(isBridgeRequest('artifact')).toBe(false);
  });
});

describe('answerRequest', () => {
  it('answers init with the whole state', () => {
    const s = state();
    expect(answerRequest({ folio: 'artifact', id: 1, op: 'init' }, s, true).response).toEqual({ folio: 'artifact', id: 1, ok: true, state: s });
  });

  it('reads a value, null for a missing key, and lists by prefix in order', () => {
    const s = state();
    expect(answerRequest({ folio: 'artifact', id: 2, op: 'get', key: 'b', shared: false }, s, true).response).toMatchObject({ ok: true, value: 'z' });
    expect(answerRequest({ folio: 'artifact', id: 3, op: 'get', key: 'nope', shared: false }, s, true).response).toMatchObject({ ok: true, value: null });
    expect(answerRequest({ folio: 'artifact', id: 4, op: 'get', key: 's', shared: true }, s, true).response).toMatchObject({ value: 'shared' });
    expect(answerRequest({ folio: 'artifact', id: 5, op: 'list', prefix: 'a:', shared: false }, s, true).response).toMatchObject({ keys: ['a:1', 'a:2'] });
  });

  it('applies a write to the state and hands it back for persisting', () => {
    const s = state();
    const set = answerRequest({ folio: 'artifact', id: 6, op: 'set', key: 'n', value: '1', shared: false }, s, true);
    expect(set.response).toMatchObject({ ok: true, value: '1' });
    expect(set.write).toEqual({ shared: false, key: 'n', value: '1' });
    expect(s.personal.n).toBe('1');
    const del = answerRequest({ folio: 'artifact', id: 7, op: 'delete', key: 'n', shared: false }, s, true);
    expect(del.write).toEqual({ shared: false, key: 'n', value: null });
    expect(s.personal.n).toBeUndefined();
  });

  it('refuses a shared write without server-side state', () => {
    const s = state();
    const r = answerRequest({ folio: 'artifact', id: 8, op: 'set', key: 's', value: 'x', shared: true }, s, false);
    expect(r.response).toEqual({ folio: 'artifact', id: 8, ok: false, error: SHARED_NEEDS_SIGN_IN });
    expect(r.write).toBeUndefined();
    expect(s.shared.s).toBe('shared');
  });
});

describe('limitError', () => {
  it('enforces the key and value limits', () => {
    expect(limitError(state(), '', 'v', false)).not.toBeNull();
    expect(limitError(state(), 'k'.repeat(ARTIFACT_LIMITS.maxStateKeyChars + 1), 'v', false)).not.toBeNull();
    expect(limitError(state(), 'k'.repeat(ARTIFACT_LIMITS.maxStateKeyChars), 'v', false)).toBeNull();
    expect(limitError(state(), 'k', 'x'.repeat(ARTIFACT_LIMITS.maxStateValueBytes + 1), false)).not.toBeNull();
    expect(limitError(state(), 'k', 'x'.repeat(ARTIFACT_LIMITS.maxStateValueBytes), false)).toBeNull();
  });

  it('counts bytes, not characters', () => {
    expect(limitError(state(), 'k', 'é'.repeat(ARTIFACT_LIMITS.maxStateValueBytes / 2 + 1), false)).not.toBeNull();
  });

  it('caps the total of one bucket, not counting the key being overwritten', () => {
    const big = 'x'.repeat(ARTIFACT_LIMITS.maxStateValueBytes);
    const full: ArtifactState = { personal: {}, shared: {} };
    const keys = ARTIFACT_LIMITS.maxStateTotalBytes / ARTIFACT_LIMITS.maxStateValueBytes;
    for (let i = 0; i < keys; i++) full.personal[`k${i}`] = big;
    expect(limitError(full, 'extra', 'x', false)).not.toBeNull();
    expect(limitError(full, 'k0', big, false)).toBeNull();
    expect(limitError(full, 'extra', 'x', true)).toBeNull();
    expect(limitError(full, 'k0', null, false)).toBeNull();
  });
});
