/**
 * The parent half of the artifact bridge. The sandboxed frame (no allow-same-origin: an opaque origin, no cookies,
 * no storage of its own) talks to this page by postMessage — bridge.js, injected by the server, turns window.storage
 * and localStorage into ArtifactBridgeRequests; this hook answers them (shared/contracts.ts, "postMessage protocol").
 *
 * Only the iframe's own contentWindow is listened to, and only the state is ever sent back — to '*', because the
 * frame's origin is opaque and cannot be named. Where the state lives:
 *   - a signed-in reader (`stateServer`): GET/PUT /api/pages/:id/artifact/state, personal and shared;
 *   - anyone else (public site, share link): personal in this page's localStorage under `folio:artifact:<pageId>`,
 *     shared is whatever init returned (nothing) and read-only.
 */
import { useEffect, type RefObject } from 'react';
import type { ArtifactState } from '@shared/contracts';
import { api } from '../app/api';
import { answerRequest, isBridgeRequest, readLocalPersonal, writeLocalPersonal } from './bridgeCore';

/** A burst of writes to one key (a slider, a counter) becomes one PUT. */
const WRITE_DEBOUNCE_MS = 250;

interface PendingWrite {
  value: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
}

export function useArtifactBridge(iframeRef: RefObject<HTMLIFrameElement | null>, pageId: string, stateServer: boolean, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let loading: Promise<ArtifactState> | null = null;
    // Writes per `<shared>:<key>`: the latest value wins, and a key never has two PUTs in flight (they could land out of order).
    const writes = new Map<string, PendingWrite>();

    function load(): Promise<ArtifactState> {
      if (!loading) {
        loading = stateServer
          ? api.getArtifactState(pageId).then((s) => ({ personal: { ...s.personal }, shared: { ...s.shared } }))
          : Promise.resolve({ personal: readLocalPersonal(pageId), shared: {} });
        // A failed load is not cached: the next request asks again, meanwhile the artifact sees an empty state.
        loading.catch(() => {
          loading = null;
        });
      }
      return loading;
    }

    function flush(slot: string, shared: boolean, key: string) {
      const entry = writes.get(slot);
      if (!entry || entry.inFlight) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      const value = entry.value;
      entry.inFlight = true;
      api
        .putArtifactState(pageId, { shared, key, value })
        .catch(() => {
          // The server said no (limits, access): what the frame holds is no longer what is stored — read it again next time.
          loading = null;
        })
        .finally(() => {
          entry.inFlight = false;
          if (entry.value !== value) flush(slot, shared, key);
          else writes.delete(slot);
        });
    }

    function schedule(shared: boolean, key: string, value: string | null) {
      const slot = `${shared ? 's' : 'p'}:${key}`;
      const entry = writes.get(slot) ?? { value, timer: null, inFlight: false };
      entry.value = value;
      writes.set(slot, entry);
      if (entry.inFlight) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => flush(slot, shared, key), WRITE_DEBOUNCE_MS);
    }

    function onMessage(event: MessageEvent) {
      const frame = iframeRef.current?.contentWindow;
      if (!frame || event.source !== frame || !isBridgeRequest(event.data)) return;
      const req = event.data;
      const reply = (response: unknown) => frame.postMessage(response, '*');
      load().then(
        (state) => {
          if (disposed) return;
          const { response, write } = answerRequest(req, state, stateServer);
          if (write) {
            if (stateServer) schedule(write.shared, write.key, write.value);
            else if (!writeLocalPersonal(pageId, state.personal)) {
              loading = null;
              reply({ folio: 'artifact', id: req.id, ok: false, error: 'Could not save: the browser refused to store it' });
              return;
            }
          }
          reply(response);
        },
        () => reply({ folio: 'artifact', id: req.id, ok: false, error: 'Could not load the saved state' }),
      );
    }

    window.addEventListener('message', onMessage);
    return () => {
      disposed = true;
      window.removeEventListener('message', onMessage);
      // Leaving the page must not drop a write still waiting out its debounce.
      for (const [slot, entry] of writes) {
        if (entry.timer && !entry.inFlight) flush(slot, slot.startsWith('s:'), slot.slice(2));
      }
    };
  }, [iframeRef, pageId, stateServer, enabled]);
}
