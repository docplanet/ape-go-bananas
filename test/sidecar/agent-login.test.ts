// agent-protocol.md §2 `agent/login` (terminal path), §3's `agent/authStatus`
// forwarding, and §5 bullet 4, over the mock provider whose CLAUDE_AUTH
// scenario impersonates the Claude adapter (claude-adapter-auth.md §2-§4).
// The "fake login script" is the package shim itself: invoked with the
// method's args it prints two lines, exits 0, and leaves a marker that makes
// the reconnected agent report `{ kind: "claude", label: "Logged in" }`.
// Written from the spec by a context that has not seen src/sidecar/agent*.ts.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test, { after } from 'node:test';

import { CLAUDE_AUTH_METHODS, CLAUDE_AUTH_SIGNED_OUT, SCENARIOS } from '../acp/scenarios.ts';
import {
  CLAUDE_LOGIN_ARGS, LOGGED_IN_STATUS, LOGIN_STDOUT_LINES, agentPid, agentReceived, connectMock, expectError, isNotification,
  layoutMockProvider, notificationParams, pidIsAlive, primeRegistry, shimArgvs, updatesFor, waitForExit, waitForLine,
  type AuthStatus, type LoginResult, type StatusResult,
} from './agent-helpers.ts';
import { TIMEOUT, isJsonRpcLine, spawnSidecar, sweepSidecars, type Sidecar } from './helpers.ts';

after(sweepSidecars);

interface AuthStatusNote { connectionId: string; authStatus: AuthStatus }
interface LoginOutputNote { connectionId: string; stream: 'stdout' | 'stderr'; line: string }

async function sidecarWithMock(): Promise<{ s: Sidecar; dataDir: string }> {
  const { dataDir } = layoutMockProvider();
  const s = spawnSidecar();
  await s.ready;
  await primeRegistry(s, dataDir);
  return { s, dataDir };
}

test('_auth/status_update is forwarded as agent/authStatus and carried on agent/connect and agent/status (§2, §3)', { timeout: TIMEOUT }, async () => {
  const { s, dataDir } = await sidecarWithMock();
  const { result, files } = await connectMock(s, dataDir, SCENARIOS.CLAUDE_AUTH);
  assert.deepEqual(result.authStatus, CLAUDE_AUTH_SIGNED_OUT, '§2: "last _auth/status_update seen"');
  assert.deepEqual(result.authMethods, CLAUDE_AUTH_METHODS, 'ACP #5.1 shape, verbatim from initialize');
  assert.deepEqual(result.agent, { name: 'acp-mock-claude', version: '0.75.1-test' });
  assert.equal(result.authRequired, false, 'claude-adapter-auth.md §3: session/new succeeds signed out');
  assert.ok(result.session, 'a session is opened regardless of sign-in state');

  const { msg } = await waitForLine(s, (m) => isNotification(m, 'agent/authStatus'), 'agent/authStatus');
  assert.deepEqual(msg.params, { connectionId: result.connectionId, authStatus: CLAUDE_AUTH_SIGNED_OUT });
  assert.equal(notificationParams(s, 'agent/authStatus').length, 1, 'one status update, forwarded once');
  const status = (await s.request('st', 'agent/status', { connectionId: result.connectionId })).result as StatusResult;
  assert.deepEqual(status.authStatus, CLAUDE_AUTH_SIGNED_OUT);
  assert.deepEqual(status.authMethods, CLAUDE_AUTH_METHODS);
  assert.ok(existsSync(files.logFile));
  assert.equal(await s.end(), 0);
});

test('agent/login (terminal): output relayed in order, reconnect re-initializes, authenticated from the new status, fresh session (§2, §5)', { timeout: TIMEOUT }, async () => {
  const { s, dataDir } = await sidecarWithMock();
  const extraArgs = ['--course', 'anatomy'];
  const { result, files } = await connectMock(s, dataDir, SCENARIOS.CLAUDE_AUTH, { extraArgs });
  const { connectionId } = result;
  const firstSessionId = result.session!.sessionId;
  const firstPid = agentPid(files.pidFile);
  assert.ok(pidIsAlive(firstPid), 'sanity: the first agent process is up');
  assert.ok(!existsSync(files.marker), 'sanity: nothing has logged in yet');
  const linesBefore = s.lines.length;

  const res = await s.request('login', 'agent/login', { connectionId, methodId: 'claude-ai-login' });
  assert.equal(res.error, undefined, `agent/login: ${JSON.stringify(res.error)}`);
  const login = res.result as LoginResult;

  // §5.3 step 1-2 via terminalAuthLaunch(): same bin and base args, the method's args appended, stdin closed
  const argvs = shimArgvs(files.argvFile);
  assert.deepEqual(argvs, [extraArgs, [...extraArgs, ...CLAUDE_LOGIN_ARGS], extraArgs], 'connect, login run, reconnect -- each with the connection\'s own argv');
  assert.ok(existsSync(files.marker), 'the login run happened (it wrote the marker)');

  // output lines forwarded in order, before the response
  const output = notificationParams<LoginOutputNote>(s, 'agent/loginOutput', linesBefore);
  assert.deepEqual(output.filter((o) => o.stream === 'stdout'), LOGIN_STDOUT_LINES.map((line) => ({ connectionId, stream: 'stdout', line })));
  for (const o of output) assert.ok(o.stream === 'stdout' || o.stream === 'stderr', `stream is stdout|stderr, got ${o.stream}`);
  const responseIndex = s.lines.findIndex((l) => l.json?.id === 'login');
  const lastOutputIndex = s.lines.map((l) => l.json?.method).lastIndexOf('agent/loginOutput');
  assert.ok(lastOutputIndex < responseIndex, 'loginOutput notifications precede the login response');

  // reconnect: the agent saw a second initialize, on a new process, and the old one is gone
  const inits = agentReceived(files.logFile).filter((f) => f.method === 'initialize');
  assert.equal(inits.length, 2, 'the log shows a SECOND initialize (§5.3 step 4: reconnect and reinitialize)');
  for (const init of inits) assert.equal((init.params?.clientCapabilities as { auth?: { terminal?: unknown } })?.auth?.terminal, true);
  assert.ok(await waitForExit(firstPid), `the old agent process (pid ${firstPid}) must be closed`);
  const secondPid = agentPid(files.pidFile);
  assert.notEqual(secondPid, firstPid);
  assert.ok(pidIsAlive(secondPid), 'the reconnected agent is up');

  // the response
  assert.equal(login.methodId, 'claude-ai-login');
  assert.equal(login.exitCode, 0);
  assert.equal(login.authenticated, true, 'authStatus.kind !== "none" on the second connection');
  assert.ok(login.session, '§2: the response carries the session agent/connect would, created on the new connection');
  assert.equal(typeof login.session.sessionId, 'string');
  assert.notEqual(login.session.sessionId, firstSessionId, 'a new session on the new connection');
  assert.deepEqual(login.session.commands, []);

  // the new status: forwarded, and reflected by agent/status under the SAME connectionId
  const statuses = notificationParams<AuthStatusNote>(s, 'agent/authStatus');
  assert.deepEqual(statuses.map((n) => n.authStatus), [CLAUDE_AUTH_SIGNED_OUT, LOGGED_IN_STATUS], 'signed out, then logged in');
  assert.ok(statuses.every((n) => n.connectionId === connectionId), 'the connection keeps its connectionId across the reconnect');
  const status = (await s.request('st', 'agent/status', { connectionId })).result as StatusResult;
  assert.deepEqual(status.authStatus, LOGGED_IN_STATUS);
  assert.deepEqual(status.sessions, [login.session.sessionId], 'the old session is closed with the old connection');
  expectError(await s.request('old', 'agent/prompt', { sessionId: firstSessionId, blocks: [{ type: 'text', text: 'x' }] }), -32602, 'the old session is gone');

  // and the new session works
  const prompt = await s.request('p', 'agent/prompt', { sessionId: login.session.sessionId, blocks: [{ type: 'text', text: 'hi' }] });
  assert.deepEqual(prompt.result, { stopReason: 'end_turn' });
  assert.deepEqual(updatesFor(s, login.session.sessionId).map((u) => (u.content as { text: string }).text), ['Signed-in reply.']);
  assert.ok(s.lines.every(isJsonRpcLine), `non-JSON-RPC stdout line:\n${s.lines.map((l) => l.raw).join('\n')}`);
  assert.deepEqual((await s.request('d', 'agent/disconnect', { connectionId })).result, {});
  assert.ok(await waitForExit(secondPid), 'disconnect reaps the reconnected process');
  assert.equal(await s.end(), 0);
});

test('agent/login validation: unknown connectionId and missing methodId are -32602; the connection survives a bad methodId', { timeout: TIMEOUT }, async () => {
  const { s, dataDir } = await sidecarWithMock();
  const { result } = await connectMock(s, dataDir, SCENARIOS.CLAUDE_AUTH);
  // §2 also says an api provider -> -32602; without an API key that path
  // cannot be reached here, so it belongs to the OpenRouter oracle.
  assert.match(expectError(await s.request(1, 'agent/login', { connectionId: 'no-such-connection', methodId: 'claude-ai-login' }), -32602, 'unknown connectionId').message, /connectionId|connection/i);
  assert.match(expectError(await s.request(2, 'agent/login', { connectionId: result.connectionId }), -32602, 'missing methodId').message, /methodId/);
  const bad = await s.request(3, 'agent/login', { connectionId: result.connectionId, methodId: 'no-such-method' });
  assert.ok(bad.error, 'a method the agent never advertised cannot be launched');
  const status = await s.request(4, 'agent/status', { connectionId: result.connectionId });
  assert.deepEqual((status.result as StatusResult).sessions, [result.session!.sessionId], 'the connection and its session are untouched by the refusals');
  assert.equal(notificationParams(s, 'agent/loginOutput').length, 0, 'nothing was launched');
  assert.equal(await s.end(), 0);
});
