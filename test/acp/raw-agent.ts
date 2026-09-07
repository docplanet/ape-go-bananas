// A second, minimal fake agent used ONLY by framing.test.ts, deliberately
// NOT sharing any line-reading/writing code with mock-agent.ts.
//
// Why a second fixture at all: if the client and the one mock it's ever
// tested against are framed by the same hand, a framing bug can show up
// identically on both ends and the suite still goes green -- e.g. a client
// that reads with a naive `data` handler assuming one event equals one
// message would look fine against a mock that always happens to write one
// message per flush, and neither side would ever expose the other's bug.
// This file is written straight from docs/research/acp-protocol.md #2
// ("Framing checklist") with its own from-scratch line reader, and it goes
// out of its way to write the wire *adversarially* (split writes, two
// messages in one write) specifically to defeat that kind of accidental
// agreement. Everything else about the protocol (scenario richness,
// permission flows, etc.) is mock-agent.ts's job, not this file's.
//
// Same auto-discovery hazard and guard as mock-agent.ts applies here --
// see that file's header comment. Spawned as `node raw-agent.ts --raw=<name>`.

import { appendFileSync, writeFileSync } from 'node:fs';

const RAW_FLAG = '--raw=';

const rawArg = process.argv[2];
if (rawArg !== undefined && rawArg.startsWith(RAW_FLAG)) {
  runRaw(rawArg.slice(RAW_FLAG.length));
}
// else: auto-discovered, not deliberately spawned -- see mock-agent.ts.

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logEvent(event: Record<string, unknown>): void {
  const logPath = process.env.RAW_LOG_FILE;
  if (!logPath) return;
  appendFileSync(logPath, JSON.stringify(event) + '\n');
}

/** Independent line reader: buffers stdin and calls onLine once per '\n'-terminated line. */
function readLines(onLine: (line: string) => void): void {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) onLine(line);
      idx = buffer.indexOf('\n');
    }
  });
}

function parseRequest(line: string): { id: unknown; method: unknown; params: Record<string, unknown> } {
  const msg = JSON.parse(line) as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  return { id: msg.id, method: msg.method, params: msg.params ?? {} };
}

function runRaw(name: string): void {
  if (process.env.ACP_TEST_PIDFILE) {
    writeFileSync(process.env.ACP_TEST_PIDFILE, String(process.pid));
  }
  if (name === 'capture') return runCapture();
  if (name === 'fragmented') return runFragmented();
  process.stderr.write(`raw-agent: unknown --raw scenario ${name}\n`);
}

// ---- "capture": log every raw line the client writes, verbatim ----------
//
// The test asserts against the log, not against anything this function
// decides is interesting -- see framing.test.ts. This function's only job
// is to (a) record exactly what arrived, byte for byte, before any
// interpretation, and (b) send back just enough of a valid response that
// the client's calls actually resolve, so the exchange can continue to the
// next message the test wants captured.

function runCapture(): void {
  let n = 0;
  readLines((line) => {
    n += 1;
    let parsed: { id: unknown; method: unknown; params: Record<string, unknown> } | undefined;
    let parseError: string | undefined;
    try {
      parsed = parseRequest(line);
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e);
    }
    logEvent({ n, raw: line, length: line.length, containsNewline: line.includes('\n'), parseError, method: parsed?.method });

    if (!parsed) return; // logged the failure; nothing sane to respond with
    const { id, method } = parsed;

    if (method === 'initialize') {
      respond(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false }, mcpCapabilities: { http: false, sse: false } },
        agentInfo: { name: 'acp-raw-agent', version: '0.0.0-test' },
        authMethods: [],
      });
    } else if (method === 'session/new') {
      respond(id, { sessionId: 'sess_raw_1' });
    } else if (method === 'session/prompt') {
      respond(id, { stopReason: 'end_turn' });
    }
  });
}

function respond(id: unknown, result: unknown): void {
  writeLine({ jsonrpc: '2.0', id, result });
}

function writeLine(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// ---- "fragmented": adversarial chunking of THIS agent's own writes ------
//
// Proves the client buffers partial lines and correctly splits multiple
// messages delivered in one chunk, rather than assuming one stdout `data`
// event equals one message.

function runFragmented(): void {
  let step = 0;
  readLines(async (line) => {
    step += 1;
    const { id, method, params } = parseRequest(line);

    if (step === 1 && method === 'initialize') {
      const result = {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false }, mcpCapabilities: { http: false, sse: false } },
        agentInfo: { name: 'acp-raw-agent-fragmented', version: '0.0.0-test' },
        authMethods: [],
      };
      const full = JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
      const mid = Math.floor(full.length / 2);
      process.stdout.write(full.slice(0, mid));
      await delay(5); // give the client's stream reader a chance to see a partial, unterminated chunk
      process.stdout.write(full.slice(mid));
      return;
    }

    if (step === 2 && method === 'session/new') {
      // An unrelated, unsolicited notification for a session the client has
      // never heard of, concatenated in the SAME write as the real
      // response it's actually waiting for -- the client must not choke on
      // it, and must still resolve session/new correctly.
      const strayNotification = JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'sess_unrelated', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ignore me' } } },
      });
      const response = JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 'sess_raw_2' } });
      process.stdout.write(strayNotification + '\n' + response + '\n');
      return;
    }

    if (step === 3 && method === 'session/prompt') {
      // A normal exchange, to prove the line-buffer wasn't left desynced by
      // the trick above.
      const sessionId = params.sessionId as string;
      writeLine({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still here' } } } });
      respond(id, { stopReason: 'end_turn' });
    }
  });
}
