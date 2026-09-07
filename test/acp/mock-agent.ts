// A scenario-driven fake ACP agent, spoken over stdio exactly per
// docs/research/acp-protocol.md, for driving the client's lifecycle,
// permissions, cancellation, and error-handling tests into specific,
// deterministic states. The tests spawn this themselves, as
// `node mock-agent.ts --scenario=<name>` (see SCENARIOS in scenarios.ts) --
// never run it directly.
//
// IMPORTANT -- read before touching the guard below: node --test's bare
// discovery treats every file under a `test/` directory as a candidate
// test file (confirmed by hand against a real hang, not assumed from the
// docs alone: `**/test/**/*.ts` is one of its default patterns) and will
// otherwise import and execute this module on its own, with no scenario
// argument and nothing on the other end of stdin. Without the guard below,
// that starts the stdin-reading loop anyway and hangs forever -- not just
// this file's own (harmless) slot in the run, but, because node --test
// runs one file per child process and waits for each to exit, it hangs the
// entire shared suite, including the checks/ and apkg/ tracks' tests. Any
// other file in this directory that is spawned as a subprocess (see
// raw-agent.ts) needs the same guard for the same reason.

import { appendFileSync, writeFileSync } from 'node:fs';

import { SCENARIOS, SCENARIO_FLAG, type ScenarioName } from './scenarios.ts';

const scenarioArg = process.argv[2];
if (scenarioArg !== undefined && scenarioArg.startsWith(SCENARIO_FLAG)) {
  runAgent(scenarioArg.slice(SCENARIO_FLAG.length) as ScenarioName);
}
// else: auto-discovered, not deliberately spawned. Do nothing; let the
// process exit on its own -- no listeners are attached above this line.

// ---- minimal JSON-RPC plumbing -----------------------------------------
//
// Hand-rolled independently of whatever the real client ends up doing --
// this only needs to be correct enough to drive the scenarios below, not
// to double as a framing conformance check. That job belongs to
// raw-agent.ts and framing.test.ts on purpose: see their header comments.

interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function logLine(dir: 'send' | 'recv', raw: string): void {
  const logPath = process.env.ACP_MOCK_LOG;
  if (!logPath) return;
  try {
    appendFileSync(logPath, JSON.stringify({ dir, raw, t: Date.now() }) + '\n');
  } catch {
    // diagnostics only -- never let logging break a scenario
  }
}

function writeMessage(msg: RpcMessage): void {
  const line = JSON.stringify(msg);
  logLine('send', line);
  process.stdout.write(line + '\n');
}

function respondResult(id: number | string | null, result: unknown): void {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function respondError(id: number | string | null, code: number, message: string, data?: unknown): void {
  writeMessage({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } });
}

function notify(method: string, params: Record<string, unknown>): void {
  writeMessage({ jsonrpc: '2.0', method, params });
}

let outgoingId = 1000; // disjoint from the client's own ids, purely so logs read clearly
const pendingOutgoing = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();

function sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = outgoingId++;
  return new Promise((resolve, reject) => {
    pendingOutgoing.set(id, { resolve, reject });
    writeMessage({ jsonrpc: '2.0', id, method, params });
  });
}

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- scenario state ------------------------------------------------------

let sessionCounter = 0;
const sessionTurnCounts = new Map<string, number>();
/** sessionId -> callback that finishes a CANCEL_HANG turn once session/cancel arrives. */
const pendingCancel = new Map<string, () => void>();

function runAgent(scenario: ScenarioName): void {
  if (process.env.ACP_TEST_PIDFILE) {
    writeFileSync(process.env.ACP_TEST_PIDFILE, String(process.pid));
  }

  if (scenario === SCENARIOS.EXIT_BEFORE_INIT) {
    process.exit(3);
  }

  process.stdin.on('end', () => process.exit(0));

  readLines((line) => {
    logLine('recv', line);
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      process.stderr.write(`mock-agent: ignoring unparseable line: ${line}\n`);
      return;
    }
    dispatch(msg, scenario);
  });
}

function dispatch(msg: RpcMessage, scenario: ScenarioName): void {
  if (msg.method !== undefined) {
    const params = msg.params ?? {};
    if ('id' in msg) {
      handleRequest(msg.method, msg.id ?? null, params, scenario);
    } else {
      handleNotification(msg.method, params);
    }
    return;
  }
  if ('id' in msg && msg.id !== null && msg.id !== undefined) {
    const pending = pendingOutgoing.get(Number(msg.id));
    if (pending) {
      pendingOutgoing.delete(Number(msg.id));
      if (msg.error) pending.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else pending.resolve(msg.result);
    }
    return;
  }
  process.stderr.write(`mock-agent: message has neither method nor a matching pending id: ${JSON.stringify(msg)}\n`);
}

function handleRequest(
  method: string,
  id: number | string | null,
  params: Record<string, unknown>,
  scenario: ScenarioName,
): void {
  switch (method) {
    case 'initialize':
      return handleInitialize(id, scenario);
    case 'session/new':
      return handleSessionNew(id, params);
    case 'session/prompt':
      return handleSessionPrompt(id, params, scenario);
    default:
      respondError(id, -32601, `mock-agent: method not found: ${method}`);
  }
}

function handleNotification(method: string, params: Record<string, unknown>): void {
  if (method === 'session/cancel') {
    const sessionId = params.sessionId as string;
    const finish = pendingCancel.get(sessionId);
    if (finish) {
      pendingCancel.delete(sessionId);
      finish();
    }
    // If a session/request_permission is outstanding for this session
    // instead, docs/research/acp-protocol.md #14.1 makes answering it with
    // the cancelled outcome the CLIENT's obligation, not the agent's -- we
    // just wait for that reply on the existing sendRequest() promise like
    // any other response; see runToolPermission below.
  }
}

// ---- initialize / session/new -------------------------------------------

function handleInitialize(id: number | string | null, scenario: ScenarioName): void {
  const protocolVersion = scenario === SCENARIOS.PROTOCOL_MISMATCH ? 999 : 1;
  respondResult(id, {
    protocolVersion,
    agentCapabilities: {
      loadSession: false,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false },
    },
    agentInfo: { name: 'acp-mock-agent', version: '0.0.0-test' },
    authMethods: [],
  });
}

function handleSessionNew(id: number | string | null, params: Record<string, unknown>): void {
  sessionCounter += 1;
  const sessionId = `sess_mock_${sessionCounter}`;
  sessionTurnCounts.set(sessionId, 0);
  void params; // logged verbatim via ACP_MOCK_LOG; tests assert on the log, not here
  respondResult(id, { sessionId });
}

// ---- session/prompt, branched by scenario --------------------------------

function handleSessionPrompt(id: number | string | null, params: Record<string, unknown>, scenario: ScenarioName): void {
  const sessionId = params.sessionId as string;
  const promptBlocks = (params.prompt ?? []) as Array<{ type: string; text?: string }>;
  const text = promptBlocks.find((b) => b.type === 'text')?.text ?? '';

  switch (scenario) {
    case SCENARIOS.HAPPY_PATH:
      void runHappyPath(id, sessionId, text);
      return;
    case SCENARIOS.TOOL_PERMISSION:
      void runToolPermission(id, sessionId);
      return;
    case SCENARIOS.CANCEL_HANG:
      runCancelHang(id, sessionId);
      return;
    case SCENARIOS.ERROR_RESPONSE:
      respondError(id, -32603, 'internal error: simulated failure', { detail: 'synthetic' });
      return;
    case SCENARIOS.MALFORMED_JSON:
      process.stdout.write('{this is not valid json\n');
      return;
    case SCENARIOS.EXIT_MID_TURN:
      notify('session/update', {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working...' } },
      });
      setTimeout(() => process.exit(9), 5);
      return;
    default:
      respondError(id, -32603, `mock-agent: no session/prompt behavior wired for scenario ${scenario}`);
  }
}

async function runHappyPath(id: number | string | null, sessionId: string, text: string): Promise<void> {
  const turn = (sessionTurnCounts.get(sessionId) ?? 0) + 1;
  sessionTurnCounts.set(sessionId, turn);

  await delay(1);
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read the message', priority: 'medium', status: 'completed' },
        { content: 'Reply', priority: 'medium', status: 'in_progress' },
      ],
    },
  });

  await delay(1);
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      messageId: `msg_${turn}`,
      content: { type: 'text', text: `Echo turn ${turn}: ${text}` },
    },
  });

  await delay(1);
  notify('session/update', { sessionId, update: { sessionUpdate: 'usage_update', used: turn * 10, size: 1000 } });

  respondResult(id, { stopReason: 'end_turn' });
}

async function runToolPermission(id: number | string | null, sessionId: string): Promise<void> {
  notify('session/update', {
    sessionId,
    update: { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'Editing config', kind: 'edit', status: 'pending' },
  });

  const response = (await sendRequest('session/request_permission', {
    sessionId,
    toolCall: { toolCallId: 'call_1' },
    options: [
      { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
  })) as { outcome: { outcome: string; optionId?: string } };

  const outcome = response.outcome;

  if (outcome.outcome === 'cancelled') {
    notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'failed' } });
    respondResult(id, { stopReason: 'cancelled' });
    return;
  }

  if (outcome.optionId === 'allow-once') {
    notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'in_progress' } });
    await delay(1);
    notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Done' } }],
      },
    });
    notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Applied the edit.' } } });
    respondResult(id, { stopReason: 'end_turn' });
    return;
  }

  // reject-once
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'User declined.' } }],
    },
  });
  notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Edit was rejected.' } } });
  // UNVERIFIED (see the return value of the task this mock was written for):
  // the spec does not state which StopReason follows a declined permission
  // request. end_turn is the closest documented fit -- the model
  // acknowledges the decline and stops asking, rather than refusing the
  // whole conversation -- but this is this mock's modeling choice, not a
  // transcribed spec rule.
  respondResult(id, { stopReason: 'end_turn' });
}

function runCancelHang(id: number | string | null, sessionId: string): void {
  notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Starting work...' } } });
  pendingCancel.set(sessionId, () => {
    notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Cleaning up...' } } });
    respondResult(id, { stopReason: 'cancelled' });
  });
  // Deliberately never responds on its own -- only session/cancel (or
  // process teardown) ends this turn. See docs/research/acp-protocol.md
  // #14.1: "the Agent MUST respond to the original session/prompt request
  // with the cancelled stop reason" once cancellation completes, and MAY
  // still send updates first ("the Client SHOULD still accept tool call
  // updates received after sending session/cancel").
}
