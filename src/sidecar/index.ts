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
  encodeSuccessResponse,
  type DecodedLine,
  type RequestId,
} from '../acp/framing.js';
import { InvalidParams, buildMethods, type SidecarInfo } from './methods.js';

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
  setImmediate(() => void outbound.then(() => process.exit(code)));
}

const methods = buildMethods(info, () => exitAfterFlush(0));

function respondError(id: RequestId, code: number, message: string, data?: unknown): void {
  send(encodeErrorResponse(id, data === undefined ? { code, message } : { code, message, data }));
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
      try {
        const result = handler(message.params);
        send(encodeSuccessResponse(message.id, result));
      } catch (err) {
        if (err instanceof InvalidParams) {
          respondError(message.id, err.code, err.message);
        } else {
          const error = err as Error;
          respondError(message.id, -32000, error?.message ?? String(err), { name: error?.name ?? 'Error' });
        }
      }
      return;
    }
    case 'notification': {
      // §3: unknown or throwing notifications are ignored; there is no id to answer.
      const handler = methods[message.method];
      if (handler === undefined) return;
      try {
        handler(message.params);
      } catch {
        /* ignored by contract */
      }
      return;
    }
    default:
      // A response addressed to us: the app is the client, we never send
      // requests (until agent/requestPermission, §5), so there is nothing
      // to correlate. Dropped, noted on stderr.
      process.stderr.write(`sidecar: unexpected ${message.kind} on stdin, ignored\n`);
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
