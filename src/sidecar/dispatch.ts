// The sidecar's JSON-RPC core, with its transport left out.
//
// Everything that decides what a message means lives here: the method table,
// the reverse channel for requests the sidecar makes of its host (agent/
// requestPermission), and the ordering rule that responses leave in arrival
// order. What it does NOT know is where lines come from or go to. The host
// hands in one `send(line)` and feeds `handle()` decoded lines; index.ts does
// that over stdin/stdout for the desktop app, serve.ts over HTTP for the
// browser. One core, two transports, and the sidecar oracle in test/sidecar
// exercises the core through whichever transport a test spawns.

import { type DecodedLine, type RequestId, encodeErrorResponse, encodeNotification, encodeRequest, encodeSuccessResponse } from '../acp/framing.js';
import { AgentBridge } from './agent.js';
import { courseMethods } from './course.js';
import { ankiMethods } from './anki.js';
import { InvalidParams, buildMethods, type MethodHandler, type SidecarInfo } from './methods.js';

export interface DispatcherOptions {
  info: SidecarInfo;
  /** Writes one framed line (newline included) to the host. Must preserve order. */
  send: (line: string) => void;
  /** Called when a `sidecar/shutdown` request is handled; the host decides what exiting means. */
  onShutdown: () => void;
}

export interface Dispatcher {
  /** Feed one decoded inbound line. Never throws. */
  handle(decoded: DecodedLine): void;
  /** Reaps every agent process. Hosts call this before exiting. */
  closeAll(): Promise<void>;
  /** The `sidecar/ready` line a host sends first. */
  readyLine(extra?: Record<string, unknown>): string;
}

export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const { info, send } = options;

  // agent-protocol.md §3: requests the sidecar sends to the app (reverse
  // direction). Ids come from their own counter, numbers, and the app's
  // response resolves them here.
  let nextReverseId = 1;
  const pendingReverse = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const appLink = {
    notify(method: string, params: unknown): void {
      send(encodeNotification(method, params));
    },
    request(method: string, params: unknown): Promise<unknown> {
      const id = nextReverseId++;
      return new Promise((resolve, reject) => {
        pendingReverse.set(id, { resolve, reject });
        send(encodeRequest(id, method, params));
      });
    },
  };
  const bridge = new AgentBridge(appLink);

  const methods: Record<string, MethodHandler> = {
    ...buildMethods(info, options.onShutdown),
    ...courseMethods(),
    ...ankiMethods(),
    ...bridge.methods(),
  };

  function respondError(id: RequestId, code: number, message: string, data?: unknown): void {
    send(encodeErrorResponse(id, data === undefined ? { code, message } : { code, message, data }));
  }

  function respondFailure(id: RequestId, err: unknown): void {
    if (err instanceof InvalidParams) {
      respondError(id, err.code, err.message);
    } else {
      const error = err as Error;
      respondError(id, -32000, error?.message ?? String(err), { name: error?.name ?? 'Error' });
    }
  }

  function handle(decoded: DecodedLine): void {
    if (!decoded.ok) {
      // §3: not JSON, or JSON that is not a JSON-RPC message shape.
      respondError(null, -32700, decoded.error.message);
      return;
    }
    const message = decoded.message;
    switch (message.kind) {
      case 'request': {
        const handler = methods[message.method];
        if (handler === undefined) {
          respondError(message.id, -32601, `method not found: ${message.method}`);
          return;
        }
        // Engine handlers are synchronous, so their responses leave in
        // arrival order (§2.2). Agent handlers return promises and answer
        // when done, which is what lets `agent/cancel` land mid-turn.
        try {
          const result = handler(message.params);
          if (result instanceof Promise) {
            result.then(
              (value) => send(encodeSuccessResponse(message.id, value)),
              (err: unknown) => respondFailure(message.id, err),
            );
          } else {
            send(encodeSuccessResponse(message.id, result));
          }
        } catch (err) {
          respondFailure(message.id, err);
        }
        return;
      }
      case 'notification': {
        // §3: unknown or throwing notifications are ignored; there is no id to answer.
        const handler = methods[message.method];
        if (handler === undefined) return;
        try {
          const r = handler(message.params);
          if (r instanceof Promise) r.catch(() => undefined);
        } catch {
          /* ignored by contract */
        }
        return;
      }
      case 'response':
      case 'error-response': {
        // The app answering one of our reverse requests (agent-protocol.md §3).
        const id = typeof message.id === 'number' ? message.id : Number(message.id);
        const pending = pendingReverse.get(id);
        if (pending === undefined) {
          process.stderr.write(`sidecar: response for unknown reverse id ${String(message.id)}, ignored\n`);
          return;
        }
        pendingReverse.delete(id);
        if (message.kind === 'response') pending.resolve(message.result);
        else pending.reject(new Error(message.error.message));
        return;
      }
    }
  }

  return {
    handle,
    closeAll: () => bridge.closeAll(),
    readyLine: (extra = {}) => encodeNotification('sidecar/ready', { ...info, ...extra }),
  };
}
