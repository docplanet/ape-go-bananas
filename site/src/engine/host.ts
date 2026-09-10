// What the page needs from whatever is hosting the engine, so the panes do
// not know which one they are talking to.
//
// There are two hosts. `ape-bridge` runs the sidecar as a process on the
// user's machine and serves it over loopback HTTP (bridge-transport.ts).
// The container runs the same sidecar inside the tab, on WebContainer's
// Node, and speaks to it over a pipe (../container/host.ts). Same program,
// same method table, same JSON-RPC -- only the pipe differs, so this is the
// whole of the difference.

import type { BridgeInfo, ReverseRequest } from './bridge-transport.js';

export interface EngineHost {
  /** What the sidecar said about itself when it came up. */
  readonly info: BridgeInfo;
  /** Absolute path of the folder the user's material lives in, in this host's filesystem, or null when the user has not named one. */
  courseRoot(): string | null;
  /** Where agents are installed: the sidecar's data dir, as the agents/* methods take it. */
  dataDir(): string;
  call<T>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): Promise<void>;
  answer(id: number, result: unknown): Promise<void>;
  refuse(id: number, message: string): Promise<void>;
  onNotification(handler: (method: string, params: unknown) => void): void;
  /** Requests the sidecar makes of the page (agent-protocol.md §3). */
  onRequest(handler: (request: ReverseRequest) => void): void;
  /** One file beneath `root`, or null when it is not there. */
  readFile(root: string, relPath: string): Promise<Uint8Array | null>;
  close(): void;
}
