// Wire framing, asserted at the byte level against
// docs/research/acp-protocol.md #2 ("Framing checklist" -- the doc calls
// this "the single most common integration bug"). Deliberately independent
// of mock-agent.ts: see raw-agent.ts's header comment for why reusing the
// same hand-rolled line reader/writer on both ends of a test would let a
// matching bug on each side cancel out and pass anyway.
//
// Every test here still goes through the pinned connect()/newSession()/
// prompt() surface -- this file has no access to, and makes no assumption
// about, any internal line-buffer implementation. What it can observe
// directly is (a) the exact bytes raw-agent.ts captured from the client's
// writes, via ACP_MOCK_LOG-style logging, and (b) whether the client
// correctly parses input raw-agent.ts deliberately delivers in adversarial
// chunks.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { connect } from '../../dist/acp/index.js';
import type { AcpClient } from '../../dist/acp/index.js';

import {
  RAW_AGENT_PATH,
  closeAndAssertExit,
  drainPrompt,
  makeTmpDir,
  sweepLeaks,
  trackPidFile,
  withTimeout,
} from './helpers.ts';

const TIMEOUT = 5000;

after(sweepLeaks);

interface CapturedLine {
  n: number;
  raw: string;
  length: number;
  containsNewline: boolean;
  parseError?: string;
  method?: string;
}

function readRawLog(logFile: string): CapturedLine[] {
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CapturedLine);
}

async function connectToRawCapture(): Promise<{ client: AcpClient; logFile: string; pidFile: string }> {
  const dir = makeTmpDir('acp-framing-');
  const logFile = path.join(dir, 'raw.log');
  const pidFile = path.join(dir, 'agent.pid');
  const client = await withTimeout(
    connect({
      command: process.execPath,
      args: [RAW_AGENT_PATH, '--raw=capture'],
      env: { RAW_LOG_FILE: logFile, ACP_TEST_PIDFILE: pidFile },
      onPermissionRequest: () => {
        throw new Error('the capture scenario never asks for permission');
      },
    }),
    TIMEOUT,
    'connect',
  );
  trackPidFile(pidFile);
  return { client, logFile, pidFile };
}

test(
  'initialize is exactly one newline-terminated JSON line: no pretty-printing, no embedded newline, no Content-Length',
  { timeout: TIMEOUT },
  async () => {
    const { client, logFile, pidFile } = await connectToRawCapture();
    const lines = readRawLog(logFile);
    assert.equal(lines.length, 1, 'exactly one line should have been captured for the initialize request');
    const [first] = lines;
    assert.equal(first.parseError, undefined, `initialize request line should parse as JSON, got: ${first.parseError}`);
    assert.equal(first.method, 'initialize');
    assert.equal(first.containsNewline, false, 'the captured line must not itself contain a newline character');
    assert.ok(!first.raw.includes('Content-Length'), 'must not use LSP-style Content-Length framing (see acp-protocol.md #2)');
    const parsed = JSON.parse(first.raw) as { jsonrpc: string; params: { protocolVersion: number } };
    assert.equal(parsed.jsonrpc, '2.0');
    assert.equal(parsed.params.protocolVersion, 1, 'a v1 client must request protocolVersion 1 (acp-protocol.md #1, #4.1)');

    await closeAndAssertExit(client, pidFile);
  },
);

test(
  'session/new always sends mcpServers on the wire, defaulting to [] even when the caller omits it',
  { timeout: TIMEOUT },
  async () => {
    const { client, logFile, pidFile } = await connectToRawCapture();
    const cwd = process.cwd();
    await withTimeout(client.newSession({ cwd }), TIMEOUT, 'newSession');

    const lines = readRawLog(logFile);
    assert.equal(lines.length, 2);
    const second = lines[1];
    assert.equal(second.method, 'session/new');
    assert.equal(second.containsNewline, false);
    const parsed = JSON.parse(second.raw) as { params: { cwd: string; mcpServers: unknown } };
    assert.deepEqual(
      parsed.params.mcpServers,
      [],
      'mcpServers is required on the wire and must never be omitted, even when the caller of newSession() left it out (acp-protocol.md #6.1)',
    );
    assert.equal(parsed.params.cwd, cwd);
    for (const line of lines) assert.ok(!line.raw.includes('Content-Length'));

    await closeAndAssertExit(client, pidFile);
  },
);

test(
  'a newline embedded in prompt text is escaped on the wire, never sent as a raw byte',
  { timeout: TIMEOUT },
  async () => {
    const { client, logFile, pidFile } = await connectToRawCapture();
    const session = await withTimeout(client.newSession({ cwd: process.cwd() }), TIMEOUT, 'newSession');

    const multiline = 'line one\nline two';
    await withTimeout(drainPrompt(session.prompt(multiline)), TIMEOUT, 'prompt');

    const lines = readRawLog(logFile);
    assert.equal(lines.length, 3);
    const third = lines[2];
    assert.equal(third.method, 'session/prompt');
    assert.equal(
      third.containsNewline,
      false,
      'the wire line itself must contain no raw newline byte even though the prompt text does -- a correct writer JSON-escapes it as \\n',
    );
    const parsed = JSON.parse(third.raw) as { params: { prompt: Array<{ text: string }> } };
    assert.equal(parsed.params.prompt[0].text, multiline, 'the text must round-trip exactly through JSON escaping');

    await closeAndAssertExit(client, pidFile);
  },
);

test(
  'the client reassembles a fragmented initialize response, splits two messages sent in one write, and stays usable afterward',
  { timeout: TIMEOUT },
  async () => {
    const dir = makeTmpDir('acp-framing-frag-');
    const pidFile = path.join(dir, 'agent.pid');
    const client = await withTimeout(
      connect({
        command: process.execPath,
        args: [RAW_AGENT_PATH, '--raw=fragmented'],
        env: { ACP_TEST_PIDFILE: pidFile },
        onPermissionRequest: () => {
          throw new Error('the fragmented scenario never asks for permission');
        },
      }),
      TIMEOUT,
      'connect',
    );
    trackPidFile(pidFile);

    assert.equal(
      client.agentInfo?.name,
      'acp-raw-agent-fragmented',
      'a response delivered as two delayed partial writes must still be parsed as one message',
    );

    const session = await withTimeout(client.newSession({ cwd: process.cwd() }), TIMEOUT, 'newSession');
    assert.equal(
      session.sessionId,
      'sess_raw_2',
      'session/new must resolve correctly even though an unrelated notification was concatenated into the same write as its response',
    );

    const { updates, result } = await withTimeout(drainPrompt(session.prompt('hello')), TIMEOUT, 'prompt');
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(
      updates,
      [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still here' } }],
      'a real exchange after the adversarial chunk must still work -- proves the line buffer was not left desynced',
    );

    await closeAndAssertExit(client, pidFile);
  },
);
