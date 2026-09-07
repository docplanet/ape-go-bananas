// Plumbing shared by test/sidecar/agent-openrouter*.test.ts, on top of
// helpers.ts. Written from docs/research/agent-protocol.md §2-§4 and
// acp-protocol.md #8/#10/#11 by a context that has not seen src/agent/ or
// src/sidecar/agent*. Adds what helpers.ts lacks: answering the sidecar's
// reverse `agent/requestPermission` requests (§3), collecting `agent/update`
// notifications for one turn, and the API-key hygiene sweep (§5 last bullet).
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { type FakeOpenRouter, GOOD_KEY } from './fake-openrouter.ts';
import { TIMEOUT, isJsonRpcLine, makeTmpDir, spawnSidecar, withTimeout, type RpcMessage, type Sidecar } from './helpers.ts';

export { GOOD_KEY };

// ---- shapes asserted at the stdio boundary -------------------------------

export interface SelectOption {
  id: string;
  type: 'select';
  name: string;
  currentValue: string;
  options: Array<{ value: string; name: string }>;
}
export interface ModeState {
  currentModeId: string;
  availableModes: Array<{ id: string; name: string; description: string }>;
}
export interface ConnectResult {
  connectionId: string;
  provider: string;
  kind: string;
  agent: unknown;
  authStatus: unknown;
  authMethods: unknown[];
  session: null | { sessionId: string; modes: ModeState | null; configOptions: SelectOption[] | null; commands: unknown[] };
  authRequired: boolean;
}
export interface ToolCallContentText {
  type: 'content';
  content: { type: 'text'; text: string };
}
/** Any `update` payload of an `agent/update` notification; fields beyond the discriminator are read by the tests as needed. */
export interface Update {
  sessionUpdate: string;
  content?: { type: string; text?: string } | ToolCallContentText[];
  toolCallId?: string;
  title?: string | null;
  kind?: string;
  status?: string;
  used?: number;
  size?: number;
  _meta?: Record<string, unknown>;
  currentModeId?: string;
  modeId?: string;
  configOptions?: SelectOption[];
  [k: string]: unknown;
}
export interface PermissionRequest {
  id: number | string;
  params: {
    sessionId: string;
    toolCall: { toolCallId: string; title?: string | null; kind?: string; status?: string; [k: string]: unknown };
    options: Array<{ optionId: string; name: string; kind: string }>;
  };
}
export type Outcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
/** What a test's answer callback may return: an outcome, or an error object to answer with a JSON-RPC error (§3: "An `error` response ... denies"). */
export type Answer = Outcome | { error: { code: number; message: string } };

// ---- spawning ----------------------------------------------------------------

/** Every sidecar spawned through this module, for the end-of-file hygiene sweep. */
export const spawned: Sidecar[] = [];

/**
 * helpers.ts's spawnSidecar copies process.env at call time and takes no env
 * option, so the base-URL override (agent-protocol §2: env
 * APE_OPENROUTER_BASE_URL) is set on this test process before spawning.
 * node --test runs each file in its own process, so nothing leaks between files.
 */
export function spawnOpenRouterSidecar(fake: FakeOpenRouter, cwd?: string): Sidecar {
  process.env.APE_OPENROUTER_BASE_URL = fake.baseUrl;
  const s = spawnSidecar({ cwd });
  spawned.push(s);
  return s;
}

/** A fresh course folder (`cwd`) and data dir for one session. */
export function makeSessionDirs(): { cwd: string; dataDir: string } {
  const root = makeTmpDir('ape-openrouter-');
  const cwd = join(root, 'course');
  const dataDir = join(root, 'data');
  mkdirSync(cwd);
  mkdirSync(dataDir);
  return { cwd, dataDir };
}

let nextId = 1000;
export const freshId = (): number => ++nextId;

export interface Connected {
  s: Sidecar;
  fake: FakeOpenRouter;
  cwd: string;
  dataDir: string;
  connectionId: string;
  sessionId: string;
  result: ConnectResult;
}

/** Spawns a sidecar, connects to `openrouter` with the good key, returns the session. */
export async function connectGood(fake: FakeOpenRouter, dirs = makeSessionDirs()): Promise<Connected> {
  const s = spawnOpenRouterSidecar(fake, dirs.cwd);
  await s.ready;
  const res = await s.request(freshId(), 'agent/connect', { provider: 'openrouter', dataDir: dirs.dataDir, cwd: dirs.cwd, apiKey: GOOD_KEY });
  assert.ok(!res.error, `agent/connect failed: ${JSON.stringify(res.error)}`);
  const result = res.result as ConnectResult;
  assert.ok(result.session, 'agent/connect returned session: null for an api provider');
  return { s, fake, cwd: dirs.cwd, dataDir: dirs.dataDir, connectionId: result.connectionId, sessionId: result.session.sessionId, result };
}

export function expectError(res: RpcMessage, code: number, label: string): { message: string; data?: unknown } {
  assert.ok(res.error, `${label}: expected an error response, got ${JSON.stringify(res)}`);
  assert.ok(!('result' in res), `${label}: an error response carries no result`);
  assert.equal(res.error.code, code, `${label}: got ${res.error.code} ${JSON.stringify(res.error.message)}`);
  assert.ok(res.error.message.length > 0, `${label}: message must be human-readable`);
  return res.error;
}

// ---- reading the update stream -------------------------------------------

/** The `agent/update` payloads for `sessionId` among stdout lines [from, to). */
export function updatesOf(s: Sidecar, sessionId: string, from = 0, to = s.lines.length): Update[] {
  const out: Update[] = [];
  for (const line of s.lines.slice(from, to)) {
    const m = line.json;
    if (!m || m.method !== 'agent/update' || 'id' in m) continue;
    const p = m.params as { sessionId: string; update: Update };
    assert.ok(p && typeof p.update === 'object' && typeof p.update.sessionUpdate === 'string', `agent/update params shape: ${line.raw}`);
    if (p.sessionId === sessionId) out.push(p.update);
  }
  return out;
}

export const ofKind = (updates: Update[], kind: string): Update[] => updates.filter((u) => u.sessionUpdate === kind);

/** Concatenated `content.text` of every chunk update of `kind` (agent_message_chunk / agent_thought_chunk). */
export function chunkText(updates: Update[], kind: string): string {
  return ofKind(updates, kind)
    .map((u) => {
      const c = u.content as { type: string; text?: string } | undefined;
      assert.equal(c?.type, 'text', `${kind} content is a text block`);
      return c?.text ?? '';
    })
    .join('');
}

/** The text of a `tool_call_update`'s single `{type:"content", content:{type:"text"}}` entry (agent-protocol §4). */
export function toolResultText(u: Update): string {
  const content = u.content as ToolCallContentText[] | undefined;
  assert.ok(Array.isArray(content) && content.length >= 1, `tool_call_update carries content: ${JSON.stringify(u)}`);
  const first = content[0];
  assert.equal(first.type, 'content');
  assert.equal(first.content.type, 'text');
  return first.content.text;
}

/** A message `content` as text, whether it is a string or a parts array (openrouter-api §2.2 allows both). */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p && p.type === 'text').map((p) => String(p.text)).join('');
  return '';
}

/** Polls `s.lines` until `pred` holds. */
export function waitFor<T>(fn: () => T | undefined, label: string, ms = TIMEOUT): Promise<T> {
  return withTimeout(new Promise<T>((resolve) => {
    const tick = () => {
      const v = fn();
      if (v !== undefined) resolve(v);
      else setTimeout(tick, 15);
    };
    tick();
  }), label, ms);
}

// ---- running one turn --------------------------------------------------------

export interface PromptRun {
  response: RpcMessage;
  updates: Update[];
  permissionRequests: PermissionRequest[];
}

/**
 * Sends `agent/prompt`, answers every reverse `agent/requestPermission`
 * request that arrives meanwhile with `answer(req)` (default: `cancelled`,
 * which §3 says denies -- so a test that expected no request still sees the
 * turn end and can assert `permissionRequests.length === 0`), and resolves
 * with the response plus the session's updates emitted before it.
 */
export async function runPrompt(
  s: Sidecar,
  sessionId: string,
  blocks: unknown[],
  opts: { answer?: (req: PermissionRequest) => Answer | Promise<Answer>; id?: number; timeout?: number } = {},
): Promise<PromptRun> {
  const permissionRequests: PermissionRequest[] = [];
  const start = s.lines.length;
  let cursor = start;
  const onData = () => {
    for (; cursor < s.lines.length; cursor++) {
      const m = s.lines[cursor].json;
      if (!m || m.method !== 'agent/requestPermission' || m.id === undefined || m.id === null) continue;
      const req = { id: m.id, params: m.params as PermissionRequest['params'] } as PermissionRequest;
      permissionRequests.push(req);
      Promise.resolve(opts.answer ? opts.answer(req) : ({ outcome: 'cancelled' } as Answer)).then((a) => {
        const reply = 'error' in a ? { jsonrpc: '2.0', id: req.id, error: a.error } : { jsonrpc: '2.0', id: req.id, result: { outcome: a } };
        return s.writeRaw(`${JSON.stringify(reply)}\n`);
      }).catch(() => undefined);
    }
  };
  const stdout = s.child.stdout;
  assert.ok(stdout, 'the sidecar was spawned with a piped stdout');
  stdout.on('data', onData);
  try {
    const id = opts.id ?? freshId();
    const response = await withTimeout(s.request(id, 'agent/prompt', { sessionId, blocks }), 'agent/prompt', opts.timeout ?? TIMEOUT);
    onData();
    const end = s.lines.findIndex((l, i) => i >= start && l.json?.id === id);
    return { response, updates: updatesOf(s, sessionId, start, end === -1 ? undefined : end), permissionRequests };
  } finally {
    stdout.off('data', onData);
  }
}

/** A `text` prompt block. */
export const text = (t: string) => ({ type: 'text', text: t });
/** The caller-supplied system prompt block (agent-protocol §4): a leading `resource` with uri `ape://system`. */
export const systemBlock = (t: string) => ({ type: 'resource', resource: { uri: 'ape://system', mimeType: 'text/plain', text: t } });

/** Asserts a prompt turn ended cleanly with the given stop reason. */
export function expectStop(run: PromptRun, stopReason: string): void {
  assert.ok(!run.response.error, `agent/prompt errored: ${JSON.stringify(run.response.error)}`);
  assert.deepEqual(run.response.result, { stopReason });
}

// ---- hygiene ---------------------------------------------------------------------

/**
 * agent-protocol §2 ("apiKey ... never logged, never written") and §5's last
 * bullet: no stdout line and no stderr byte of any sidecar this file spawned
 * contains the key; and every stdout line is a JSON-RPC message
 * (sidecar-protocol §1). Register with `after(...)` in each test file, after
 * `sweepSidecars`.
 */
export function assertKeyHygiene(): void {
  let lines = 0;
  for (const s of spawned) {
    for (const line of s.lines) {
      lines++;
      assert.ok(!line.raw.includes(GOOD_KEY), `API key leaked on stdout: ${line.raw}`);
      assert.ok(isJsonRpcLine(line), `stdout line is not one JSON-RPC message: ${line.raw}`);
    }
    assert.ok(!s.stderr().includes(GOOD_KEY), `API key leaked on stderr: ${s.stderr()}`);
  }
  assert.ok(lines > 0, 'the hygiene sweep saw no stdout at all -- were sidecars spawned through spawnOpenRouterSidecar?');
}
