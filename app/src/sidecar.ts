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
  data_dir: string | null;
}

// ---- agent-protocol.md shapes ---------------------------------------------

export interface Provider {
  id: string;
  kind: 'acp' | 'api';
  name: string;
  description: string;
  version: string | null;
  installed: boolean;
  installedVersion: string | null;
  distribution: 'npx' | 'binary' | 'uvx' | null;
  installable: boolean;
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string | null;
  type?: 'terminal';
}

export interface SelectOption {
  id: string;
  type: 'select';
  name: string;
  currentValue: string;
  options: { value: string; name: string }[];
}

export interface ConfigOption {
  id: string;
  type: 'select' | 'boolean';
  name: string;
  currentValue: string | boolean;
  options?: { value: string; name: string }[];
}

export interface ModeState {
  currentModeId: string;
  availableModes: { id: string; name: string; description?: string }[];
}

export interface SessionInfo {
  sessionId: string;
  modes: ModeState | null;
  configOptions: ConfigOption[] | null;
  commands: { name: string; description?: string }[];
}

export interface ConnectResult {
  connectionId: string;
  provider: string;
  kind: 'acp' | 'api';
  agent: { name: string; version: string } | null;
  authStatus: { kind: string; label: string } | null;
  authMethods: AuthMethod[];
  session: SessionInfo | null;
  authRequired: boolean;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string }
  | { type: 'resource'; resource: { uri: string; text: string; mimeType?: string } };

export type SessionUpdate = { sessionUpdate: string } & Record<string, unknown>;

export interface PermissionRequest {
  id: number;
  method: 'agent/requestPermission';
  params: {
    sessionId: string;
    toolCall: { toolCallId?: string; title?: string; kind?: string; locations?: { path: string }[] } & Record<string, unknown>;
    options: { optionId: string; name: string; kind: string }[];
  };
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
  /** Notifications the sidecar sends on its own: `sidecar/ready`, `agents/progress`, `agent/update`, `agent/loginOutput`, `agent/authStatus`. */
  onNotification: (handler: (method: string, params: unknown) => void): Promise<UnlistenFn> =>
    listen<{ method: string; params: unknown }>('sidecar://notification', (e) => handler(e.payload.method, e.payload.params)),
  /** Requests the sidecar makes of the app (agent-protocol.md §3). Answer with `answer`. */
  onRequest: (handler: (req: { id: number; method: string; params: unknown }) => void): Promise<UnlistenFn> =>
    listen<{ id: number; method: string; params: unknown }>('sidecar://request', (e) => handler(e.payload)),
  answer: (id: number, result: unknown) => invoke<void>('sidecar_answer', { id, result, error: null }),
  refuse: (id: number, message: string) => invoke<void>('sidecar_answer', { id, result: null, error: { code: -32000, message } }),

  // agents/* and agent/*
  listProviders: (dataDir: string, refresh = false) =>
    call<{ providers: Provider[]; registry: { fetchedAt: string | null; url: string; error: string | null } }>('agents/list', { dataDir, refresh }),
  installProvider: (dataDir: string, id: string) => call<{ id: string; package: string; version: string; bin: string }>('agents/install', { dataDir, id }),
  uninstallProvider: (dataDir: string, id: string) => call<{ id: string; removed: boolean }>('agents/uninstall', { dataDir, id }),
  connect: (params: { provider: string; dataDir: string; cwd: string; apiKey?: string }) => call<ConnectResult>('agent/connect', params),
  login: (connectionId: string, methodId: string) =>
    call<{ methodId: string; exitCode: number | null; authenticated: boolean } & Partial<ConnectResult>>('agent/login', { connectionId, methodId }),
  prompt: (sessionId: string, blocks: ContentBlock[]) => call<{ stopReason: string }>('agent/prompt', { sessionId, blocks }),
  cancel: (sessionId: string) => call<Record<string, never>>('agent/cancel', { sessionId }),
  setMode: (sessionId: string, modeId: string) => call<{ modes: ModeState }>('agent/setMode', { sessionId, modeId }),
  setConfigOption: (sessionId: string, id: string, value: string | boolean) =>
    call<{ configOptions: ConfigOption[] }>('agent/setConfigOption', { sessionId, id, value }),
  disconnect: (connectionId: string) => call<Record<string, never>>('agent/disconnect', { connectionId }),
};

/** OS credential store, through the Rust side. Names are provider ids. */
export const secrets = {
  get: (name: string) => invoke<string | null>('secret_get', { name }),
  set: (name: string, value: string) => invoke<void>('secret_set', { name, value }),
  delete: (name: string) => invoke<void>('secret_delete', { name }),
};
