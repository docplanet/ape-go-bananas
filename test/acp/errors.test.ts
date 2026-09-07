// Failure paths a real agent can put a client through: a JSON-RPC error
// response instead of a result, invalid JSON on the wire, and the
// subprocess dying outright -- before initialize ever answers, and again
// mid-turn. In every case the pinned property under test is the same: the
// caller gets a rejection it can act on, within a bounded time, and the
// client's own bookkeeping (close()) stays safe to use afterward. None of
// this is a single spec MUST the way stopReason:"cancelled" is (the spec
// mostly describes how a well-behaved agent avoids these situations, e.g.
// #14.1's warning that agents must translate an aborted-operation exception
// into stopReason "cancelled" rather than an error) -- so "must not hang
// forever, and must not leak the process" is this suite's own bar for the
// client's defensive behavior, not a transcribed protocol rule. See the
// task's return value for exactly which of these are spec-grounded versus
// this suite's own reasonable-defaults call.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { connect } from '../../dist/acp/index.js';
import type { AcpClient, PermissionRequestHandler, SessionUpdate } from '../../dist/acp/index.js';

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

const neverApprove: PermissionRequestHandler = () => {
  throw new Error('none of these scenarios ask for permission');
};

async function connectScenario(scenario: string): Promise<{ client: AcpClient; pidFile: string }> {
  const dir = makeTmpDir('acp-errors-');
  const pidFile = path.join(dir, 'agent.pid');
  const client = await withTimeout(
    connect({
      command: process.execPath,
      args: [MOCK_AGENT_PATH, `--scenario=${scenario}`],
      env: { ACP_TEST_PIDFILE: pidFile },
      onPermissionRequest: neverApprove,
    }),
    TIMEOUT,
    'connect',
  );
  trackPidFile(pidFile);
  return { client, pidFile };
}

test('a JSON-RPC error response to session/prompt rejects the turn instead of resolving silently', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectScenario(SCENARIOS.ERROR_RESPONSE);
  const session = await withTimeout(client.newSession({ cwd: process.cwd() }), TIMEOUT, 'newSession');

  await assert.rejects(
    () => withTimeout(drainPrompt(session.prompt('trigger the error')), TIMEOUT, 'prompt'),
    (err: unknown) => {
      assert.ok(err instanceof Error, 'the rejection should be an Error');
      assert.equal((err as { code?: unknown }).code, -32603, 'the JSON-RPC error code should be preserved on the thrown error');
      assert.ok(err.message.length > 0);
      return true;
    },
  );

  await closeAndAssertExit(client, pidFile);
});

test('invalid JSON from the agent surfaces as a rejection instead of hanging forever', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectScenario(SCENARIOS.MALFORMED_JSON);
  const session = await withTimeout(client.newSession({ cwd: process.cwd() }), TIMEOUT, 'newSession');

  // The bound here IS the assertion: a client that silently ignores the bad
  // line and waits forever for a well-formed response that will never
  // arrive fails this test by timing out, exactly as it should.
  await assert.rejects(() => withTimeout(drainPrompt(session.prompt('trigger the garbage line')), TIMEOUT, 'prompt'));

  await client.close();
});

test('the agent process exiting before initialize responds rejects connect(), not hangs it', { timeout: TIMEOUT }, async () => {
  const dir = makeTmpDir('acp-errors-exit-before-init-');
  const pidFile = path.join(dir, 'agent.pid');
  const connectPromise = connect({
    command: process.execPath,
    args: [MOCK_AGENT_PATH, `--scenario=${SCENARIOS.EXIT_BEFORE_INIT}`],
    env: { ACP_TEST_PIDFILE: pidFile },
    onPermissionRequest: neverApprove,
  });
  trackPidFile(pidFile);

  await assert.rejects(() => withTimeout(connectPromise, TIMEOUT, 'connect'));

  for (let i = 0; i < 50 && !existsSync(pidFile); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(await waitForExit(pid, 2000), 'the agent process (which exits on its own here) must not be left running');
});

test('the agent process exiting mid-turn delivers what arrived first, then rejects instead of hanging', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectScenario(SCENARIOS.EXIT_MID_TURN);
  const session = await withTimeout(client.newSession({ cwd: process.cwd() }), TIMEOUT, 'newSession');

  const iterator = session.prompt('trigger the crash');
  const collected: SessionUpdate[] = [];
  let completedNormally = false;
  let rejection: unknown;
  try {
    for (;;) {
      const step = await withTimeout(iterator.next(), TIMEOUT, 'next() after crash');
      if (step.done) {
        completedNormally = true;
        break;
      }
      collected.push(step.value);
    }
  } catch (err) {
    rejection = err;
  }

  // Deliberately asserted OUTSIDE the try block above: putting this
  // assertion inside the try (and relying on assert.fail() to throw into
  // the same catch) would let a broken implementation that never rejects
  // at all masquerade as "correctly rejected", since assert.fail()'s own
  // AssertionError would land in `rejection` and read as a pass.
  assert.deepEqual(
    collected,
    [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working...' } }],
    'the one update sent before the crash must still be delivered',
  );
  assert.ok(!completedNormally, 'expected the generator to reject once the agent process exited, not to complete normally');
  assert.ok(rejection instanceof Error, 'the turn must reject once the subprocess is gone, not hang waiting for a response that will never come');

  // close() must stay safe even though the subprocess already exited on its own.
  await client.close();
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(!pidIsAlive(pid) || (await waitForExit(pid, 2000)));
});

test('close() is safe to call after a failed prompt turn, and safe to call more than once', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectScenario(SCENARIOS.ERROR_RESPONSE);
  const session = await withTimeout(client.newSession({ cwd: process.cwd() }), TIMEOUT, 'newSession');
  await assert.rejects(() => withTimeout(drainPrompt(session.prompt('trigger the error')), TIMEOUT, 'prompt'));

  await assert.doesNotReject(() => client.close());
  await assert.doesNotReject(() => client.close(), 'close() must be idempotent, not reject or throw on a second call');

  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(await waitForExit(pid, 2000));
});
