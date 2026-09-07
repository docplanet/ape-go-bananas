// The `clientCapabilities.auth.terminal` advertisement from
// docs/research/claude-adapter-auth.md §6, exercised against
// auth-terminal-agent.ts -- a fake that answers initialize the way the
// Claude adapter does (§2): the two terminal-type methods with their
// `_meta["terminal-auth"]` blocks ONLY when the client advertised
// `auth.terminal: true`, and `authMethods: []` otherwise.
//
// Written from §6 and §2, not from the implementation. Mutation-checked:
// with the `auth` line in buildInitializeParams() removed, the five
// capability-dependent cases fail (no auth key on the wire, zero methods,
// "did not advertise" instead of the #5.3 wording) and the default, empty,
// frozen and close cases still pass.
//
// APPROACH: a self-contained fake agent rather than a new mock scenario.
// mock-agent.ts imports its scenario names from './scenarios.ts' by fixed
// path and its handleInitialize() never reads the request's
// clientCapabilities, so making its reply depend on what the client sent
// would mean editing existing files, which this task forbids. See the
// header of auth-terminal-agent.ts.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect } from '../../dist/acp/index.js';
import type { AcpClient, AuthMethod, ConnectOptions, TerminalAuthMethod } from '../../dist/acp/index.js';

import {
  closeAndAssertExit,
  makeTmpDir,
  pidIsAlive,
  sweepLeaks,
  trackPidFile,
  withTimeout,
} from './helpers.ts';

const TIMEOUT = 5000;

after(sweepLeaks);

const AGENT_PATH = fileURLToPath(new URL('./auth-terminal-agent.ts', import.meta.url));
const AGENT_ARGS = [AGENT_PATH, '--claude-adapter'];

/** What the spec says this client sends today, and must keep sending when the option is omitted (§6 "Default unchanged"). */
const DEFAULT_CAPS = { fs: { readTextFile: false, writeTextFile: false }, terminal: false };

/** The exact wire shapes from claude-adapter-auth.md §2, spelled out here independently of the agent file. */
const CLAUDE_AI_LOGIN_ARGS = ['--cli', 'auth', 'login', '--claudeai'];
const CONSOLE_LOGIN_ARGS = ['--cli', 'auth', 'login', '--console'];

interface LoggedLine {
  dir: 'send' | 'recv';
  raw: string;
  t: number;
}

function readLog(logFile: string, dir: 'send' | 'recv'): Array<Record<string, unknown>> {
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LoggedLine)
    .filter((entry) => entry.dir === dir)
    .map((entry) => JSON.parse(entry.raw) as Record<string, unknown>);
}

/** The messages the CLIENT sent, in order -- same direction filter lifecycle.test.ts documents. */
function clientSent(logFile: string): Array<{ method?: string; params?: Record<string, unknown> }> {
  return readLog(logFile, 'recv') as Array<{ method?: string; params?: Record<string, unknown> }>;
}

/** The `initialize` request's clientCapabilities exactly as they hit the wire. */
function sentClientCapabilities(logFile: string): unknown {
  const [initReq] = clientSent(logFile);
  assert.equal(initReq.method, 'initialize', 'the first frame on the wire must be initialize (#4)');
  return initReq.params?.clientCapabilities;
}

/** The `authMethods` array the AGENT put in its initialize response, read back from the log. */
function agentSentAuthMethods(logFile: string): unknown[] {
  const [initRes] = readLog(logFile, 'send');
  const result = initRes.result as { authMethods?: unknown[] } | undefined;
  assert.ok(result, 'the first frame the agent sent must be the initialize response');
  return result.authMethods ?? [];
}

function neverApprove(): never {
  throw new Error('this agent never asks for permission');
}

interface Connected {
  client: AcpClient;
  logFile: string;
  pidFile: string;
  cwd: string;
  env: Record<string, string>;
}

type ClientCapabilitiesOption = { auth?: { terminal?: boolean } };

/**
 * Spawns auth-terminal-agent.ts. `caps` is passed as `clientCapabilities`
 * only when given, so the omitted-option default (§6) is genuinely omitted
 * and not sent as `undefined`.
 */
async function connectClaudeLike(caps?: ClientCapabilitiesOption): Promise<Connected> {
  const dir = makeTmpDir('acp-auth-terminal-');
  const logFile = path.join(dir, 'mock.log');
  const pidFile = path.join(dir, 'agent.pid');
  const cwd = process.cwd();
  const env = { ACP_MOCK_LOG: logFile, ACP_TEST_PIDFILE: pidFile };
  const options: ConnectOptions = {
    command: process.execPath,
    args: AGENT_ARGS,
    env,
    cwd,
    onPermissionRequest: neverApprove,
    ...(caps === undefined ? {} : { clientCapabilities: caps }),
  };
  const client = await withTimeout(connect(options), TIMEOUT, 'connect');
  trackPidFile(pidFile);
  return { client, logFile, pidFile, cwd, env };
}

function isTerminal(m: AuthMethod): m is TerminalAuthMethod {
  return m.type === 'terminal';
}

// ---- §6: what initialize carries ----------------------------------------

test('connect() with no clientCapabilities option sends exactly the default capabilities and no auth key', { timeout: TIMEOUT }, async () => {
  const { client, logFile, pidFile } = await connectClaudeLike();

  const caps = sentClientCapabilities(logFile);
  assert.deepEqual(
    caps,
    DEFAULT_CAPS,
    '§6 "Default unchanged": with the option omitted, initialize carries exactly what it carries today, with NO auth key',
  );
  assert.ok(!('auth' in (caps as object)), 'no `auth` key at all when the option is omitted -- not even auth: undefined');

  await closeAndAssertExit(client, pidFile);
});

test('connect() with { auth: { terminal: true } } advertises it, while fs and terminal stay false', { timeout: TIMEOUT }, async () => {
  const { client, logFile, pidFile } = await connectClaudeLike({ auth: { terminal: true } });

  const caps = sentClientCapabilities(logFile);
  assert.deepEqual(
    caps,
    { ...DEFAULT_CAPS, auth: { terminal: true } },
    '§6: the wire shape is { fs: {…false…}, terminal: false, auth: { terminal: true } }',
  );
  const typed = caps as { fs: { readTextFile: boolean; writeTextFile: boolean }; terminal: boolean };
  assert.equal(typed.terminal, false, '§6: the option cannot turn on terminal/* -- this client still implements none of it');
  assert.equal(typed.fs.readTextFile, false, '§6: the option cannot turn on fs/read_text_file');
  assert.equal(typed.fs.writeTextFile, false, '§6: the option cannot turn on fs/write_text_file');

  await closeAndAssertExit(client, pidFile);
});

test('connect() with { auth: { terminal: false } } sends auth: { terminal: false } explicitly', { timeout: TIMEOUT }, async () => {
  const { client, logFile, pidFile } = await connectClaudeLike({ auth: { terminal: false } });

  assert.deepEqual(
    sentClientCapabilities(logFile),
    { ...DEFAULT_CAPS, auth: { terminal: false } },
    '§6: an explicit false is sent as an explicit false, not dropped',
  );

  await closeAndAssertExit(client, pidFile);
});

// ---- §2: what the adapter offers in return ------------------------------

test('when advertised, authMethods carries the two Claude terminal methods in order with args and _meta preserved', { timeout: TIMEOUT }, async () => {
  const { client, logFile, pidFile } = await connectClaudeLike({ auth: { terminal: true } });

  assert.equal(client.authMethods.length, 2, '§2: two terminal methods when auth.terminal was advertised');
  const [first, second] = client.authMethods;

  assert.equal(first.id, 'claude-ai-login');
  assert.equal(second.id, 'console-login');
  assert.ok(isTerminal(first), 'claude-ai-login is type: "terminal"');
  assert.ok(isTerminal(second), 'console-login is type: "terminal"');
  assert.equal(first.name, 'Claude Subscription');
  assert.equal(second.name, 'Anthropic Console');
  assert.deepEqual(first.args, CLAUDE_AI_LOGIN_ARGS, '§2: args exactly as the adapter sends them');
  assert.deepEqual(second.args, CONSOLE_LOGIN_ARGS, '§2: args exactly as the adapter sends them');

  // §6: `_meta` is passed through untouched -- deep-equal against what the
  // agent actually wrote to the wire, read back from its own log, so this
  // does not depend on the test and the agent agreeing on a constant.
  const sent = agentSentAuthMethods(logFile) as Array<{ _meta?: Record<string, unknown> }>;
  assert.equal(sent.length, 2, 'sanity: the agent advertised two methods');
  for (const [i, method] of [first, second].entries()) {
    const meta = method._meta as { 'terminal-auth'?: { command?: unknown; args?: unknown; label?: unknown } } | undefined;
    assert.ok(meta, `${method.id}: _meta must be preserved from the wire (§6), not stripped by validation`);
    assert.equal(typeof meta['terminal-auth'], 'object', `${method.id}: _meta["terminal-auth"] is an object`);
    assert.equal(typeof meta['terminal-auth']?.command, 'string', `${method.id}: _meta["terminal-auth"].command`);
    assert.ok(Array.isArray(meta['terminal-auth']?.args), `${method.id}: _meta["terminal-auth"].args`);
    assert.equal(typeof meta['terminal-auth']?.label, 'string', `${method.id}: _meta["terminal-auth"].label`);
    assert.deepEqual(method._meta, sent[i]._meta, `${method.id}: _meta deep-equals what the agent sent`);
  }

  await closeAndAssertExit(client, pidFile);
});

test('when not advertised, authMethods is empty', { timeout: TIMEOUT }, async () => {
  const { client, logFile, pidFile } = await connectClaudeLike();

  assert.deepEqual(agentSentAuthMethods(logFile), [], 'sanity: the agent offered nothing to a client that did not advertise');
  assert.deepEqual(client.authMethods, [], '§2: authMethods is [] unless the client advertises auth.terminal');

  await closeAndAssertExit(client, pidFile);
});

// ---- §6 / #5.3: the launch line ignores _meta ---------------------------

test('terminalAuthLaunch("claude-ai-login") derives from the connection, not from _meta["terminal-auth"]', { timeout: TIMEOUT }, async () => {
  const { client, pidFile, cwd, env } = await connectClaudeLike({ auth: { terminal: true } });

  const launch = client.terminalAuthLaunch('claude-ai-login');

  assert.equal(launch.command, process.execPath, '#5.3: the command is the connection\'s own command');
  assert.deepEqual(launch.args, [...AGENT_ARGS, ...CLAUDE_AI_LOGIN_ARGS], '#5.3 step 2: the method\'s args are appended to the connection\'s args');
  assert.equal(launch.cwd, cwd, '#5.3 step 1: cwd is part of the base launch configuration');
  for (const [k, v] of Object.entries(env)) {
    assert.equal(launch.env[k], v, `connect()'s env entry ${k} is carried through`);
  }

  // §6: "A method that also carries _meta["terminal-auth"] ... is NOT consulted"
  const method = client.authMethods.find((m) => m.id === 'claude-ai-login');
  assert.ok(method);
  const metaLaunch = (method._meta as { 'terminal-auth': { command: string; args: string[] } })['terminal-auth'];
  assert.notDeepEqual(launch.args, metaLaunch.args, 'the returned args must not be the adapter\'s _meta args');
  assert.notEqual(launch.command, metaLaunch.command, 'the returned command must not be the adapter\'s _meta command');

  await closeAndAssertExit(client, pidFile);
});

// ---- #5.3: the prohibition holds for the Claude methods ------------------

test('authenticate("claude-ai-login") is refused locally as a terminal method and never reaches the wire', { timeout: TIMEOUT }, async () => {
  const { client, logFile, pidFile } = await connectClaudeLike({ auth: { terminal: true } });

  await assert.rejects(
    client.authenticate('claude-ai-login'),
    // Anchored on the client's own #5.3 wording (as authenticate.test.ts
    // does), not merely on "rejects": today the method is simply not
    // advertised, and that rejection must not be mistaken for this one.
    /MUST NOT send an authenticate request/,
    '#5.3: "the Client MUST NOT send an authenticate request for a terminal method"',
  );
  assert.equal(
    clientSent(logFile).filter((m) => m.method === 'authenticate').length,
    0,
    'no authenticate frame may be emitted for a terminal-type method',
  );

  await closeAndAssertExit(client, pidFile);
});

// ---- immutability and teardown ------------------------------------------

test('authMethods is frozen: it cannot be pushed to or reassigned', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectClaudeLike({ auth: { terminal: true } });

  const before = client.authMethods.length;
  assert.ok(Object.isFrozen(client.authMethods), 'authMethods must be a frozen array');

  assert.throws(
    () => (client.authMethods as AuthMethod[]).push({ id: 'injected', name: 'Injected' }),
    TypeError,
    'pushing onto a frozen array throws in strict-mode module code',
  );
  assert.equal(client.authMethods.length, before, 'the push must not have taken');

  try {
    (client.authMethods as AuthMethod[])[0] = { id: 'replaced', name: 'Replaced' };
  } catch {
    // throwing is a pass; silently ignoring is checked below
  }
  assert.notEqual(client.authMethods[0]?.id, 'replaced', 'index assignment must not take on a frozen array');

  await closeAndAssertExit(client, pidFile);
});

test('close() reaps the agent process', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectClaudeLike({ auth: { terminal: true } });

  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(pidIsAlive(pid), 'sanity: the agent is alive while the client is open');

  // closeAndAssertExit polls for the process to be gone after close() resolves,
  // exactly as lifecycle.test.ts asserts it.
  await closeAndAssertExit(client, pidFile);
  assert.ok(!pidIsAlive(pid), 'the agent must be gone after close()');
});
