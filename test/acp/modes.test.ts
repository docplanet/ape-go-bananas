// Session Modes (docs/research/acp-protocol.md #17.1): the `modes` block on
// the session/new result, session/set_mode, and current_mode_update --
// including the agent switching mode unilaterally, which #17.1 permits.
//
// Why this is not a cosmetic feature. A real agent inherits its mode from
// the host's own configuration, and in `auto` it decides permissions itself
// and issues no session/request_permission at all -- observed against
// claude-agent-acp 0.75.1, which wrote a file unasked across three turns.
// A client that cannot read or set the mode therefore cannot tell whether
// its permission callback is a control or a decoration.
//
// The spec contradicts itself on one field name -- #8's catalog says
// `currentModeId`, #17.1's example says `modeId` -- so both spellings are
// exercised here, and the client is expected to accept either. See
// SESSION_MODES in scenarios.ts.
//
// Independence caveat: authored by the same agent that wrote the
// implementation under test (see authenticate.test.ts's header).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { connect } from '../../dist/acp/index.js';
import type { AcpClient, AcpSession } from '../../dist/acp/index.js';

import { SCENARIOS, type ScenarioName } from './scenarios.ts';
import {
  MOCK_AGENT_PATH,
  closeAndAssertExit,
  drainPrompt,
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

function clientSent(logFile: string): Array<{ method?: string; params?: Record<string, unknown> }> {
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as LoggedLine)
    .filter((e) => e.dir === 'recv')
    .map((e) => JSON.parse(e.raw) as { method?: string; params?: Record<string, unknown> });
}

async function openSession(
  scenario: ScenarioName,
): Promise<{ client: AcpClient; session: AcpSession; logFile: string; pidFile: string }> {
  const dir = makeTmpDir('acp-modes-');
  const logFile = path.join(dir, 'mock.log');
  const pidFile = path.join(dir, 'agent.pid');
  const client = await withTimeout(
    connect({
      command: process.execPath,
      args: [MOCK_AGENT_PATH, `--scenario=${scenario}`],
      env: { ACP_MOCK_LOG: logFile, ACP_TEST_PIDFILE: pidFile },
      onPermissionRequest: () => {
        throw new Error('these scenarios never ask for permission');
      },
    }),
    TIMEOUT,
    'connect',
  );
  trackPidFile(pidFile);
  const session = await withTimeout(client.newSession({ cwd: process.cwd() }), TIMEOUT, 'newSession');
  return { client, session, logFile, pidFile };
}

test("the session/new result's modes block is surfaced, not discarded (#17.1)", { timeout: TIMEOUT }, async () => {
  const { client, session, pidFile } = await openSession(SCENARIOS.SESSION_MODES);

  assert.ok(session.modes, 'a caller cannot reason about permission behavior it cannot see');
  assert.equal(session.modes.currentModeId, 'auto');
  assert.equal(session.currentModeId, 'auto', 'currentModeId tracks the live mode, starting from the reported one');
  assert.deepEqual(
    session.modes.availableModes.map((m) => m.id),
    ['default', 'auto', 'plan'],
  );
  assert.equal(session.modes.availableModes[0].name, 'Manual');

  await closeAndAssertExit(client, pidFile);
});

test('a session from an agent that reports no modes exposes none, and setMode is refused locally', { timeout: TIMEOUT }, async () => {
  const { client, session, logFile, pidFile } = await openSession(SCENARIOS.HAPPY_PATH);

  assert.equal(session.modes, undefined);
  assert.equal(session.currentModeId, undefined);
  await assert.rejects(session.setMode('default'), /mode/i);
  assert.equal(
    clientSent(logFile).filter((m) => m.method === 'session/set_mode').length,
    0,
    'an agent that never reported modes must not be sent session/set_mode',
  );

  await closeAndAssertExit(client, pidFile);
});

test('setMode() sends sessionId and modeId, and the new mode becomes current (#17.1)', { timeout: TIMEOUT }, async () => {
  const { client, session, logFile, pidFile } = await openSession(SCENARIOS.SESSION_MODES);

  await withTimeout(session.setMode('default'), TIMEOUT, 'setMode');

  const frames = clientSent(logFile).filter((m) => m.method === 'session/set_mode');
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].params, { sessionId: session.sessionId, modeId: 'default' });
  assert.equal(session.currentModeId, 'default', 'the mode the client just set must be reflected');

  await closeAndAssertExit(client, pidFile);
});

test('a unilateral current_mode_update is tracked even using the spec\'s other field spelling', { timeout: TIMEOUT }, async () => {
  const { client, session, pidFile } = await openSession(SCENARIOS.SESSION_MODES);
  assert.equal(session.currentModeId, 'auto');

  // this scenario's prompt turn makes the agent switch to 'plan' on its own,
  // announced with #17.1's `modeId` spelling rather than #8's `currentModeId`
  const { result } = await withTimeout(drainPrompt(session.prompt('go')), TIMEOUT, 'prompt');
  assert.equal(result.stopReason, 'end_turn');

  assert.equal(
    session.currentModeId,
    'plan',
    'the doc names this field two different ways; reading only one silently stops tracking the mode',
  );

  await closeAndAssertExit(client, pidFile);
});

test('setMode() with a mode the agent never advertised is refused locally, with nothing sent', { timeout: TIMEOUT }, async () => {
  const { client, session, logFile, pidFile } = await openSession(SCENARIOS.SESSION_MODES);

  await assert.rejects(session.setMode('no-such-mode'), /no-such-mode|advertise|available/i);
  assert.equal(clientSent(logFile).filter((m) => m.method === 'session/set_mode').length, 0);
  assert.equal(session.currentModeId, 'auto', 'a refused setMode must not move the tracked mode');

  await closeAndAssertExit(client, pidFile);
});
