// The shell's typed door to the sidecar, over whichever host is running it.
// One function per protocol method (docs/research/sidecar-protocol.md,
// agent-protocol.md); the shapes below are the protocol's. How a call
// travels is the host's business (host.ts): Tauri's invoke in the desktop
// app, loopback HTTP from the tool page.
//
// Not here: where an API key is kept. The desktop app has the OS keychain
// through Rust; the tool page has only the tab. The picker takes a store
// (agent/picker.ts, KeyStore) and hands the key to agent/connect either way.

import { EngineError, type EngineHost, type ReverseRequest } from './host.js';
import type { PipelineClient } from '../../../dist/pipeline/index.js';

export { EngineError, type EngineHost, type EngineInfo, type ReverseRequest } from './host.js';

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

export interface CourseFile {
  name: string;
  relPath: string;
  bytes: number;
  kind: 'pdf' | 'image' | 'audio' | 'video' | 'text' | 'slides' | 'doc' | 'other';
  mimeType: string;
}

/** What the page extracted from one source file, beside it (course/list's `extracted`). */
export interface Extracted {
  source: string;
  text: string | null;
  images: string[];
}

export interface PermissionRequest {
  id: number;
  method: 'agent/requestPermission';
  params: {
    sessionId: string;
    toolCall: { toolCallId?: string; title?: string; kind?: string; locations?: { path: string }[] } & Record<string, unknown>;
    options: { optionId: string; name: string; kind: string }[];
  };
}


export type SidecarClient = ReturnType<typeof makeSidecarClient>;

/** Every method of the sidecar, bound to one host. Satisfies PipelineClient. */
export function makeSidecarClient(host: EngineHost) {
  const call = <T>(method: string, params?: unknown) => host.call<T>(method, params);
  const client = {
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

    /**
     * Notifications the sidecar sends on its own: `agents/progress`,
     * `agent/update`, `agent/loginOutput`, `agent/authStatus`. ONE handler:
     * a second call replaces the first. UI code goes through agent/bus.ts,
     * which owns this slot and fans out.
     */
    onNotification: (handler: (method: string, params: unknown) => void) => host.onNotification(handler),
    /** Requests the sidecar makes of the shell (agent-protocol.md §3). One handler, same rule; see agent/bus.ts. */
    onRequest: (handler: (request: ReverseRequest) => void) => host.onRequest(handler),
    answer: (id: number, result: unknown) => host.answer(id, result),
    refuse: (id: number, message: string) => host.refuse(id, message),

    // agents/* and agent/*
    listProviders: (dataDir: string, refresh = false) =>
      call<{ providers: Provider[]; registry: { fetchedAt: string | null; url: string; error: string | null } }>('agents/list', { dataDir, refresh }),
    installProvider: (dataDir: string, id: string) => call<{ id: string; package: string; version: string; bin: string }>('agents/install', { dataDir, id }),
    uninstallProvider: (dataDir: string, id: string) => call<{ id: string; removed: boolean }>('agents/uninstall', { dataDir, id }),
    connect: (params: { provider: string; dataDir: string; cwd: string; apiKey?: string }) => call<ConnectResult>('agent/connect', params),
    login: (connectionId: string, methodId: string) =>
      call<{ methodId: string; exitCode: number | null; authenticated: boolean } & Partial<ConnectResult>>('agent/login', { connectionId, methodId }),
    newSession: (connectionId: string) => call<{ session: SessionInfo }>('agent/newSession', { connectionId }),
    listMethod: () => call<{ dir: string; files: { name: string; title: string; bytes: number }[] }>('method/list'),
    readMethod: (name: string) => call<{ name: string; text: string }>('method/read', { name }),
    listCourse: (path: string) =>
      call<{ path: string; files: CourseFile[]; artifacts: { inventory: boolean; plan: boolean; deck: boolean; flags: boolean; review: boolean }; extracted: Extracted[] }>('course/list', { path }),
    readCourse: (path: string, name: string) => call<{ name: string; text: string; bytes: number }>('course/read', { path, name }),
    /** One file beneath the course folder, text or bytes; directories are made. Confined to the folder like course/read. */
    writeCourse: (path: string, name: string, body: { text: string } | { base64: string }) => call<{ name: string; bytes: number }>('course/write', { path, name, ...body }),
    prompt: (sessionId: string, blocks: ContentBlock[]) => call<{ stopReason: string }>('agent/prompt', { sessionId, blocks }),
    cancel: (sessionId: string) => call<Record<string, never>>('agent/cancel', { sessionId }),
    setMode: (sessionId: string, modeId: string) => call<{ modes: ModeState }>('agent/setMode', { sessionId, modeId }),
    setConfigOption: (sessionId: string, id: string, value: string | boolean) =>
      call<{ configOptions: ConfigOption[] }>('agent/setConfigOption', { sessionId, id, value }),
    disconnect: (connectionId: string) => call<Record<string, never>>('agent/disconnect', { connectionId }),

    /** PipelineClient: a sidecar-reported failure, as opposed to a bug. */
    isRpcError: (err: unknown): boolean => err instanceof EngineError,
  } satisfies PipelineClient & Record<string, unknown>;
  return client;
}
