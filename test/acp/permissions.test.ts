// The agent requests permission for a tool call; the client must route it
// to the injectable onPermissionRequest policy callback and must not
// auto-approve on its own -- and it must actually wait for and use
// whatever that callback decides, both for an allow and a deny outcome.
// Cancellation while a permission request is outstanding is a distinct,
// spec-mandated obligation (docs/research/acp-protocol.md #14.1: "the
// Client MUST respond to all pending session/request_permission requests
// with the cancelled outcome") and lives in cancellation.test.ts instead,
// since it is fundamentally about cancel() overriding this callback, not
// about the callback itself.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { connect } from '../../dist/acp/index.js';
import type { AcpClient, PermissionRequestHandler, RequestPermissionParams, SessionUpdate } from '../../dist/acp/index.js';

import { SCENARIOS } from './scenarios.ts';
import { MOCK_AGENT_PATH, closeAndAssertExit, drainPrompt, makeTmpDir, sweepLeaks, trackPidFile, withTimeout } from './helpers.ts';

const TIMEOUT = 5000;

after(sweepLeaks);

async function connectToolPermission(onPermissionRequest: PermissionRequestHandler): Promise<{ client: AcpClient; pidFile: string }> {
  const dir = makeTmpDir('acp-permissions-');
  const pidFile = path.join(dir, 'agent.pid');
  const client = await withTimeout(
    connect({
      command: process.execPath,
      args: [MOCK_AGENT_PATH, `--scenario=${SCENARIOS.TOOL_PERMISSION}`],
      env: { ACP_TEST_PIDFILE: pidFile },
      onPermissionRequest,
    }),
    TIMEOUT,
    'connect',
  );
  trackPidFile(pidFile);
  return { client, pidFile };
}

function isToolCallUpdate(
  u: SessionUpdate,
): u is Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }> {
  return u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update';
}

test('a tool-call permission request is routed to the injectable policy callback, not auto-approved', { timeout: TIMEOUT }, async () => {
  const received: RequestPermissionParams[] = [];
  const { client, pidFile } = await connectToolPermission((req) => {
    received.push(req);
    return { outcome: 'selected', optionId: 'allow-once' };
  });
  const session = await withTimeout(client.newSession({ cwd: process.cwd() }), TIMEOUT, 'newSession');
  await withTimeout(drainPrompt(session.prompt('please edit the config')), TIMEOUT, 'prompt');

  assert.equal(received.length, 1, 'the callback must be invoked exactly once, for the one permission request the agent sent');
  const [req] = received;
  assert.equal(req.sessionId, session.sessionId);
  assert.equal(req.toolCall.toolCallId, 'call_1');
  assert.equal(req.options.length, 2);
  assert.deepEqual(req.options.map((o) => o.optionId).sort(), ['allow-once', 'reject-once']);
  assert.ok(req.options.every((o) => typeof o.name === 'string' && o.name.length > 0));
  assert.ok(req.options.every((o) => ['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(o.kind)));

  await closeAndAssertExit(client, pidFile);
});

test('approving the permission request lets the tool call run to completion and the turn end normally', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectToolPermission(() => ({ outcome: 'selected', optionId: 'allow-once' }));
  const session = await withTimeout(client.newSession({ cwd: process.cwd() }), TIMEOUT, 'newSession');
  const { updates, result } = await withTimeout(drainPrompt(session.prompt('edit it')), TIMEOUT, 'prompt');

  const statuses = updates.filter(isToolCallUpdate).map((u) => u.status);
  assert.deepEqual(statuses, ['pending', 'in_progress', 'completed']);
  assert.equal(result.stopReason, 'end_turn');

  await closeAndAssertExit(client, pidFile);
});

test('denying the permission request fails the tool call instead of running it', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectToolPermission(() => ({ outcome: 'selected', optionId: 'reject-once' }));
  const session = await withTimeout(client.newSession({ cwd: process.cwd() }), TIMEOUT, 'newSession');
  const { updates, result } = await withTimeout(drainPrompt(session.prompt('edit it')), TIMEOUT, 'prompt');

  const statuses = updates.filter(isToolCallUpdate).map((u) => u.status);
  assert.deepEqual(statuses, ['pending', 'failed']);
  assert.ok(!statuses.includes('completed'), 'a declined tool call must never reach completed');
  assert.equal(result.stopReason, 'end_turn');

  await closeAndAssertExit(client, pidFile);
});

test('the policy callback may be asynchronous', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectToolPermission(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { outcome: 'selected', optionId: 'allow-once' };
  });
  const session = await withTimeout(client.newSession({ cwd: process.cwd() }), TIMEOUT, 'newSession');
  const { result } = await withTimeout(drainPrompt(session.prompt('edit it')), TIMEOUT, 'prompt');
  assert.equal(result.stopReason, 'end_turn');

  await closeAndAssertExit(client, pidFile);
});
