// One events stream, many listeners. The bridge transport holds a single
// notification handler and a single request handler; the picker, the chat
// pane and the stage runner each need to hear some of it. This fans out.
//
// Requests are different from notifications: exactly one listener must
// answer each, so a request handler returns true when it took the request,
// and the first taker wins. A request nobody takes is refused, so the
// sidecar never waits on an answer that will not come.

import type { ReverseRequest, SidecarClient } from '../engine/bridge-client.js';

export interface Bus {
  onNotification(handler: (method: string, params: unknown) => void): () => void;
  /**
   * `fallback: true` registers a handler consulted only when no ordinary one
   * took the request -- for sessions no pane owns, such as the auditor's and
   * the adjudicator's fresh sessions (permission-any.ts).
   */
  onRequest(handler: (request: ReverseRequest) => boolean, options?: { fallback?: boolean }): () => void;
}

export function makeBus(sidecar: SidecarClient): Bus {
  const notificationHandlers = new Set<(method: string, params: unknown) => void>();
  const requestHandlers = new Set<(request: ReverseRequest) => boolean>();
  const fallbackHandlers = new Set<(request: ReverseRequest) => boolean>();

  sidecar.onNotification((method, params) => {
    for (const h of notificationHandlers) h(method, params);
  });
  sidecar.onRequest((request) => {
    for (const h of requestHandlers) if (h(request)) return;
    for (const h of fallbackHandlers) if (h(request)) return;
    // Nothing on this page can answer it. Refusing is still better than
    // silence -- a request left unanswered is an agent left waiting forever.
    void sidecar.refuse(request.id, `no handler for ${request.method}`);
  });

  return {
    onNotification(handler) {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    onRequest(handler, options) {
      const set = options?.fallback ? fallbackHandlers : requestHandlers;
      set.add(handler);
      return () => set.delete(handler);
    },
  };
}
