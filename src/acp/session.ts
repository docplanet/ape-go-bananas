// The client side of the ACP handshake and the prompt turn: initialize +
// version negotiation, session creation, sending a prompt and surfacing the
// agent's streamed `session/update` notifications as an async iterator that
// ends on a stop reason, and mid-turn cancellation. Built entirely on
// transport.ts's generic request()/notify()/onRequest()/onNotification() --
// no framing or JSON-RPC envelope logic lives here, only ACP method names,
// param shapes (protocol.ts), and turn/permission bookkeeping.
//
// Five design decisions worth calling out because they are load-bearing for
// specific test assertions (points 1-4) or for a real (if untested-by-mock)
// agent behavior (point 5), not just style:
//
// 1. **`prompt()` sends the request eagerly, synchronously, before ever
//    returning the async generator to the caller.** It is NOT a lazy
//    `async function*` that only sends on first `.next()`. cancellation.test.ts's
//    permission-cancellation case calls `session.prompt(...)` and then
//    awaits an out-of-band signal (the injected policy callback having been
//    invoked) *without ever calling `.next()`* before calling
//    `session.cancel()` -- so the wire request, and the bookkeeping cancel()
//    depends on, must already exist the instant prompt() returns. The
//    generator returned by prompt() only *drains* an already-in-flight turn.
//
// 2. **Every `session/update` notification for a turn is queued and
//    strictly drained before the turn's terminal outcome (result or error)
//    is ever surfaced.** This is what makes "the one update sent before a
//    mid-turn crash still arrives" (errors.test.ts) and "an update sent
//    between session/cancel and the eventual cancelled response still
//    arrives" (cancellation.test.ts, acp-protocol.md #14.1's "SHOULD still
//    accept...updates received after sending session/cancel") both true
//    without racing: pushUpdate() calls happen synchronously from inside
//    transport's notification dispatch, while the turn's settle() only ever
//    runs from a `.then()` on the request promise -- a microtask that by
//    definition cannot run until the synchronous dispatch of every line
//    that arrived before the response line (in the same chunk or an
//    earlier one) has already finished. See TurnState below.
//
// 3. **The client answers a pending `session/request_permission` with the
//    `cancelled` outcome itself, on cancel() -- it never waits on the
//    injected policy callback to do it.** acp-protocol.md #14.1: "The
//    Client MUST respond to all pending session/request_permission requests
//    with the cancelled outcome," stated as the client's own unconditional
//    obligation. cancellation.test.ts proves this by handing cancel() a
//    policy callback that never resolves at all.
//
// 4. **connect() does NOT await the transport's teardown before rejecting**
//    on a version mismatch or a failed initialize -- it starts close() and
//    rejects immediately. lifecycle.test.ts's protocol-mismatch case
//    asserts the agent process is still alive immediately after connect()'s
//    promise settles (a "sanity check" that it really started) and only
//    THEN polls for it to exit within a further 2s -- which is only
//    possible if connect()'s rejection isn't gated on the subprocess having
//    already exited. transport.close() itself is documented never to
//    reject, so firing it without awaiting is safe.
//
// 5. **`session/update` notifications are not all turn-scoped.** Four of
//    #8's eleven variants (available_commands_update, session_info_update,
//    current_mode_update, config_option_update) are agent-unilateral --
//    #18 says the slash-command catalog "may [be] resend[ent]... at any
//    time" -- and a real agent can and does emit them immediately after
//    session/new, before any prompt() call exists to queue them into.
//    AcpSessionImpl buffers such updates and/or hands them to onUpdate()
//    (see its own doc comment) instead of dropping them; connect() below
//    additionally buffers by sessionId (`pendingSessionUpdates`) for the
//    narrower race where such an update arrives before newSession()'s
//    `await` has even returned to register the session at all -- dispatch()
//    processes every line in one stdout chunk synchronously and in order,
//    but the code that runs *after* an `await` only resumes as a later
//    microtask, so an update in the same chunk as the session/new response
//    it follows can reach this module's notification router before
//    newSession() has had a chance to call `sessions.set(...)`.

import { AcpTransport, type RequestId } from './transport.js';
import {
  DEFAULT_CLIENT_INFO,
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type AuthMethod,
  type ClientCapabilities,
  type ContentBlock,
  type Implementation,
  type InitializeResult,
  type McpServer,
  type NewSessionParams,
  type PromptInput,
  type PromptTurnResult,
  type ProtocolVersion,
  type RequestPermissionOutcome,
  type RequestPermissionParams,
  type SessionId,
  type SessionUpdate,
  type TerminalAuthLaunch,
} from './protocol.js';

// ---- public surface --------------------------------------------------------

/**
 * The injectable permission policy. Called once per `session/request_permission`
 * the agent sends (acp-protocol.md #11.1) -- the client must route it here,
 * never auto-approve, and must actually wait for (and use) whatever this
 * returns, unless cancel() intervenes first (see file header, point 3).
 */
export type PermissionRequestHandler = (
  params: RequestPermissionParams,
) => RequestPermissionOutcome | Promise<RequestPermissionOutcome>;

export interface ConnectOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  onPermissionRequest: PermissionRequestHandler;
  /** Overrides DEFAULT_CLIENT_INFO if given; sent as `clientInfo` on `initialize` (#4.1). */
  clientInfo?: Implementation;
  /**
   * Optional ceiling on how long connect() waits for the agent's `initialize`
   * response before giving up. `undefined` (the default) preserves the
   * original behavior of waiting indefinitely -- nothing here times out
   * unless a caller opts in. A hang here is indistinguishable on the wire
   * from an agent that is merely slow to start, so there is no spec-derived
   * number to default to; this is deliberately scoped to `initialize` only
   * (not a general per-request timeout) since a stuck handshake, with no
   * client to call close() on yet, is the one failure a caller has no other
   * way to detect or recover from. On expiry, connect() rejects and tears
   * down the subprocess exactly as it does for any other connect()-time
   * failure (see file header, point 4).
   */
  initializeTimeoutMs?: number;
}

/** `ms === undefined` returns `p` completely unwrapped -- no timer, no altered behavior -- which is what keeps ConnectOptions.initializeTimeoutMs strictly opt-in. */
function withOptionalTimeout<T>(p: Promise<T>, ms: number | undefined, makeError: () => Error): Promise<T> {
  if (ms === undefined) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError()), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export interface AcpSession {
  readonly sessionId: SessionId;
  /**
   * Sends one prompt turn (#7) and returns an async iterator: each
   * `.next()` yields one `session/update` payload in wire order, and the
   * iterator's own return value (only reachable via the generator protocol's
   * `return`, e.g. by manually driving `.next()` -- a bare `for await` loop
   * discards it) is the turn's final PromptTurnResult. Rejects instead of
   * completing if the turn itself fails (JSON-RPC error, malformed data, or
   * the agent process dying mid-turn).
   */
  prompt(input: PromptInput): AsyncGenerator<SessionUpdate, PromptTurnResult, void>;
  /**
   * Cancels the in-flight turn, if any (a harmless no-op otherwise):
   * notifies the agent (#14.1) and immediately answers any outstanding
   * `session/request_permission` for this session with the cancelled
   * outcome (see file header, point 3). Does not itself wait for the
   * agent's eventual `stopReason: "cancelled"` response -- keep draining
   * the iterator for that.
   */
  cancel(): void;
  /**
   * Registers the handler for `session/update` notifications that arrive
   * with no prompt turn in flight to queue them into -- see file header,
   * point 5. Real examples: the slash-command catalog (#18) or the
   * session's own title (#6.6) changing outside of anything a `prompt()`
   * call is draining. At most one handler is kept (a later call replaces an
   * earlier one, matching transport.ts's onRequest/onNotification
   * convention); anything that arrived before any handler was ever
   * registered is delivered, in order, the moment one is.
   */
  onUpdate(listener: (update: SessionUpdate) => void): void;
}

export interface AcpClient {
  readonly protocolVersion: ProtocolVersion;
  readonly authMethods: AuthMethod[];
  readonly agentInfo: Implementation | undefined;
  readonly agentCapabilities: AgentCapabilities;
  newSession(params: NewSessionParams): Promise<AcpSession>;
  /**
   * Protocol-driven authentication (#5.2): sends `authenticate` with
   * `{methodId}` and resolves on the empty-object result. `methodId` must
   * name a **default (`agent`-type)** entry of `authMethods`.
   *
   * Rejects without sending anything for an id the agent never advertised,
   * and -- the case that matters -- for a `type: "terminal"` id, which
   * #5.3 says a client MUST NOT put in an `authenticate` request. Both are
   * caller bugs detectable locally, and a terminal id in particular routes
   * a credential-bearing request down a flow the agent never offered, so
   * neither is worth a round trip to discover.
   */
  authenticate(methodId: string): Promise<void>;
  /**
   * Ends the authenticated state (#5.4). Rejects without sending anything
   * unless `agentCapabilities.auth.logout` was advertised at initialize.
   *
   * Per #5.4 the fate of already-running sessions is explicitly undefined
   * -- agents "may terminate them, keep them running, or return
   * auth_required errors" -- so this deliberately does not touch the
   * `sessions` map. Expect -32000 on any in-flight session afterwards and
   * re-authenticate; this client cannot know which agents do which.
   */
  logout(): Promise<void>;
  /**
   * Resolves #5.3 steps 1-2 for a `type: "terminal"` auth method: the
   * command from **this client's own** launch configuration (the spec is
   * explicit that "the descriptor cannot provide a command"), the method's
   * `args` appended to the base args, and its `env` merged over the base
   * environment.
   *
   * Pure: it launches nothing. Steps 3-4 -- presenting the terminal and
   * reconnecting -- are the host's, since neither can be done from a
   * transport client without a UI. Throws for an unknown or non-terminal
   * method id.
   */
  terminalAuthLaunch(methodId: string): TerminalAuthLaunch;
  /** Ends the connection and reaps the agent subprocess. Idempotent; never rejects. */
  close(): Promise<void>;
}

/**
 * Spawns the agent, performs `initialize` and version negotiation (#4), and
 * resolves with a ready-to-use client. Rejects (without hanging, and
 * without leaking the subprocess -- see file header, point 4) if the agent
 * exits before answering, sends unparseable data, or negotiates a
 * `protocolVersion` this client does not support (#4.3: "the Client SHOULD
 * close the connection").
 */
export async function connect(options: ConnectOptions): Promise<AcpClient> {
  const transport = new AcpTransport({ command: options.command, args: options.args, env: options.env, cwd: options.cwd });
  const sessions = new Map<SessionId, AcpSessionImpl>();
  // sessionId -> updates that arrived for it before newSession() finished
  // registering it in `sessions` -- see file header, point 5. Flushed (and
  // its entry removed) by newSession() itself the moment it registers that
  // sessionId; an id that never gets registered (e.g. a stray/unrelated
  // notification, framing.test.ts's "fragmented" case) simply sits here
  // harmlessly for the life of the connection rather than being routed
  // anywhere.
  const pendingSessionUpdates = new Map<SessionId, SessionUpdate[]>();

  transport.onNotification((method, params) => {
    if (method !== 'session/update') return; // unrecognized notifications: ignore, per #19 ("implementations SHOULD ignore" unknown notifications -- unlike unknown requests, which get -32601 below)
    const payload = params as { sessionId?: unknown; update?: unknown };
    if (typeof payload.sessionId !== 'string' || typeof payload.update !== 'object' || payload.update === null) return;
    const update = payload.update as SessionUpdate;
    const session = sessions.get(payload.sessionId);
    if (session) {
      session.handleUpdate(update);
      return;
    }
    // Not registered (yet, or ever) -- buffer by sessionId rather than the
    // prior behavior of silently discarding it via optional chaining.
    let queued = pendingSessionUpdates.get(payload.sessionId);
    if (!queued) {
      queued = [];
      pendingSessionUpdates.set(payload.sessionId, queued);
    }
    queued.push(update);
  });

  transport.onRequest((method, params, id) => {
    if (method === 'session/request_permission') {
      const payload = params as Partial<RequestPermissionParams> | undefined;
      if (!payload || typeof payload.sessionId !== 'string' || !Array.isArray(payload.options) || typeof payload.toolCall !== 'object' || payload.toolCall === null) {
        transport.respondError(id, { code: -32602, message: 'invalid params for session/request_permission' });
        return;
      }
      const session = sessions.get(payload.sessionId);
      if (!session) {
        transport.respondError(id, { code: -32602, message: `session/request_permission for unknown session ${payload.sessionId}` });
        return;
      }
      session.handlePermissionRequest(payload as RequestPermissionParams, id, options.onPermissionRequest);
      return;
    }
    // #19: an unrecognized *request* MUST get a response, never be silently
    // dropped -- this client advertises no fs/*/terminal/*/elicitation
    // capabilities (see protocol.ts's scope note), so a spec-compliant
    // agent should never send one, but a well-behaved peer answers anyway
    // rather than leaving the agent's request hanging forever.
    transport.respondError(id, { code: -32601, message: `method not found: ${method}` });
  });

  try {
    const raw = (await withOptionalTimeout(
      transport.request('initialize', buildInitializeParams(options.clientInfo)),
      options.initializeTimeoutMs,
      () => new Error(`initialize did not respond within ${options.initializeTimeoutMs}ms`),
    )) as InitializeResult;
    if (raw.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `agent negotiated protocol version ${raw.protocolVersion}, but this client only supports version ${PROTOCOL_VERSION} (acp-protocol.md #4.3: "the Client SHOULD close the connection and inform the user")`,
      );
    }
    return new AcpClientImpl(
      transport,
      sessions,
      pendingSessionUpdates,
      {
        protocolVersion: raw.protocolVersion,
        authMethods: raw.authMethods ?? [],
        agentInfo: raw.agentInfo ?? undefined,
        agentCapabilities: normalizeAgentCapabilities(raw.agentCapabilities),
      },
      {
        command: options.command,
        args: options.args ?? [],
        // Same merge transport.ts spawns with, so a #5.3 relaunch
        // reproduces this connection rather than a bare subset of it.
        env: { ...(process.env as Record<string, string>), ...(options.env ?? {}) },
      },
    );
  } catch (err) {
    // Fire-and-forget: see file header, point 4. transport.close() is
    // documented to never reject, so this cannot produce an unhandled
    // rejection.
    void transport.close();
    throw err;
  }
}

function buildInitializeParams(clientInfo: Implementation | undefined): { protocolVersion: ProtocolVersion; clientCapabilities: ClientCapabilities; clientInfo: Implementation } {
  return {
    protocolVersion: PROTOCOL_VERSION,
    // Explicit `false`s, not an omitted object: this client implements none
    // of fs/*, terminal/*, and must not let the agent infer otherwise
    // (lifecycle.test.ts asserts on exactly this).
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: clientInfo ?? DEFAULT_CLIENT_INFO,
  };
}

/** Applies every #4.4 default and flattens the wire's presence-typed fields to booleans (see protocol.ts's AgentCapabilities doc comment). */
function normalizeAgentCapabilities(raw: InitializeResult['agentCapabilities']): AgentCapabilities {
  const sessionCaps = raw?.sessionCapabilities;
  return {
    loadSession: raw?.loadSession ?? false,
    promptCapabilities: {
      image: raw?.promptCapabilities?.image ?? false,
      audio: raw?.promptCapabilities?.audio ?? false,
      embeddedContext: raw?.promptCapabilities?.embeddedContext ?? false,
    },
    mcpCapabilities: {
      http: raw?.mcpCapabilities?.http ?? false,
      sse: raw?.mcpCapabilities?.sse ?? false,
    },
    sessionCapabilities: {
      resume: sessionCaps?.resume != null,
      close: sessionCaps?.close != null,
      delete: sessionCaps?.delete != null,
      list: sessionCaps?.list != null,
      additionalDirectories: sessionCaps?.additionalDirectories != null,
    },
    auth: { logout: raw?.auth?.logout != null },
  };
}

// ---- turn bookkeeping -------------------------------------------------------
//
// A small push queue plus a one-shot settlement, shared between whatever
// pushes updates/settles the turn (the transport's notification handler,
// and the `.then()` on the underlying session/prompt request) and whatever
// drains it (the async generator prompt() returns). See file header point 2
// for why ordering is safe without any explicit locking.

type TurnOutcome = { ok: true; result: PromptTurnResult } | { ok: false; error: Error };
type TurnStep = { kind: 'update'; update: SessionUpdate } | { kind: 'done'; outcome: TurnOutcome };

class TurnState {
  private readonly queue: SessionUpdate[] = [];
  private outcome: TurnOutcome | undefined;
  private waiter: (() => void) | undefined;

  pushUpdate(update: SessionUpdate): void {
    this.queue.push(update);
    this.wake();
  }

  /** First settle wins; a stray double-settle (there should never be one) is silently ignored rather than corrupting an already-delivered outcome. */
  settle(outcome: TurnOutcome): void {
    if (this.outcome) return;
    this.outcome = outcome;
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  /** Resolves to the next queued update, or the terminal outcome once the queue is empty and the turn has settled -- queued updates always win, however late they arrive relative to settle(). */
  async next(): Promise<TurnStep> {
    for (;;) {
      if (this.queue.length > 0) {
        return { kind: 'update', update: this.queue.shift()! };
      }
      if (this.outcome) {
        return { kind: 'done', outcome: this.outcome };
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function normalizePromptInput(input: PromptInput): ContentBlock[] {
  return typeof input === 'string' ? [{ type: 'text', text: input }] : input;
}

/** #7.2: promptCapabilities gate what THIS CLIENT may send, never what an agent may emit (that asymmetry is #23 item 6). Checked at send time, before the request goes out. */
function assertPromptBlocksAllowed(blocks: ContentBlock[], caps: AgentCapabilities['promptCapabilities']): void {
  for (const block of blocks) {
    if (block.type === 'image' && !caps.image) {
      throw new Error('cannot send an image content block: the agent did not advertise promptCapabilities.image (acp-protocol.md #7.2)');
    }
    if (block.type === 'audio' && !caps.audio) {
      throw new Error('cannot send an audio content block: the agent did not advertise promptCapabilities.audio (acp-protocol.md #7.2)');
    }
    if (block.type === 'resource' && !caps.embeddedContext) {
      throw new Error('cannot send an embedded resource content block: the agent did not advertise promptCapabilities.embeddedContext (acp-protocol.md #7.2)');
    }
  }
}

// ---- session ----------------------------------------------------------------

class AcpSessionImpl implements AcpSession {
  readonly sessionId: SessionId;
  private readonly transport: AcpTransport;
  private readonly promptCapabilities: AgentCapabilities['promptCapabilities'];
  private activeTurn: TurnState | undefined;
  private readonly pendingPermissions = new Map<RequestId, { cancel: () => void }>();
  // Out-of-turn `session/update`s (file header, point 5), held until
  // onUpdate() registers a listener to flush them into. Unbounded on
  // purpose: the four variants that ever land here (available_commands_
  // update, session_info_update, current_mode_update, config_option_update)
  // are small, infrequent, agent-unilateral control-plane messages, not the
  // high-volume agent_message_chunk stream -- that one is always turn-scoped
  // and drained via prompt()'s generator instead, never through this path.
  private readonly outOfTurnUpdates: SessionUpdate[] = [];
  private updateListener: ((update: SessionUpdate) => void) | undefined;

  constructor(sessionId: SessionId, transport: AcpTransport, promptCapabilities: AgentCapabilities['promptCapabilities']) {
    this.sessionId = sessionId;
    this.transport = transport;
    this.promptCapabilities = promptCapabilities;
  }

  prompt(input: PromptInput): AsyncGenerator<SessionUpdate, PromptTurnResult, void> {
    if (this.activeTurn) {
      throw new Error(`session ${this.sessionId} already has a prompt turn in flight`);
    }
    const blocks = normalizePromptInput(input);
    assertPromptBlocksAllowed(blocks, this.promptCapabilities);

    // Eager, synchronous send -- see file header, point 1. Everything from
    // here down to `return this.drainTurn(turn)` runs before prompt()
    // returns to the caller; only the *draining* is lazy.
    const turn = new TurnState();
    this.activeTurn = turn;
    (this.transport.request('session/prompt', { sessionId: this.sessionId, prompt: blocks }) as Promise<PromptTurnResult>).then(
      (result) => turn.settle({ ok: true, result }),
      (err: unknown) => turn.settle({ ok: false, error: toError(err) }),
    );

    return this.drainTurn(turn);
  }

  private async *drainTurn(turn: TurnState): AsyncGenerator<SessionUpdate, PromptTurnResult, void> {
    try {
      for (;;) {
        const step = await turn.next();
        if (step.kind === 'update') {
          yield step.update;
          continue;
        }
        if (!step.outcome.ok) throw step.outcome.error;
        return step.outcome.result;
      }
    } finally {
      if (this.activeTurn === turn) this.activeTurn = undefined;
    }
  }

  cancel(): void {
    if (!this.activeTurn) return;
    this.transport.notify('session/cancel', { sessionId: this.sessionId });
    // #14.1, unconditionally the client's own obligation -- see file header
    // point 3. Snapshot to an array first: cancel() below mutates
    // pendingPermissions (each entry deletes itself once answered), and
    // iterating a Map while deleting the in-progress entry is well-defined
    // but not worth relying on here.
    for (const pending of [...this.pendingPermissions.values()]) pending.cancel();
  }

  /**
   * Called by connect()'s central `session/update` router. Routed by
   * priority: an in-flight turn's queue always wins (matches every existing
   * turn-draining behavior exactly as before); failing that, a registered
   * onUpdate() listener; failing that, buffered for whenever one is
   * eventually registered (file header, point 5) -- never silently dropped.
   */
  handleUpdate(update: SessionUpdate): void {
    if (this.activeTurn) {
      this.activeTurn.pushUpdate(update);
      return;
    }
    if (this.updateListener) {
      this.updateListener(update);
      return;
    }
    this.outOfTurnUpdates.push(update);
  }

  onUpdate(listener: (update: SessionUpdate) => void): void {
    this.updateListener = listener;
    if (this.outOfTurnUpdates.length === 0) return;
    const queued = this.outOfTurnUpdates.splice(0);
    for (const update of queued) listener(update);
  }

  /**
   * Answers one agent-initiated `session/request_permission`. Registers a
   * cancel handle *synchronously*, before ever invoking the (possibly slow,
   * possibly never-resolving) policy callback, so cancel() can always find
   * and answer it immediately regardless of what that callback is doing.
   * `respondOnce` guards against answering the same request twice, whether
   * cancel() wins the race or the policy callback eventually does.
   */
  handlePermissionRequest(params: RequestPermissionParams, id: RequestId, handler: PermissionRequestHandler): void {
    let settled = false;
    const respondOnce = (outcome: RequestPermissionOutcome): void => {
      if (settled) return;
      settled = true;
      this.pendingPermissions.delete(id);
      this.transport.respond(id, { outcome });
    };
    this.pendingPermissions.set(id, { cancel: () => respondOnce({ outcome: 'cancelled' }) });

    Promise.resolve()
      .then(() => handler(params))
      .then(respondOnce)
      .catch((err: unknown) => {
        if (settled) return;
        settled = true;
        this.pendingPermissions.delete(id);
        this.transport.respondError(id, { code: -32603, message: `onPermissionRequest threw: ${toError(err).message}` });
      });
  }
}

// ---- client -------------------------------------------------------------

interface NormalizedInitInfo {
  protocolVersion: ProtocolVersion;
  authMethods: AuthMethod[];
  agentInfo: Implementation | undefined;
  agentCapabilities: AgentCapabilities;
}

/**
 * The connection's own launch configuration, retained solely so
 * terminalAuthLaunch() can satisfy #5.3's "the Client derives the command
 * from its own Agent configuration". Mirrors what transport.ts actually
 * spawned, env merge included, so a relaunch reproduces this connection.
 */
interface BaseLaunchConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

class AcpClientImpl implements AcpClient {
  readonly protocolVersion: ProtocolVersion;
  readonly authMethods: AuthMethod[];
  readonly agentInfo: Implementation | undefined;
  readonly agentCapabilities: AgentCapabilities;
  private readonly transport: AcpTransport;
  private readonly sessions: Map<SessionId, AcpSessionImpl>;
  private readonly pendingSessionUpdates: Map<SessionId, SessionUpdate[]>;
  private readonly launch: BaseLaunchConfig;

  constructor(
    transport: AcpTransport,
    sessions: Map<SessionId, AcpSessionImpl>,
    pendingSessionUpdates: Map<SessionId, SessionUpdate[]>,
    init: NormalizedInitInfo,
    launch: BaseLaunchConfig,
  ) {
    this.transport = transport;
    this.sessions = sessions;
    this.pendingSessionUpdates = pendingSessionUpdates;
    this.launch = launch;
    this.protocolVersion = init.protocolVersion;
    this.authMethods = init.authMethods;
    this.agentInfo = init.agentInfo;
    this.agentCapabilities = init.agentCapabilities;
  }

  /** #5.2; see the AcpClient interface for why both refusals are local. */
  async authenticate(methodId: string): Promise<void> {
    const method = this.authMethods.find((m) => m.id === methodId);
    if (!method) {
      const known = this.authMethods.map((m) => m.id).join(', ') || '<none>';
      throw new Error(
        `authenticate: the agent did not advertise an auth method with id "${methodId}" (advertised: ${known}) (acp-protocol.md #5.1)`,
      );
    }
    if (method.type === 'terminal') {
      throw new Error(
        `authenticate: "${methodId}" is a terminal-type auth method; acp-protocol.md #5.3 says the Client MUST NOT send an authenticate request for it -- use terminalAuthLaunch("${methodId}") and run that flow instead`,
      );
    }
    // #5.2's success result is an empty object carrying nothing to read.
    await this.transport.request('authenticate', { methodId });
  }

  /** #5.4. */
  async logout(): Promise<void> {
    if (!this.agentCapabilities.auth.logout) {
      throw new Error(
        'logout: the agent did not advertise agentCapabilities.auth.logout at initialize (acp-protocol.md #5.4 says to call it only if it did)',
      );
    }
    // Empty object, not omitted: #5.4 shows `"params": {}` on the wire.
    await this.transport.request('logout', {});
  }

  /** #5.3 steps 1-2 only -- a description, never a launch. */
  terminalAuthLaunch(methodId: string): TerminalAuthLaunch {
    const method = this.authMethods.find((m) => m.id === methodId);
    if (!method) {
      throw new Error(`terminalAuthLaunch: no auth method with id "${methodId}" was advertised (acp-protocol.md #5.1)`);
    }
    if (method.type !== 'terminal') {
      throw new Error(
        `terminalAuthLaunch: "${methodId}" is an agent-type auth method, which has no terminal launch configuration -- call authenticate("${methodId}") instead (acp-protocol.md #5.2)`,
      );
    }
    return {
      command: this.launch.command,
      // "Appends the method's args" (#5.3 step 2) -- appended to the base
      // args, never substituted for them, or the relaunch would lose
      // whatever selects the agent program in the first place.
      args: [...this.launch.args, ...(method.args ?? [])],
      env: { ...this.launch.env, ...(method.env ?? {}) },
    };
  }

  async newSession(params: NewSessionParams): Promise<AcpSession> {
    if (params.additionalDirectories && !this.agentCapabilities.sessionCapabilities.additionalDirectories) {
      throw new Error('newSession: additionalDirectories was set but the agent did not advertise sessionCapabilities.additionalDirectories (acp-protocol.md #6.7)');
    }
    const wireParams: { cwd: string; mcpServers: McpServer[]; additionalDirectories?: string[] } = {
      cwd: params.cwd,
      // Required on the wire, never omitted, even when the caller left it
      // out (#6.1; framing.test.ts asserts this exact default).
      mcpServers: params.mcpServers ?? [],
    };
    if (params.additionalDirectories) wireParams.additionalDirectories = params.additionalDirectories;

    const result = (await this.transport.request('session/new', wireParams)) as { sessionId?: unknown };
    const sessionId = result?.sessionId;
    // #6.1's result is `{sessionId: string}`; an agent that omits it, or
    // names the field differently, must fail loudly here rather than hand
    // back a session whose id is `undefined` -- that value would otherwise
    // poison `sessions` (keyed by it) and go out on every subsequent
    // session/prompt as a *missing* `sessionId` property on the wire
    // (JSON.stringify drops an undefined value silently), which is worse
    // than a thrown error: it looks like a malformed request from a
    // perfectly healthy client.
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error(`session/new: expected a non-empty string "sessionId" in the result, got ${JSON.stringify(sessionId)} (acp-protocol.md #6.1)`);
    }
    const session = new AcpSessionImpl(sessionId, this.transport, this.agentCapabilities.promptCapabilities);
    this.sessions.set(sessionId, session);
    // Flush anything that arrived for this exact sessionId before this
    // `await` returned -- see file header, point 5.
    const queued = this.pendingSessionUpdates.get(sessionId);
    if (queued) {
      this.pendingSessionUpdates.delete(sessionId);
      for (const update of queued) session.handleUpdate(update);
    }
    return session;
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}
