// The app's one door to the engine. Every call goes through the Rust side
// (src-tauri/src/sidecar.rs), which owns the Node child process and speaks
// docs/research/sidecar-protocol.md to it. This file is the typed surface
// the designed screens will call; nothing in it knows what a card is.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface DeckNote {
  deckName: string;
  modelName: string;
  fields: { Text: string; Extra: string; Source: string };
  tags: string[];
}

export interface Finding {
  message: string;
  noteIndex?: number;
}

export interface CheckResult {
  result: { findings: Finding[]; notesCount: number };
  report: string;
  clean: boolean;
  count: number;
  mediaNote: string | null;
}

export interface Flag {
  noteIndex: number;
  note: string;
  at: string;
}

export interface SidecarStatus {
  running: boolean;
  node: string | null;
  script: string | null;
  error: string | null;
  initial_deck: string | null;
}

export class SidecarError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'SidecarError';
  }
}

async function call<T>(method: string, params?: unknown): Promise<T> {
  try {
    return (await invoke('sidecar_call', { method, params: params ?? null })) as T;
  } catch (err) {
    // sidecar.rs serialises a JSON-RPC error as {code, message, data}; any
    // other failure (spawn, transport) arrives as a plain string.
    if (typeof err === 'object' && err !== null && 'code' in err) {
      const e = err as { code: number; message: string; data?: unknown };
      throw new SidecarError(e.code, e.message, e.data);
    }
    throw new SidecarError(-1, String(err));
  }
}

export const sidecar = {
  status: () => invoke<SidecarStatus>('sidecar_status'),
  ping: () => call<{ engine: string; version: string; node: string }>('sidecar/ping'),
  mediaDir: () => call<{ mediaDir: string; exists: boolean }>('media/dir'),
  load: (path: string) => call<{ notes: DeckNote[]; count: number }>('deck/load', { path }),
  check: (path: string, opts: { checkMedia?: boolean; mediaDir?: string } = {}) =>
    call<CheckResult>('deck/check', { path, ...opts }),
  review: (path: string, opts: { mediaDir?: string; outPath?: string } = {}) =>
    call<{ html: string; count: number; outPath: string | null }>('deck/review', { path, ...opts }),
  export: (path: string, opts: { outPath?: string; deckName?: string; mediaDir?: string } = {}) =>
    call<{ outPath: string; count: number; unresolvedMedia: string[] }>('deck/export', { path, ...opts }),
  readFlags: (path: string) => call<{ flags: Flag[]; flagsPath: string }>('flags/read', { path }),
  writeFlags: (path: string, flags: Flag[]) => call<{ flagsPath: string; count: number }>('flags/write', { path, flags }),
  /** Notifications the sidecar sends on its own (`sidecar/ready` now; `agent/update` later). */
  onNotification: (handler: (method: string, params: unknown) => void): Promise<UnlistenFn> =>
    listen<{ method: string; params: unknown }>('sidecar://notification', (e) => handler(e.payload.method, e.payload.params)),
};
