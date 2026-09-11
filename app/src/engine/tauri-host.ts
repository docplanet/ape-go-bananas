// The desktop app's door to the engine: EngineHost over Tauri. Every call
// goes through the Rust side (src-tauri/src/sidecar.rs), which owns the
// Node child process and speaks docs/research/sidecar-protocol.md to it over
// stdio; notifications and reverse requests arrive as Tauri events. Nothing
// here knows what a card is.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { fromBase64 } from './bytes.js';
import { EngineError, type EngineHost, type EngineInfo, type ReverseRequest } from './host.js';

/** What sidecar.rs reports about the child it spawned (or failed to). */
export interface SidecarStatus {
  running: boolean;
  node: string | null;
  script: string | null;
  error: string | null;
  /** A deck.json the app was opened with, if any. */
  initial_deck: string | null;
  data_dir: string | null;
}

export const sidecarStatus = (): Promise<SidecarStatus> => invoke<SidecarStatus>('sidecar_status');

async function call<T>(method: string, params?: unknown): Promise<T> {
  try {
    return (await invoke('sidecar_call', { method, params: params ?? null })) as T;
  } catch (err) {
    // sidecar.rs serialises a JSON-RPC error as {code, message, data}; any
    // other failure (spawn, transport) arrives as a plain string.
    if (typeof err === 'object' && err !== null && 'code' in err) {
      const e = err as { code: number; message: string; data?: unknown };
      throw new EngineError(e.code, e.message, e.data);
    }
    throw new EngineError(-1, String(err));
  }
}

export class TauriHost implements EngineHost {
  private readonly unlisten: Promise<UnlistenFn>[] = [];

  private constructor(
    readonly info: EngineInfo,
    private readonly status: SidecarStatus,
  ) {}

  /** Pings the sidecar Rust started; throws with sidecar.rs's reason when it did not start. */
  static async start(status: SidecarStatus): Promise<TauriHost> {
    if (!status.running) throw new EngineError(-1, status.error ?? 'engine not running');
    const info = await call<{ engine: string; version: string; node: string }>('sidecar/ping');
    return new TauriHost({ ...info, transport: 'stdio' }, status);
  }

  /** The folder of the deck.json the app was opened with, when it was. */
  courseRoot(): string | null {
    return this.status.initial_deck?.replace(/[\\/][^\\/]+$/, '') ?? null;
  }

  dataDir(): string {
    return this.status.data_dir ?? '';
  }

  call<T>(method: string, params?: unknown): Promise<T> {
    return call<T>(method, params);
  }

  answer(id: number, result: unknown): Promise<void> {
    return invoke<void>('sidecar_answer', { id, result, error: null });
  }

  refuse(id: number, message: string): Promise<void> {
    return invoke<void>('sidecar_answer', { id, result: null, error: { code: -32000, message } });
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.unlisten.push(listen<{ method: string; params: unknown }>('sidecar://notification', (e) => handler(e.payload.method, e.payload.params)));
  }

  onRequest(handler: (request: ReverseRequest) => void): void {
    this.unlisten.push(listen<ReverseRequest>('sidecar://request', (e) => handler(e.payload)));
  }

  /** The bytes of one file in the course folder, through the sidecar (course/read with base64): the webview has no filesystem of its own. */
  async readFile(root: string, relPath: string): Promise<Uint8Array | null> {
    try {
      const r = await call<{ base64: string }>('course/read', { path: root, name: relPath, encoding: 'base64' });
      return fromBase64(r.base64);
    } catch (err) {
      if (err instanceof EngineError) return null;
      throw err;
    }
  }

  close(): void {
    for (const p of this.unlisten) void p.then((un) => un());
    this.unlisten.length = 0;
  }
}

/** OS credential store, through the Rust side. Names are provider ids. */
export const secrets = {
  get: (name: string) => invoke<string | null>('secret_get', { name }),
  set: (name: string, value: string) => invoke<void>('secret_set', { name, value }),
  delete: (name: string) => invoke<void>('secret_delete', { name }),
};
