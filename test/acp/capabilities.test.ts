// #4.4 capability normalization against mock-agent.ts.
//
// Written because nothing else in this directory covered it: the mock's
// other scenarios omit `sessionCapabilities` entirely, so every field was
// exercised only through its default. The normalizer's actual reading of
// the wire -- that these fields are presence-typed, `{}` meaning supported
// -- went unchecked until a live capture confirmed it.
//
// That is the failure mode worth guarding. An implementation expecting
// booleans reads every `{}` as falsy, concludes the agent supports nothing,
// degrades silently, and passes all five original suites regardless.
//
// Independence caveat: authored by the same agent that wrote the
// implementation under test (see authenticate.test.ts's header).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { connect } from '../../dist/acp/index.js';
import type { AcpClient } from '../../dist/acp/index.js';

import { SCENARIOS, type ScenarioName } from './scenarios.ts';
import { MOCK_AGENT_PATH, closeAndAssertExit, makeTmpDir, sweepLeaks, trackPidFile, withTimeout } from './helpers.ts';

const TIMEOUT = 5000;

after(sweepLeaks);

async function connectScenario(scenario: ScenarioName): Promise<{ client: AcpClient; pidFile: string }> {
  const dir = makeTmpDir('acp-caps-');
  const pidFile = path.join(dir, 'agent.pid');
  const client = await withTimeout(
    connect({
      command: process.execPath,
      args: [MOCK_AGENT_PATH, `--scenario=${scenario}`],
      env: { ACP_TEST_PIDFILE: pidFile },
      onPermissionRequest: () => {
        throw new Error('this scenario never asks for permission');
      },
    }),
    TIMEOUT,
    'connect',
  );
  trackPidFile(pidFile);
  return { client, pidFile };
}

test('presence-typed `{}` capabilities flatten to true, not falsy (#4.4)', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectScenario(SCENARIOS.CAPS_PRESENCE);

  assert.deepEqual(client.agentCapabilities.sessionCapabilities, {
    resume: true,
    close: true,
    delete: true,
    list: true,
    additionalDirectories: true,
    fork: true,
    subagents: true,
  });
  assert.equal(client.agentCapabilities.auth.logout, true);

  await closeAndAssertExit(client, pidFile);
});

test('a literal `false` reads as UNSUPPORTED, not as "the key is present"', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectScenario(SCENARIOS.CAPS_LITERAL_FALSE);

  // #4.4's convention is omit-or-`{}`, so an explicit `false` is
  // off-spec -- but the only sane reading of it is "no", and a presence
  // check written as `!= null` gets the opposite answer.
  assert.deepEqual(client.agentCapabilities.sessionCapabilities, {
    resume: false,
    close: false,
    delete: false,
    list: false,
    additionalDirectories: false,
    fork: false,
    subagents: false,
  });
  assert.equal(client.agentCapabilities.auth.logout, false, 'logout: false must not enable logout()');

  await closeAndAssertExit(client, pidFile);
});

test('an explicit `null` reads as unsupported, the half of #4.4 omission never covered', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectScenario(SCENARIOS.CAPS_EXPLICIT_NULL);

  assert.deepEqual(client.agentCapabilities.sessionCapabilities, {
    resume: false,
    close: false,
    delete: false,
    list: false,
    additionalDirectories: false,
    fork: false,
    subagents: false,
  });
  assert.equal(client.agentCapabilities.auth.logout, false, 'logout: null must not enable logout()');

  await closeAndAssertExit(client, pidFile);
});

test('an omitted sessionCapabilities block defaults every field to false (#4.4)', { timeout: TIMEOUT }, async () => {
  const { client, pidFile } = await connectScenario(SCENARIOS.HAPPY_PATH);

  assert.deepEqual(client.agentCapabilities.sessionCapabilities, {
    resume: false,
    close: false,
    delete: false,
    list: false,
    additionalDirectories: false,
    fork: false,
    subagents: false,
  });
  assert.equal(client.agentCapabilities.auth.logout, false);

  await closeAndAssertExit(client, pidFile);
});
