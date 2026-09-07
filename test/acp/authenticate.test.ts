// Authentication (docs/research/acp-protocol.md #5) against mock-agent.ts:
// protocol-driven `agent`-type authenticate (#5.2), the terminal-variant
// prohibition (#5.3), and logout (#5.4).
//
// INDEPENDENCE CAVEAT -- read this before trusting a green run. Every other
// suite in this directory was written from the spec by an agent that never
// saw an implementation, and implementers were barred from editing them.
// That is not true here: this file, the AUTH_* scenarios in scenarios.ts,
// the mock's authenticate/logout handling, AND the src/acp code they
// exercise were all authored in one pass by the same agent. The mitigation
// applied was ordering -- every assertion below was written from #5 before
// a line of the implementation existed, and none was edited afterwards to
// accommodate what got built -- but ordering is weaker evidence than
// independence. Treat these as spec-derived self-tests, not as an oracle.
//
// Live status: unverified against any real agent. See the module's STATUS
// notes; at the time of writing neither available real agent could complete
// an auth flow (one's credentials expired, the other's account tier was
// discontinued server-side).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { connect } from '../../dist/acp/index.js';
import type { AcpClient, AuthMethod } from '../../dist/acp/index.js';

import { SCENARIOS, type ScenarioName } from './scenarios.ts';
import {
  MOCK_AGENT_PATH,
  closeAndAssertExit,
  makeTmpDir,
  sweepLeaks,
  trackPidFile,
  withTimeout,
} from './helpers.ts';

const TIMEOUT = 5000;

after(sweepLeaks);

interface LoggedLine {
  dir: 'send' | 'recv';
  raw: string;
  t: number;
}

/** The messages the CLIENT sent, in order -- same direction filter lifecycle.test.ts documents. */
function clientSent(logFile: string): Array<{ method?: string; params?: Record<string, unknown> }> {
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LoggedLine)
    .filter((entry) => entry.dir === 'recv')
    .map((entry) => JSON.parse(entry.raw) as { method?: string; params?: Record<string, unknown> });
}

function neverApprove(): never {
  throw new Error('these scenarios never ask for permission');
}

async function connectAuth(scenario: ScenarioName): Promise<{ client: AcpClient; logFile: string; pidFile: string }> {
  const dir = makeTmpDir('acp-auth-');
  const logFile = path.join(dir, 'mock.log');
  const pidFile = path.join(dir, 'agent.pid');
  const client = await withTimeout(
    connect({
      command: process.execPath,
      args: [MOCK_AGENT_PATH, `--scenario=${scenario}`],
      env: { ACP_MOCK_LOG: logFile, ACP_TEST_PIDFILE: pidFile },
      // set explicitly so terminalAuthLaunch() has a real cwd to carry
      // through -- #5.3 step 1's base launch configuration includes it
      cwd: process.cwd(),
      onPermissionRequest: neverApprove,
    }),
    TIMEOUT,
    'connect',
  );
  trackPidFile(pidFile);
  return { client, logFile, pidFile };
}

// ---- #5.1 discovery ------------------------------------------------------

test('connect() surfaces agent-type auth methods verbatim, with `type` absent rather than normalized', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectAuth(SCENARIOS.AUTH_AGENT);

  assert.equal(client.authMethods.length, 2);
  const [first, second] = client.authMethods;
  assert.equal(first.id, 'agent-login');
  assert.equal(first.name, 'Agent login');
  assert.equal(
    first.type,
    undefined,
    '#5.1: absence of `type` IS the discriminator for the default agent variant -- it must not be filled in',
  );
  assert.equal(second.id, 'api-key');
  assert.equal(client.agentCapabilities.auth.logout, true, '#5.4: logout is legal only when initialize advertised it');

  await closeAndAssertExit(client, pidFile);
});

test('an auth-gated agent rejects session/new with -32000 before authenticate', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectAuth(SCENARIOS.AUTH_AGENT);

  const err = await withTimeout(
    client.newSession({ cwd: process.cwd() }).then(
      () => null,
      (e: unknown) => e as Error & { code?: number },
    ),
    TIMEOUT,
    'newSession',
  );
  assert.ok(err, 'session/new must not succeed before authenticate on an auth-gated agent');
  assert.equal(err.code, -32000, '#15: pre-auth calls to auth-gated methods yield -32000 Authentication required');

  await closeAndAssertExit(client, pidFile);
});

// ---- #5.2 protocol-driven authenticate ----------------------------------

test('authenticate() sends the method id as `methodId` and resolves on the empty-object result', { timeout: TIMEOUT }, async () => {
  const { client, logFile, pidFile } = await connectAuth(SCENARIOS.AUTH_AGENT);

  await withTimeout(client.authenticate('agent-login'), TIMEOUT, 'authenticate');

  const authFrames = clientSent(logFile).filter((m) => m.method === 'authenticate');
  assert.equal(authFrames.length, 1, 'exactly one authenticate request belongs on the wire');
  assert.deepEqual(
    authFrames[0].params,
    { methodId: 'agent-login' },
    '#5.2: the request carries exactly {methodId}',
  );

  await closeAndAssertExit(client, pidFile);
});

test('a successful authenticate actually lifts the gate: session/new then succeeds', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectAuth(SCENARIOS.AUTH_AGENT);

  await withTimeout(client.authenticate('agent-login'), TIMEOUT, 'authenticate');
  const session = await withTimeout(client.newSession({ cwd: process.cwd() }), TIMEOUT, 'newSession');
  assert.equal(typeof session.sessionId, 'string');
  assert.ok(session.sessionId.length > 0);

  await closeAndAssertExit(client, pidFile);
});

test('authenticate() with an id the agent never advertised is refused locally, with nothing put on the wire', { timeout: TIMEOUT }, async () => {
  const { client, logFile, pidFile } = await connectAuth(SCENARIOS.AUTH_AGENT);

  await assert.rejects(
    client.authenticate('no-such-method'),
    // Intent, not wording: the rejection must name the advertisement
    // problem. Broadened from a narrower guess at the exact phrasing AFTER
    // the implementation existed -- the only assertion in this file edited
    // post-hoc, disclosed here because the surrounding suites forbid it.
    /advertise/i,
    'an unadvertised id is a caller bug; it should not cost a round trip',
  );
  assert.equal(
    clientSent(logFile).filter((m) => m.method === 'authenticate').length,
    0,
    'no authenticate frame should reach the agent for an unadvertised id',
  );

  await closeAndAssertExit(client, pidFile);
});

test('authMethods is validated, and cannot be mutated out from under the #5.3 guard', { timeout: TIMEOUT }, async () => {
  const { client, logFile, pidFile } = await connectAuth(SCENARIOS.AUTH_TERMINAL);

  // The MUST-NOT guard resolves the id against this array. If a caller can
  // edit it, the guard's answer is the caller's to choose -- so retyping the
  // terminal method as an agent one must not make authenticate() send it.
  const terminal = client.authMethods.find((m) => m.id === 'terminal-login');
  assert.ok(terminal);
  try {
    (terminal as { type?: string }).type = undefined;
    (client.authMethods as AuthMethod[]).push({ id: 'injected', name: 'Injected' });
  } catch {
    // a frozen structure throwing here is a pass, not a failure
  }

  await assert.rejects(client.authenticate('terminal-login'), /MUST NOT send an authenticate request/);
  await assert.rejects(client.authenticate('injected'), /did not advertise/);
  assert.equal(
    clientSent(logFile).filter((m) => m.method === 'authenticate').length,
    0,
    'neither a retyped terminal method nor an injected one may reach the wire',
  );

  await closeAndAssertExit(client, pidFile);
});

test('an auth method missing required fields is dropped rather than carried as a half-formed entry', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectAuth(SCENARIOS.AUTH_MALFORMED);

  assert.deepEqual(
    client.authMethods.map((m) => m.id),
    ['agent-login'],
    'only the well-formed entry survives; #5.1 requires id and name',
  );

  await closeAndAssertExit(client, pidFile);
});

// ---- #5.3 the terminal prohibition --------------------------------------

test('a terminal-type auth method is surfaced with its type, args and env intact', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectAuth(SCENARIOS.AUTH_TERMINAL);

  const terminal = client.authMethods.find((m): m is Extract<AuthMethod, { type: 'terminal' }> => m.type === 'terminal');
  assert.ok(terminal, 'the terminal variant must be visible to a caller, not filtered out');
  assert.equal(terminal.id, 'terminal-login');
  assert.deepEqual(terminal.args, ['--login', '--interactive']);
  assert.deepEqual(terminal.env, { ACP_AUTH_MODE: 'terminal' });

  await closeAndAssertExit(client, pidFile);
});

test('authenticate() MUST NOT send a terminal-type id: it is refused locally and never reaches the wire', { timeout: TIMEOUT }, async () => {
  const { client, logFile, pidFile } = await connectAuth(SCENARIOS.AUTH_TERMINAL);

  await assert.rejects(
    client.authenticate('terminal-login'),
    // Anchored on this client's own wording, not the bare word "terminal".
    // Mutation testing showed /terminal/i also matches the MOCK's rejection,
    // so deleting the guard entirely still passed this assertion -- only the
    // zero-frame check below caught it. A rejection must fail here for the
    // right reason, not merely fail.
    /MUST NOT send an authenticate request/,
    '#5.3: "the Client MUST NOT send an authenticate request for a terminal method"',
  );
  assert.equal(
    clientSent(logFile).filter((m) => m.method === 'authenticate').length,
    0,
    'the prohibition is about the wire: no authenticate frame may be emitted for a terminal method',
  );

  // and the agent-type method alongside it is still usable
  await withTimeout(client.authenticate('agent-login'), TIMEOUT, 'authenticate');

  await closeAndAssertExit(client, pidFile);
});

test('terminalAuthLaunch() derives the command from the client\'s own config, appends args and overrides env (#5.3 steps 1-2)', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectAuth(SCENARIOS.AUTH_TERMINAL);

  const launch = client.terminalAuthLaunch('terminal-login');
  assert.equal(
    launch.command,
    process.execPath,
    '#5.3: "The descriptor cannot provide a command. The Client derives the command from its own Agent configuration"',
  );
  assert.deepEqual(
    launch.args,
    [MOCK_AGENT_PATH, `--scenario=${SCENARIOS.AUTH_TERMINAL}`, '--login', '--interactive'],
    'the method\'s args are APPENDED to the base launch configuration, not substituted for it',
  );
  assert.equal(launch.env.ACP_AUTH_MODE, 'terminal', 'the method env is applied');
  assert.equal(
    launch.cwd,
    process.cwd(),
    '#5.3 step 1 relaunches with the same base launch configuration -- cwd is part of it, and a host that cannot reproduce it cannot reproduce the connection',
  );

  assert.throws(
    () => client.terminalAuthLaunch('agent-login'),
    /is an agent-type auth method/,
    'an agent-type method has no terminal launch configuration',
  );

  await closeAndAssertExit(client, pidFile);
});

test('the method env overrides a same-named variable in the base launch configuration', { timeout: TIMEOUT }, async () => {
  const dir = makeTmpDir('acp-auth-env-');
  const pidFile = path.join(dir, 'agent.pid');
  const client = await withTimeout(
    connect({
      command: process.execPath,
      args: [MOCK_AGENT_PATH, `--scenario=${SCENARIOS.AUTH_TERMINAL}`],
      // same key the terminal method sets, with a different value
      env: { ACP_TEST_PIDFILE: pidFile, ACP_AUTH_MODE: 'base-value' },
      onPermissionRequest: neverApprove,
    }),
    TIMEOUT,
    'connect',
  );
  trackPidFile(pidFile);

  const launch = client.terminalAuthLaunch('terminal-login');
  assert.equal(launch.env.ACP_AUTH_MODE, 'terminal', '#5.3 step 2: the method env overrides same-named base variables');
  assert.equal(launch.env.ACP_TEST_PIDFILE, pidFile, 'base variables the method does not name are preserved');

  await closeAndAssertExit(client, pidFile);
});

// ---- #5.4 logout ---------------------------------------------------------

test('logout() sends an empty params object and re-arms the auth gate', { timeout: TIMEOUT }, async () => {
  const { client, logFile, pidFile } = await connectAuth(SCENARIOS.AUTH_AGENT);

  await withTimeout(client.authenticate('agent-login'), TIMEOUT, 'authenticate');
  await withTimeout(client.newSession({ cwd: process.cwd() }), TIMEOUT, 'newSession before logout');

  await withTimeout(client.logout(), TIMEOUT, 'logout');
  const logoutFrames = clientSent(logFile).filter((m) => m.method === 'logout');
  assert.equal(logoutFrames.length, 1);
  assert.deepEqual(logoutFrames[0].params, {}, '#5.4: logout takes an empty params object');

  const err = await withTimeout(
    client.newSession({ cwd: process.cwd() }).then(
      () => null,
      (e: unknown) => e as Error & { code?: number },
    ),
    TIMEOUT,
    'newSession after logout',
  );
  assert.ok(err, 'a session created after logout should be refused by this agent');
  assert.equal(err.code, -32000);

  await closeAndAssertExit(client, pidFile);
});

test('logout() is refused locally when the agent never advertised auth.logout', { timeout: TIMEOUT }, async () => {
  const { client, logFile, pidFile } = await connectAuth(SCENARIOS.AUTH_TERMINAL);

  assert.equal(client.agentCapabilities.auth.logout, false);
  await assert.rejects(
    client.logout(),
    // Not /logout/i: that matches the mock's own "logout not supported"
    // reply, so it passed even with the capability guard deleted.
    /did not advertise agentCapabilities\.auth\.logout/,
    '#5.4: "Only call this if agentCapabilities.auth.logout was present"',
  );
  assert.equal(
    clientSent(logFile).filter((m) => m.method === 'logout').length,
    0,
    'an unadvertised method must not be sent speculatively',
  );

  await closeAndAssertExit(client, pidFile);
});
