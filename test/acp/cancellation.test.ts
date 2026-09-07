// session/cancel per docs/research/acp-protocol.md #14.1. Three distinct
// spec obligations, each asserted directly rather than assumed to follow
// from one happy-path run:
//   1. the agent MUST eventually resolve the original session/prompt with
//      stopReason "cancelled" once cancellation completes;
//   2. the client SHOULD still accept (not drop) updates the agent sends
//      after cancel was requested but before the turn actually resolves;
//   3. the client MUST itself answer any outstanding
//      session/request_permission with the cancelled outcome -- this is
//      the client's own obligation, independent of whatever the injected
//      policy callback would eventually have decided, so the test proves
//      it by giving that callback a promise that never resolves.
// $/cancel_request (acp-protocol.md #14.2, a distinct, protocol-level,
// per-request mechanism, and explicitly optional to support) is out of
// scope: the pinned client surface has no per-request cancellation handle,
// only session.cancel() for a whole prompt turn.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { connect } from '../../dist/acp/index.js';
import type { AcpClient, PermissionRequestHandler } from '../../dist/acp/index.js';

import { SCENARIOS } from './scenarios.ts';
import {
  MOCK_AGENT_PATH,
  closeAndAssertExit,
  drainPrompt,
  makeTmpDir,
  sweepLeaks,
  takeUpdates,
  trackPidFile,
  withTimeout,
} from './helpers.ts';

const TIMEOUT = 5000;

after(sweepLeaks);

async function connectScenario(
  scenario: string,
  onPermissionRequest: PermissionRequestHandler,
): Promise<{ client: AcpClient; pidFile: string }> {
  const dir = makeTmpDir('acp-cancellation-');
  const pidFile = path.join(dir, 'agent.pid');
  const client = await withTimeout(
    connect({
      command: process.execPath,
      args: [MOCK_AGENT_PATH, `--scenario=${scenario}`],
      env: { ACP_TEST_PIDFILE: pidFile },
      onPermissionRequest,
    }),
    TIMEOUT,
    'connect',
  );
  trackPidFile(pidFile);
  return { client, pidFile };
}

test('session/cancel resolves the in-flight turn with stopReason cancelled', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectScenario(SCENARIOS.CANCEL_HANG, () => {
    throw new Error('this scenario never asks for permission');
  });
  const session = await withTimeout(client.newSession({ cwd: process.cwd() }), TIMEOUT, 'newSession');

  const iterator = session.prompt('do something slow');
  await withTimeout(takeUpdates(iterator, 1), TIMEOUT, 'first update'); // "Starting work..." -- proves the turn is genuinely in flight before we cancel it
  session.cancel();
  const { result } = await withTimeout(drainPrompt(iterator), TIMEOUT, 'prompt after cancel');

  assert.equal(result.stopReason, 'cancelled', 'acp-protocol.md #14.1: the agent MUST respond with stopReason cancelled once cancellation completes');

  await closeAndAssertExit(client, pidFile);
});

test('updates the agent sends after cancel but before the turn resolves are still delivered, not dropped', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectScenario(SCENARIOS.CANCEL_HANG, () => {
    throw new Error('this scenario never asks for permission');
  });
  const session = await withTimeout(client.newSession({ cwd: process.cwd() }), TIMEOUT, 'newSession');

  const iterator = session.prompt('do something slow');
  const [firstUpdate] = await withTimeout(takeUpdates(iterator, 1), TIMEOUT, 'first update');
  session.cancel();
  const { updates: laterUpdates, result } = await withTimeout(drainPrompt(iterator), TIMEOUT, 'prompt after cancel');

  assert.deepEqual(firstUpdate, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Starting work...' } });
  assert.deepEqual(
    laterUpdates,
    [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Cleaning up...' } }],
    'a late update sent between session/cancel and the turn actually resolving must still reach the caller (acp-protocol.md #14.1, "SHOULD still accept... updates received after sending session/cancel")',
  );
  assert.equal(result.stopReason, 'cancelled');

  await closeAndAssertExit(client, pidFile);
});

test('cancelling while a permission request is outstanding is answered with the cancelled outcome by the client itself', { timeout: TIMEOUT }, async () => {
  let permissionRequested: () => void = () => {};
  const permissionRequestedPromise = new Promise<void>((resolve) => {
    permissionRequested = resolve;
  });

  const { client, pidFile } = await connectScenario(SCENARIOS.TOOL_PERMISSION, () => {
    permissionRequested();
    // Deliberately never resolves: if the client answered this via the
    // policy callback, the turn would hang forever waiting on this promise
    // and the test's own timeout would fail it. The client is required to
    // answer the pending session/request_permission itself, on cancel,
    // without waiting on this callback at all (acp-protocol.md #14.1:
    // "The Client MUST respond to all pending session/request_permission
    // requests with the cancelled outcome").
    return new Promise<never>(() => {});
  });
  const session = await withTimeout(client.newSession({ cwd: process.cwd() }), TIMEOUT, 'newSession');

  const iterator = session.prompt('please edit the config');
  await withTimeout(permissionRequestedPromise, TIMEOUT, 'waiting for the permission request to be dispatched');
  session.cancel();
  const { result } = await withTimeout(drainPrompt(iterator), TIMEOUT, 'prompt after cancel');

  assert.equal(
    result.stopReason,
    'cancelled',
    'the mock only ever resolves stopReason cancelled after a request_permission call itself resolves with {outcome:"cancelled"} -- since this test\'s own callback never resolves, that can only have happened because the client answered the pending permission request on its own',
  );

  await closeAndAssertExit(client, pidFile);
});

test('cancel() with no in-flight prompt is a harmless no-op', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectScenario(SCENARIOS.HAPPY_PATH, () => {
    throw new Error('this scenario never asks for permission');
  });
  const session = await withTimeout(client.newSession({ cwd: process.cwd() }), TIMEOUT, 'newSession');

  assert.doesNotThrow(() => session.cancel());

  const { result } = await withTimeout(drainPrompt(session.prompt('still works?')), TIMEOUT, 'prompt');
  assert.equal(result.stopReason, 'end_turn', 'a stray cancel with nothing in flight must not corrupt the session for a later, real prompt');

  await closeAndAssertExit(client, pidFile);
});
