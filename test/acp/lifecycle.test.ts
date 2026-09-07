// Full client lifecycle against mock-agent.ts: connect, initialize,
// session/new, a streamed multi-update prompt turn observed in order, a
// second turn on the same session, and the version-negotiation failure
// path from docs/research/acp-protocol.md #4.3. Auth-method discovery
// itself (the authenticate/logout methods in acp-protocol.md #5) is out of
// scope -- the pinned client surface this suite tests has no authenticate()
// call, only the initialize-response fields a caller would need in order
// to decide whether to build one; see this task's return value for the
// full list of what §5 leaves untested.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { connect } from '../../dist/acp/index.js';
import type { AcpClient } from '../../dist/acp/index.js';

import { SCENARIOS } from './scenarios.ts';
import {
  MOCK_AGENT_PATH,
  closeAndAssertExit,
  drainPrompt,
  makeTmpDir,
  pidIsAlive,
  sweepLeaks,
  trackPidFile,
  waitForExit,
  withTimeout,
} from './helpers.ts';

const TIMEOUT = 5000;

after(sweepLeaks);

interface LoggedLine {
  dir: 'send' | 'recv';
  raw: string;
  t: number;
}

function readMockLog(logFile: string): Array<{ method?: string; params?: Record<string, unknown> }> {
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse((JSON.parse(line) as LoggedLine).raw) as { method?: string; params?: Record<string, unknown> });
}

function neverApprove(): never {
  throw new Error('this scenario never asks for permission');
}

async function connectHappyPath(): Promise<{ client: AcpClient; logFile: string; pidFile: string }> {
  const dir = makeTmpDir('acp-lifecycle-');
  const logFile = path.join(dir, 'mock.log');
  const pidFile = path.join(dir, 'agent.pid');
  const client = await withTimeout(
    connect({
      command: process.execPath,
      args: [MOCK_AGENT_PATH, `--scenario=${SCENARIOS.HAPPY_PATH}`],
      env: { ACP_MOCK_LOG: logFile, ACP_TEST_PIDFILE: pidFile },
      onPermissionRequest: neverApprove,
    }),
    TIMEOUT,
    'connect',
  );
  trackPidFile(pidFile);
  return { client, logFile, pidFile };
}

test('initialize sends protocolVersion 1, a clientInfo, and does not claim fs/terminal capabilities it does not implement', { timeout: TIMEOUT }, async () => {
  const { client, logFile, pidFile } = await connectHappyPath();
  const [initReq] = readMockLog(logFile);
  assert.equal(initReq.method, 'initialize');
  const params = initReq.params as { protocolVersion: number; clientInfo?: { name: string; version: string }; clientCapabilities?: { fs?: { readTextFile?: boolean; writeTextFile?: boolean }; terminal?: boolean } };

  assert.equal(params.protocolVersion, 1, 'a v1 client must send protocolVersion 1 (acp-protocol.md #1, #4.1)');
  assert.ok(params.clientInfo, 'the spec says to always send clientInfo even though v1 makes it optional (acp-protocol.md #4.1)');
  assert.equal(typeof params.clientInfo?.name, 'string');
  assert.ok(params.clientInfo!.name.length > 0);
  assert.equal(typeof params.clientInfo?.version, 'string');

  const caps = params.clientCapabilities;
  assert.notEqual(caps?.terminal, true, 'this client does not implement terminal/* callbacks and must not claim it does');
  assert.notEqual(caps?.fs?.readTextFile, true, 'this client does not implement fs/read_text_file and must not claim it does');
  assert.notEqual(caps?.fs?.writeTextFile, true, 'this client does not implement fs/write_text_file and must not claim it does');

  await closeAndAssertExit(client, pidFile);
});

test('connect() surfaces the agent capabilities, authMethods, and negotiated protocolVersion from the initialize response', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectHappyPath();
  assert.equal(client.protocolVersion, 1);
  assert.deepEqual(client.authMethods, []);
  assert.equal(client.agentInfo?.name, 'acp-mock-agent');
  assert.equal(client.agentCapabilities.loadSession, false);
  assert.deepEqual(client.agentCapabilities.promptCapabilities, { image: false, audio: false, embeddedContext: false });

  await closeAndAssertExit(client, pidFile);
});

test('newSession sends the required cwd and returns the agent-issued sessionId', { timeout: TIMEOUT }, async () => {
  const { client, logFile, pidFile } = await connectHappyPath();
  const cwd = process.cwd();
  const session = await withTimeout(client.newSession({ cwd }), TIMEOUT, 'newSession');
  assert.equal(session.sessionId, 'sess_mock_1');

  const [, sessionNewReq] = readMockLog(logFile);
  assert.equal(sessionNewReq.method, 'session/new');
  assert.equal((sessionNewReq.params as { cwd: string }).cwd, cwd);

  await closeAndAssertExit(client, pidFile);
});

test('a single prompt streams plan, message, and usage updates in order, then resolves end_turn', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectHappyPath();
  const session = await withTimeout(client.newSession({ cwd: process.cwd() }), TIMEOUT, 'newSession');

  const { updates, result } = await withTimeout(drainPrompt(session.prompt('hi there')), TIMEOUT, 'prompt');

  assert.equal(updates.length, 3);
  assert.equal(updates[0].sessionUpdate, 'plan');
  assert.equal(updates[1].sessionUpdate, 'agent_message_chunk');
  assert.deepEqual(updates[1], {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'msg_1',
    content: { type: 'text', text: 'Echo turn 1: hi there' },
  });
  assert.deepEqual(updates[2], { sessionUpdate: 'usage_update', used: 10, size: 1000 });
  assert.equal(result.stopReason, 'end_turn');

  await closeAndAssertExit(client, pidFile);
});

test('multiple prompts on the same session are independent, ordered turns', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectHappyPath();
  const session = await withTimeout(client.newSession({ cwd: process.cwd() }), TIMEOUT, 'newSession');

  const first = await withTimeout(drainPrompt(session.prompt('one')), TIMEOUT, 'first prompt');
  assert.equal(first.result.stopReason, 'end_turn');
  assert.deepEqual((first.updates[1] as { content: { text: string } }).content.text, 'Echo turn 1: one');

  const second = await withTimeout(drainPrompt(session.prompt('two')), TIMEOUT, 'second prompt');
  assert.equal(second.result.stopReason, 'end_turn');
  assert.deepEqual((second.updates[1] as { content: { text: string } }).content.text, 'Echo turn 2: two');

  await closeAndAssertExit(client, pidFile);
});

test('an agent that negotiates down to an unsupported protocol version causes connect() to reject and does not leak the subprocess', { timeout: TIMEOUT }, async () => {
  const dir = makeTmpDir('acp-lifecycle-mismatch-');
  const pidFile = path.join(dir, 'agent.pid');
  const connectPromise = connect({
    command: process.execPath,
    args: [MOCK_AGENT_PATH, `--scenario=${SCENARIOS.PROTOCOL_MISMATCH}`],
    env: { ACP_TEST_PIDFILE: pidFile },
    onPermissionRequest: neverApprove,
  });
  trackPidFile(pidFile);

  await assert.rejects(
    () => withTimeout(connectPromise, TIMEOUT, 'connect'),
    'connect() must reject when the agent responds with a protocolVersion (999) the client cannot support (acp-protocol.md #4.3)',
  );

  // The mock writes its pidfile at startup, before initialize is even
  // handled, so it exists regardless of how negotiation turns out.
  for (let i = 0; i < 50 && !existsSync(pidFile); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(pidIsAlive(pid), 'sanity check: the agent should have started at all');
  const exited = await waitForExit(pid, 2000);
  assert.ok(exited, 'the client must terminate the subprocess itself even though connect() never returned a client to call close() on');
});
