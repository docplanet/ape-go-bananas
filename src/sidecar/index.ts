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

import { FrameDecoder } from '../acp/framing.js';
import { createDispatcher } from './dispatch.js';
import type { SidecarInfo } from './methods.js';

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
  setImmediate(() => void dispatcher.closeAll().catch(() => undefined).then(() => outbound).then(() => process.exit(code)));
}

const dispatcher = createDispatcher({ info, send, onShutdown: () => exitAfterFlush(0) });

const decoder = new FrameDecoder();
process.stdin.on('data', (chunk: Buffer) => {
  if (exiting) return;
  for (const line of decoder.push(chunk)) dispatcher.handle(line);
});
process.stdin.on('end', () => {
  for (const line of decoder.end()) dispatcher.handle(line);
  exitAfterFlush(0);
});
process.stdin.on('error', (err: Error) => {
  process.stderr.write(`sidecar: stdin error: ${err.message}\n`);
  exitAfterFlush(0);
});
// A closed stdout means the app is gone; nothing left to say to anyone.
process.stdout.on('error', () => process.exit(0));

send(dispatcher.readyLine({ pid: process.pid }));
