// The page's typed door to the sidecar, over the bridge -- the browser's
// counterpart of app/src/sidecar.ts. One function per protocol method
// (docs/research/sidecar-protocol.md, agent-protocol.md); the shapes below
// are the desktop app's, unchanged, because they are the protocol's. What
// differs is only how a call travels: bridge-transport.ts, not Tauri.
//
// Not here: `secrets`. The desktop app kept API keys in the OS keychain
// through Rust; a page has no keychain, and the bridge has no store yet. An
// OpenRouter key entered on the page is passed to agent/connect for that
// connection and otherwise held only in memory -- see docs/APP.md.

import { Bridge, BridgeError, type ReverseRequest } from './bridge-transport.js';
import type { PipelineClient } from '../../../dist/pipeline/index.js';

export { Bridge, BridgeError, locateBridge, type BridgeLocator, type ReverseRequest } from './bridge-transport.js';

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

/** Every method of the sidecar, bound to one bridge. Satisfies PipelineClient. */
export function makeSidecarClient(bridge: Bridge) {
  const call = <T>(method: string, params?: unknown) => bridge.call<T>(method, params);
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
    onNotification: (handler: (method: string, params: unknown) => void) => bridge.onNotification(handler),
    /** Requests the sidecar makes of the page (agent-protocol.md §3). One handler, same rule; see agent/bus.ts. */
    onRequest: (handler: (request: ReverseRequest) => void) => bridge.onRequest(handler),
    answer: (id: number, result: unknown) => bridge.answer(id, result),
    refuse: (id: number, message: string) => bridge.refuse(id, message),

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
      call<{ path: string; files: CourseFile[]; artifacts: { inventory: boolean; plan: boolean; deck: boolean; flags: boolean; review: boolean } }>('course/list', { path }),
    readCourse: (path: string, name: string) => call<{ name: string; text: string; bytes: number }>('course/read', { path, name }),
    prompt: (sessionId: string, blocks: ContentBlock[]) => call<{ stopReason: string }>('agent/prompt', { sessionId, blocks }),
    cancel: (sessionId: string) => call<Record<string, never>>('agent/cancel', { sessionId }),
    setMode: (sessionId: string, modeId: string) => call<{ modes: ModeState }>('agent/setMode', { sessionId, modeId }),
    setConfigOption: (sessionId: string, id: string, value: string | boolean) =>
      call<{ configOptions: ConfigOption[] }>('agent/setConfigOption', { sessionId, id, value }),
    disconnect: (connectionId: string) => call<Record<string, never>>('agent/disconnect', { connectionId }),

    /** PipelineClient: a sidecar-reported failure, as opposed to a bug. */
    isRpcError: (err: unknown): boolean => err instanceof BridgeError,
  } satisfies PipelineClient & Record<string, unknown>;
  return client;
}
