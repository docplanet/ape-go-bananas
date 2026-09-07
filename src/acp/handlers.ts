// Client-exposed methods the AGENT calls back into the client, beyond
// session/request_permission (docs/research/acp-protocol.md #11 -- the one
// *non*-gated baseline method every client must answer). That method is
// already fully implemented, and fully exercised by permissions.test.ts and
// cancellation.test.ts, inline in session.ts's connect()/
// AcpSessionImpl.handlePermissionRequest: it always awaits the injectable
// onPermissionRequest callback and uses whatever it returns (allow or deny
// alike) -- there is no code path that fabricates an "allow" outcome on its
// own. Re-implementing that here would only duplicate already-tested logic,
// and could not fully replicate it anyway: the cancel()-overrides-the-
// callback obligation (#14.1) needs the per-session `activeTurn`/
// `pendingPermissions` state that only AcpSessionImpl carries. See this
// file's tail comment for the two method families that genuinely belong here
// instead, and for why neither is wired into anything yet.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { ClientCapabilities, EnvVariable, SessionId } from './protocol.js';

// ---- shared param parsing ---------------------------------------------
//
// Every method below is reached only via untyped `unknown` params off the
// wire (see transport.ts's IncomingRequestHandler) -- these throw a plain,
// readable Error on a malformed call rather than trusting a cast. A caller
// wiring this into transport.respondError() is expected to map any throw
// here to -32602 "invalid params" (acp-protocol.md #15).

function asRecord(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null) throw new Error('invalid params: expected an object');
  return params as Record<string, unknown>;
}
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`invalid params: "${field}" must be a string`);
  return value;
}
function requireAbsolutePath(value: unknown, field: string): string {
  const path = requireString(value, field);
  if (!isAbsolute(path)) throw new Error(`invalid params: "${field}" must be an absolute path, got ${JSON.stringify(path)}`);
  return path;
}
function optionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number') throw new Error(`invalid params: "${field}" must be a number`);
  return value;
}
function parseStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`invalid params: "${field}" must be an array`);
  return value.map((entry, index) => requireString(entry, `${field}[${index}]`));
}
function parseEnvVariables(value: unknown, field: string): EnvVariable[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`invalid params: "${field}" must be an array`);
  return value.map((entry, index) => {
    const e = asRecord(entry);
    return { name: requireString(e.name, `${field}[${index}].name`), value: requireString(e.value, `${field}[${index}].value`) };
  });
}

// ---- fs/read_text_file, fs/write_text_file (#12) --------------------------
//
// #12's stated purpose for these two methods is letting the agent see/edit
// *unsaved editor buffer state*, not just disk contents -- a client built
// around a text editor would intercept an open buffer here before ever
// touching disk. This client has no such buffer model, so both fall back to
// real file I/O; that fallback is this file's own design choice, not
// something the spec doc itself prescribes for a bufferless client.

export interface ReadTextFileParams {
  sessionId: SessionId;
  path: string;
  line?: number | null;
  limit?: number | null;
}
export interface ReadTextFileResult {
  content: string;
}

function parseReadTextFileParams(params: unknown): ReadTextFileParams {
  const p = asRecord(params);
  return {
    sessionId: requireString(p.sessionId, 'sessionId'),
    path: requireAbsolutePath(p.path, 'path'),
    line: optionalNumber(p.line, 'line'),
    limit: optionalNumber(p.limit, 'limit'),
  };
}

/**
 * #12.1. `line`/`limit` are modeled on the prose doc's "1-based" reading
 * (the schema only states `Minimum: 0`, an unresolved discrepancy the spec
 * doc itself flags -- #12.1, #23 item 1): `line` is the first line to
 * return (1-based), `limit` the max number of lines from there.
 */
export async function readTextFile(rawParams: unknown): Promise<ReadTextFileResult> {
  const params = parseReadTextFileParams(rawParams);
  const raw = await readFile(params.path, 'utf8');
  if (params.line == null && params.limit == null) return { content: raw };

  const lines = raw.split('\n');
  const start = params.line != null ? Math.max(0, params.line - 1) : 0;
  const end = params.limit != null ? start + params.limit : lines.length;
  return { content: lines.slice(start, end).join('\n') };
}

export interface WriteTextFileParams {
  sessionId: SessionId;
  path: string;
  content: string;
}

function parseWriteTextFileParams(params: unknown): WriteTextFileParams {
  const p = asRecord(params);
  return {
    sessionId: requireString(p.sessionId, 'sessionId'),
    path: requireAbsolutePath(p.path, 'path'),
    content: requireString(p.content, 'content'),
  };
}

/**
 * #12.2. "The Client MUST create the file if it doesn't exist" -- read as
 * including any missing parent directories, since a from-scratch file's
 * directory won't exist yet either and the spec doesn't call that case out
 * separately. Returns `{}`, not `null`: #12.2 flags the schema as
 * object-typed (`WriteTextFileResponse`) despite the prose walkthrough's
 * `null` example, and `{}` satisfies both readings (#23 item 2's general
 * null/`{}` void-success equivalence).
 */
export async function writeTextFile(rawParams: unknown): Promise<Record<string, never>> {
  const params = parseWriteTextFileParams(rawParams);
  await mkdir(dirname(params.path), { recursive: true });
  await writeFile(params.path, params.content, 'utf8');
  return {};
}

// ---- terminal/* (#13) -----------------------------------------------------
//
// No PTY: every example in #13 is "run a command, stream its plain-text
// output back on request", not full terminal emulation -- a plain child
// process with stdout+stderr merged into one output string satisfies every
// field described. `env` merges *over* this process's own environment
// rather than replacing it, matching transport.ts's own SpawnAgentOptions.env
// convention (needed so `command` can even be found on PATH).

export interface CreateTerminalParams {
  sessionId: SessionId;
  command: string;
  args?: string[];
  env?: EnvVariable[];
  cwd?: string;
  outputByteLimit?: number | null;
}
export interface CreateTerminalResult {
  terminalId: string;
}
export interface TerminalExitStatus {
  exitCode: number | null;
  signal: string | null;
}
export interface TerminalOutputResult {
  output: string;
  truncated: boolean;
  exitStatus?: TerminalExitStatus | null;
}
/** #13.3: a bare `{exitCode, signal}` pair -- structurally distinct from `TerminalOutputResult.exitStatus`, even though field-identical, per that section's own callout. */
export type WaitForTerminalExitResult = TerminalExitStatus;

interface TrackedTerminal {
  child: ChildProcessWithoutNullStreams;
  output: string;
  truncated: boolean;
  outputByteLimit: number | null;
  exitStatus: TerminalExitStatus | null;
  exitWaiters: Array<(status: TerminalExitStatus) => void>;
}

function parseCreateTerminalParams(params: unknown): CreateTerminalParams {
  const p = asRecord(params);
  return {
    sessionId: requireString(p.sessionId, 'sessionId'),
    command: requireString(p.command, 'command'),
    args: parseStringArray(p.args, 'args'),
    env: parseEnvVariables(p.env, 'env'),
    cwd: p.cwd === undefined ? undefined : requireAbsolutePath(p.cwd, 'cwd'),
    outputByteLimit: optionalNumber(p.outputByteLimit, 'outputByteLimit'),
  };
}
function parseTerminalIdParams(params: unknown): { sessionId: SessionId; terminalId: string } {
  const p = asRecord(params);
  return { sessionId: requireString(p.sessionId, 'sessionId'), terminalId: requireString(p.terminalId, 'terminalId') };
}

/**
 * Front-truncates `text` to at most `byteLimit` UTF-8 bytes, per #13.1:
 * "truncated from the beginning... at a character boundary... even if this
 * means the retained output is slightly less than the specified limit."
 */
function truncateFront(text: string, byteLimit: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= byteLimit) return { text, truncated: false };
  let start = buf.length - byteLimit;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++; // back off a UTF-8 continuation byte
  return { text: buf.subarray(start).toString('utf8'), truncated: true };
}

const KILL_ESCALATION_MS = 2000;

/** One instance owns every terminal it creates, so two independent connections never share state. */
export interface TerminalHandlers {
  create(rawParams: unknown): Promise<CreateTerminalResult>;
  output(rawParams: unknown): Promise<TerminalOutputResult>;
  waitForExit(rawParams: unknown): Promise<WaitForTerminalExitResult>;
  kill(rawParams: unknown): Promise<Record<string, never>>;
  release(rawParams: unknown): Promise<Record<string, never>>;
  /** Kills every still-running terminal this instance created. Call once, when the connection this instance was made for closes. */
  releaseAll(): void;
}

export function createTerminalHandlers(): TerminalHandlers {
  const terminals = new Map<string, TrackedTerminal>();
  let nextId = 1;

  function getTracked(terminalId: string): TrackedTerminal {
    const tracked = terminals.get(terminalId);
    if (!tracked) throw new Error(`unknown terminalId: ${terminalId} (already released, or never created by this client)`);
    return tracked;
  }
  function appendOutput(tracked: TrackedTerminal, chunk: string): void {
    tracked.output += chunk;
    if (tracked.outputByteLimit == null) return;
    const result = truncateFront(tracked.output, tracked.outputByteLimit);
    tracked.output = result.text;
    if (result.truncated) tracked.truncated = true;
  }
  function settleExit(tracked: TrackedTerminal, status: TerminalExitStatus): void {
    if (tracked.exitStatus) return;
    tracked.exitStatus = status;
    const waiters = tracked.exitWaiters.splice(0);
    for (const waiter of waiters) waiter(status);
  }

  return {
    async create(rawParams) {
      const params = parseCreateTerminalParams(rawParams);
      const envOverrides: Record<string, string> = {};
      for (const entry of params.env ?? []) envOverrides[entry.name] = entry.value;

      const child = spawn(params.command, params.args ?? [], { cwd: params.cwd, env: { ...process.env, ...envOverrides } });
      const terminalId = `term_${nextId++}`;
      const tracked: TrackedTerminal = {
        child,
        output: '',
        truncated: false,
        outputByteLimit: params.outputByteLimit ?? null,
        exitStatus: null,
        exitWaiters: [],
      };
      terminals.set(terminalId, tracked);

      const onChunk = (chunk: Buffer): void => appendOutput(tracked, chunk.toString('utf8'));
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);
      child.on('exit', (code, signal) => settleExit(tracked, { exitCode: code, signal }));
      child.on('error', (err) => {
        // spawn failed outright (e.g. ENOENT) -- Node fires 'error' instead
        // of 'exit' in that case, so this is the only path that ever
        // settles this terminal; without it wait_for_exit would hang
        // forever on a command that never started.
        appendOutput(tracked, `\n[terminal: failed to start: ${err.message}]`);
        settleExit(tracked, { exitCode: null, signal: null });
      });

      return { terminalId };
    },

    async output(rawParams) {
      const { terminalId } = parseTerminalIdParams(rawParams);
      const tracked = getTracked(terminalId);
      return { output: tracked.output, truncated: tracked.truncated, exitStatus: tracked.exitStatus };
    },

    async waitForExit(rawParams) {
      const { terminalId } = parseTerminalIdParams(rawParams);
      const tracked = getTracked(terminalId);
      if (tracked.exitStatus) return tracked.exitStatus;
      return new Promise((resolve) => tracked.exitWaiters.push(resolve));
    },

    async kill(rawParams) {
      const { terminalId } = parseTerminalIdParams(rawParams);
      const tracked = getTracked(terminalId);
      // #13.4: "end the process, keep the terminal handle valid" -- output()
      // and waitForExit() must still work afterward, so the entry stays in
      // `terminals`; only release() below removes it.
      if (!tracked.exitStatus) {
        tracked.child.kill('SIGTERM');
        const timer = setTimeout(() => {
          if (!tracked.exitStatus) tracked.child.kill('SIGKILL');
        }, KILL_ESCALATION_MS);
        timer.unref?.();
      }
      return {};
    },

    async release(rawParams) {
      const { terminalId } = parseTerminalIdParams(rawParams);
      const tracked = getTracked(terminalId);
      if (!tracked.exitStatus) tracked.child.kill('SIGTERM');
      terminals.delete(terminalId);
      // #13.5: "the terminal ID becomes invalid for all other terminal/*
      // methods" -- removing it from the map is exactly that; getTracked()
      // above already throws a clear error for anything sent after this.
      return {};
    },

    releaseAll() {
      for (const tracked of terminals.values()) {
        if (!tracked.exitStatus) tracked.child.kill('SIGTERM');
      }
      terminals.clear();
    },
  };
}

// ---- combined dispatch table ----------------------------------------------
//
// Convenience surface for wiring every method above into a transport's
// onRequest callback in one place -- see this file's tail comment for why
// nothing in this repo does that yet.

const METHOD_NAMES = [
  'fs/read_text_file',
  'fs/write_text_file',
  'terminal/create',
  'terminal/output',
  'terminal/wait_for_exit',
  'terminal/kill',
  'terminal/release',
] as const;
export type ClientMethodName = (typeof METHOD_NAMES)[number];

export interface ClientMethodHandlers {
  supports(method: string): method is ClientMethodName;
  /** Throws on invalid params or an unrecognized method (check supports() first) -- a caller maps that to a JSON-RPC error response itself. */
  handle(method: ClientMethodName, params: unknown): Promise<unknown>;
  /** Ends every terminal this instance ever created. Call once, when the connection this instance was made for closes. */
  releaseAll(): void;
}

/**
 * The `ClientCapabilities` (acp-protocol.md #4.1) a caller would need to
 * advertise at `initialize` for every method this dispatch table answers to
 * be spec-legal for an agent to call (#12, #13). Exported so a future
 * integration has the exact shape to hand session.ts rather than
 * reconstructing it by re-reading the spec -- see this file's tail comment.
 */
export const FULL_CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
};

export function createClientMethodHandlers(): ClientMethodHandlers {
  const terminal = createTerminalHandlers();
  return {
    supports: (method): method is ClientMethodName => (METHOD_NAMES as readonly string[]).includes(method),
    handle(method, params) {
      switch (method) {
        case 'fs/read_text_file':
          return readTextFile(params);
        case 'fs/write_text_file':
          return writeTextFile(params);
        case 'terminal/create':
          return terminal.create(params);
        case 'terminal/output':
          return terminal.output(params);
        case 'terminal/wait_for_exit':
          return terminal.waitForExit(params);
        case 'terminal/kill':
          return terminal.kill(params);
        case 'terminal/release':
          return terminal.release(params);
        default: {
          const exhaustive: never = method;
          throw new Error(`unsupported method: ${String(exhaustive)}`);
        }
      }
    },
    releaseAll: () => terminal.releaseAll(),
  };
}

// ---- integration gap, reported rather than fixed --------------------------
//
// Nothing in this repo calls anything above yet. session.ts's connect()
// (a) hardcodes `clientCapabilities: { fs: { readTextFile: false,
// writeTextFile: false }, terminal: false }` in its own buildInitializeParams
// (never FULL_CLIENT_CAPABILITIES above), and (b) installs its own
// transport.onRequest callback that answers anything but
// session/request_permission with a flat -32601, with no extension point for
// a caller-supplied method table -- ConnectOptions has no field for one.
// Per #12/#13's own text ("the Agent MUST NOT attempt to call" a method
// whose capability wasn't advertised), that -32601 fallback is spec-legal
// as it stands, not a bug; none of this repo's five oracle suites send
// fs/*/terminal/* either way (test/acp/mock-agent.ts's handleRequest() only
// ever answers initialize/session.new/session.prompt), so this gap is
// invisible to `npm test`. Wiring this module in for real needs two changes
// only session.ts's owner can make: advertise FULL_CLIENT_CAPABILITIES (or a
// caller-chosen subset of it) instead of the hardcoded all-false literal,
// and route fs/*/terminal/* through createClientMethodHandlers() instead of
// the flat fallback. Reported, not fixed, per this task's own
// file-ownership boundary: implementing it means editing session.ts.
//
// Follow-up (post-review): a later pass across this whole module did have
// license to edit session.ts, and deliberately still chose not to wire this
// in -- doing so would add an untested integration (this client's oracle
// has no fs/*/terminal/* coverage at all) to the tested connect() path for
// no caller who has asked for it yet. index.ts no longer re-exports
// anything from this file for the same reason: nothing on the *public*
// surface should look covered by the green suite when it isn't. This file
// itself is untouched and still compiles/typechecks as part of the normal
// `src/**/*.ts` build (see tsconfig.json's `include`); import directly from
// './handlers.js' if a caller needs it before the real integration lands.
