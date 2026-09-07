// Session Config Options (docs/research/acp-protocol.md #17.2) -- the
// mechanism the spec calls current and says will replace Session Modes
// (#17.1), which this client already implements as the fallback.
//
// The property worth guarding is full-state replacement. #17.2 is explicit
// that set_config_option's response, and the config_option_update
// notification, carry the ENTIRE option list every time -- "this allows
// Agents to reflect dependent changes... if changing the model affects
// available reasoning options". A client that patches only the option it
// just set silently desyncs from the agent on every dependent change, and
// no simple round-trip test would catch it. The CONFIG_OPTIONS scenario
// therefore makes one option's change move another.
//
// Independence caveat: authored by the same agent that wrote the
// implementation under test (see authenticate.test.ts's header).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { connect } from '../../dist/acp/index.js';
import type { AcpClient, AcpSession, SessionConfigOption } from '../../dist/acp/index.js';

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

/** Reads one select option's current value out of the session's live state. */
function currentValue(session: AcpSession, id: string): string | boolean | undefined {
  return session.configOptions?.find((o) => o.id === id)?.currentValue;
}

async function openSession(
  scenario: ScenarioName,
): Promise<{ client: AcpClient; session: AcpSession; logFile: string; pidFile: string }> {
  const dir = makeTmpDir('acp-cfg-');
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

test('configOptions is surfaced off the session/new result (#17.2)', { timeout: TIMEOUT }, async () => {
  const { client, session, pidFile } = await openSession(SCENARIOS.CONFIG_OPTIONS);

  assert.ok(session.configOptions, 'the mechanism the spec calls current must not be discarded');
  assert.deepEqual(
    session.configOptions.map((o) => o.id),
    ['mode', 'model'],
  );
  const mode = session.configOptions.find((o) => o.id === 'mode') as Extract<SessionConfigOption, { type: 'select' }>;
  assert.equal(mode.type, 'select');
  assert.equal(mode.currentValue, 'auto');
  assert.equal(mode.category, 'mode');
  assert.deepEqual(
    mode.options.map((o) => o.value),
    ['default', 'auto', 'plan'],
  );

  await closeAndAssertExit(client, pidFile);
});

test('an agent sending both mechanisms exposes both, with configOptions authoritative (#17.2 precedence)', { timeout: TIMEOUT }, async () => {
  const { client, session, pidFile } = await openSession(SCENARIOS.CONFIG_OPTIONS);

  // Both are surfaced so a caller can implement either side of the
  // transition; the spec's rule is that a client supporting configOptions
  // "SHOULD use configOptions exclusively and ignore modes".
  assert.ok(session.configOptions, 'configOptions present');
  assert.ok(session.modes, 'modes still surfaced as the fallback for un-migrated agents');
  assert.equal(session.supportsConfigOptions, true, 'a caller needs to know which mechanism to trust');

  await closeAndAssertExit(client, pidFile);
});

test('setConfigOption sends sessionId/configId/value and adopts the FULL returned state, including dependent changes', { timeout: TIMEOUT }, async () => {
  const { client, session, logFile, pidFile } = await openSession(SCENARIOS.CONFIG_OPTIONS);
  assert.equal(currentValue(session, 'model'), 'sonnet');

  await withTimeout(session.setConfigOption('mode', 'plan'), TIMEOUT, 'setConfigOption');

  const frames = clientSent(logFile).filter((m) => m.method === 'session/set_config_option');
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].params, { sessionId: session.sessionId, configId: 'mode', value: 'plan' });

  assert.equal(currentValue(session, 'mode'), 'plan', 'the option just set must be updated');
  assert.equal(
    currentValue(session, 'model'),
    'opus',
    'the agent changed a DIFFERENT option in the same response; patching only the set field would miss it',
  );

  await closeAndAssertExit(client, pidFile);
});

test('config_option_update replaces the whole state (#8, #17.2)', { timeout: TIMEOUT }, async () => {
  const { client, session, pidFile } = await openSession(SCENARIOS.CONFIG_OPTIONS);
  assert.equal(currentValue(session, 'model'), 'sonnet');

  const { result } = await withTimeout(drainPrompt(session.prompt('go')), TIMEOUT, 'prompt');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(currentValue(session, 'model'), 'opus', 'an agent-initiated full replacement must land');

  await closeAndAssertExit(client, pidFile);
});

test('setConfigOption refuses an unknown configId, and a value the agent never offered, without sending anything', { timeout: TIMEOUT }, async () => {
  const { client, session, logFile, pidFile } = await openSession(SCENARIOS.CONFIG_OPTIONS);

  await assert.rejects(session.setConfigOption('nope', 'x'), /nope|no config option/i);
  await assert.rejects(session.setConfigOption('mode', 'not-an-option'), /not-an-option|not one of/i);
  assert.equal(
    clientSent(logFile).filter((m) => m.method === 'session/set_config_option').length,
    0,
    'both are caller bugs detectable locally; neither is worth a round trip',
  );
  assert.equal(currentValue(session, 'mode'), 'auto', 'a refused call must not move local state');

  await closeAndAssertExit(client, pidFile);
});

test('a session from an agent reporting no configOptions exposes none and refuses setConfigOption locally', { timeout: TIMEOUT }, async () => {
  const { client, session, logFile, pidFile } = await openSession(SCENARIOS.HAPPY_PATH);

  assert.equal(session.configOptions, undefined);
  assert.equal(session.supportsConfigOptions, false);
  await assert.rejects(session.setConfigOption('mode', 'plan'), /config option/i);
  assert.equal(clientSent(logFile).filter((m) => m.method === 'session/set_config_option').length, 0);

  await closeAndAssertExit(client, pidFile);
});
