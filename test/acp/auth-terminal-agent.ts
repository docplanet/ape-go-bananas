// A third, self-contained fake agent used ONLY by auth-terminal.test.ts.
// It impersonates the Claude adapter's initialize behaviour from
// docs/research/claude-adapter-auth.md §2: terminal auth methods are
// offered ONLY to a client that advertised `clientCapabilities.auth.terminal
// === true`; every other client gets `authMethods: []`.
//
// WHY A SEPARATE SCRIPT rather than a new scenario for mock-agent.ts: the
// mock imports its scenario vocabulary from './scenarios.ts' by a fixed
// relative path and branches on those names, and its handleInitialize()
// never reads the request's `clientCapabilities` at all. Both would need
// edits to existing files to make an initialize reply depend on what the
// client advertised, and this task forbids editing existing files. The
// framing technique (from-scratch line reader, one JSON object per '\n'
// line) is copied from raw-agent.ts; the log format ({dir, raw, t} per
// line, dir 'recv' for what the client sent and 'send' for our replies) is
// copied from mock-agent.ts so the same direction-filtered reader the
// other suites use works here unchanged.
//
// Spawned as `node auth-terminal-agent.ts --claude-adapter`. The flag guard
// below matters: node --test's bare discovery imports every file under
// test/ as a candidate test, and without the guard this would start the
// stdin loop and hang the whole suite (see mock-agent.ts's header for the
// full story). Env vars honoured: ACP_MOCK_LOG (frame log, both
// directions) and ACP_TEST_PIDFILE (written at startup so a test can
// assert the process is reaped).

import { appendFileSync, writeFileSync } from 'node:fs';

const SPAWN_FLAG = '--claude-adapter';

if (process.argv[2] === SPAWN_FLAG) {
  runAgent();
}
// else: auto-discovered, not deliberately spawned -- do nothing, exit.

// ---- the wire shapes from claude-adapter-auth.md §2, quoted exactly -----
//
// `<node>` and `<adapter>` are the doc's placeholders for the adapter's own
// launch line. They are deliberately NOT process.execPath / this file: the
// test asserts terminalAuthLaunch() ignores this block and derives the
// launch from the connection's command instead, which only proves
// something if the two differ. The doc abbreviates the second method's
// _meta as "same shape, --console"; it is expanded here in that shape.

const CLAUDE_AI_LOGIN = {
  id: 'claude-ai-login',
  name: 'Claude Subscription',
  description: 'Use Claude subscription ',
  type: 'terminal',
  args: ['--cli', 'auth', 'login', '--claudeai'],
  _meta: {
    'terminal-auth': {
      command: '<node>',
      args: ['<adapter>/dist/index.js', '--cli', 'auth', 'login', '--claudeai'],
      label: 'Claude Login',
    },
  },
};

const CONSOLE_LOGIN = {
  id: 'console-login',
  name: 'Anthropic Console',
  description: 'Use Anthropic Console (API usage billing)',
  type: 'terminal',
  args: ['--cli', 'auth', 'login', '--console'],
  _meta: {
    'terminal-auth': {
      command: '<node>',
      args: ['<adapter>/dist/index.js', '--cli', 'auth', 'login', '--console'],
      label: 'Console Login',
    },
  },
};

// ---- plumbing --------------------------------------------------------------

function logLine(dir: 'send' | 'recv', raw: string): void {
  const logPath = process.env.ACP_MOCK_LOG;
  if (!logPath) return;
  try {
    appendFileSync(logPath, JSON.stringify({ dir, raw, t: Date.now() }) + '\n');
  } catch {
    // diagnostics only -- never let logging break the agent
  }
}

function writeLine(msg: unknown): void {
  const line = JSON.stringify(msg);
  logLine('send', line);
  process.stdout.write(line + '\n');
}

function respond(id: unknown, result: unknown): void {
  writeLine({ jsonrpc: '2.0', id, result });
}

function respondError(id: unknown, code: number, message: string): void {
  writeLine({ jsonrpc: '2.0', id, error: { code, message } });
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

interface Request {
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
}

/** §2: the adapter offers terminal methods only when the client advertised auth.terminal. */
function clientAdvertisedTerminalAuth(params: Record<string, unknown>): boolean {
  const caps = params.clientCapabilities as { auth?: { terminal?: unknown } } | undefined;
  return caps?.auth?.terminal === true;
}

function runAgent(): void {
  if (process.env.ACP_TEST_PIDFILE) {
    writeFileSync(process.env.ACP_TEST_PIDFILE, String(process.pid));
  }

  process.stdin.on('end', () => process.exit(0));

  readLines((line) => {
    logLine('recv', line);
    let msg: Request;
    try {
      msg = JSON.parse(line) as Request;
    } catch {
      process.stderr.write(`auth-terminal-agent: ignoring unparseable line: ${line}\n`);
      return;
    }
    const { id, method } = msg;
    const params = msg.params ?? {};
    if (id === undefined) return; // notifications need no reply

    switch (method) {
      case 'initialize':
        respond(id, {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
            mcpCapabilities: { http: false, sse: false },
          },
          agentInfo: { name: 'acp-auth-terminal-agent', version: '0.0.0-test' },
          authMethods: clientAdvertisedTerminalAuth(params) ? [CLAUDE_AI_LOGIN, CONSOLE_LOGIN] : [],
        });
        return;
      case 'authenticate':
        // Must never arrive for a terminal-type id (#5.3). Answered with an
        // error so a client that wrongly sends it gets a rejection either
        // way; the test asserts on the LOG (zero authenticate frames), not
        // on this reply.
        respondError(id, -32602, 'auth-terminal-agent: authenticate must never be sent for a terminal-type method (#5.3)');
        return;
      case 'session/new':
        respond(id, { sessionId: 'sess_auth_terminal_1' });
        return;
      default:
        respondError(id, -32601, `auth-terminal-agent: method not found: ${String(method)}`);
    }
  });
}
