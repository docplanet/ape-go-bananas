#!/usr/bin/env node
// The engine as a stdio sidecar -- docs/research/sidecar-protocol.md. The
// app's webview cannot run node:sqlite or spawn an agent, so it spawns this
// process and speaks newline-delimited JSON-RPC 2.0 to it (§1). Framing is
// src/acp/framing.ts, unchanged: the same decoder that reads a real agent's
// stdout reads the app's stdin here, so a framing bug would show up in the
// ACP suite before it ever reached the app.
//
// stdout is protocol-only. Nothing in this file or in methods.ts may
// console.log; diagnostics go to stderr (§1).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  FrameDecoder,
  encodeErrorResponse,
  encodeNotification,
  encodeRequest,
  encodeSuccessResponse,
  type DecodedLine,
  type RequestId,
} from '../acp/framing.js';
import { AgentBridge } from './agent.js';
import { courseMethods } from './course.js';
import { InvalidParams, buildMethods, type MethodHandler, type SidecarInfo } from './methods.js';

function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version?: string };
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
}

const info: SidecarInfo = { engine: 'ape', version: packageVersion(), node: process.versions.node };

// §2.2-2.4: responses go out in arrival order, and exit only once every
// pending write has drained. Writes are queued through one promise chain so
// a `shutdown` or EOF exit can wait on the tail of it.
let outbound: Promise<void> = Promise.resolve();
function send(line: string): void {
  outbound = outbound.then(
    () =>
      new Promise<void>((resolve) => {
        if (!process.stdout.write(line)) process.stdout.once('drain', () => resolve());
        else resolve();
      }),
  );
}

let exiting = false;
function exitAfterFlush(code: number): void {
  if (exiting) return;
  exiting = true;
  process.stdin.pause();
  // Deferred one tick so a handler that requested the exit (shutdown) gets
  // its own response queued first -- `outbound` is re-read then, not now.
  // Agent processes are reaped before the flush (§2 agent/disconnect).
  setImmediate(() => void bridge.closeAll().catch(() => undefined).then(() => outbound).then(() => process.exit(code)));
}

// §3 of agent-protocol.md: requests the sidecar sends to the app (reverse
// direction). Ids come from their own counter, numbers, and the app's
// response on stdin resolves them here.
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

const methods: Record<string, MethodHandler> = { ...buildMethods(info, () => exitAfterFlush(0)), ...courseMethods(), ...bridge.methods() };

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

const decoder = new FrameDecoder();
process.stdin.on('data', (chunk: Buffer) => {
  if (exiting) return;
  for (const line of decoder.push(chunk)) handle(line);
});
process.stdin.on('end', () => {
  for (const line of decoder.end()) handle(line);
  exitAfterFlush(0);
});
process.stdin.on('error', (err: Error) => {
  process.stderr.write(`sidecar: stdin error: ${err.message}\n`);
  exitAfterFlush(0);
});
// A closed stdout means the app is gone; nothing left to say to anyone.
process.stdout.on('error', () => process.exit(0));

send(encodeNotification('sidecar/ready', { ...info, pid: process.pid }));
