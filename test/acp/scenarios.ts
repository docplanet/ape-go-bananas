// Scenario vocabulary shared between mock-agent.ts (the agent side of the
// wire) and the *.test.ts files (the client-side assertions), so a typo in
// a scenario name can't silently desync what a test asks for from what the
// mock actually implements -- one string literal, one place.
//
// Pure constants only, no side effects: this file is inert if node --test's
// bare discovery imports it as a candidate test file in its own right,
// which it will, since it lives under test/ -- see mock-agent.ts's header
// comment for why that distinction matters here.

export const SCENARIO_FLAG = '--scenario=';

export const SCENARIOS = {
  /**
   * initialize + session/new succeed; session/prompt streams a plan update,
   * an agent_message_chunk echoing the input, and a usage_update, then
   * resolves end_turn. Tracks a per-session turn counter so repeated
   * prompts on the same session can be told apart (multi-turn coverage).
   */
  HAPPY_PATH: 'happy-path',
  /**
   * session/prompt announces a pending tool_call, sends
   * session/request_permission, and reacts to whatever outcome comes back:
   * an allow-once option runs the tool to completion; a reject-once option
   * fails it; a cancelled outcome resolves the turn with stopReason
   * "cancelled" (docs/research/acp-protocol.md #14.1's cascading-cancel
   * obligation is exercised this way, not via a separate scenario).
   */
  TOOL_PERMISSION: 'tool-permission',
  /**
   * session/prompt streams one update, then never responds on its own --
   * only a session/cancel notification (or process teardown) ends it. On
   * cancel it sends one more update before resolving stopReason
   * "cancelled", to exercise the "still accept updates sent after cancel"
   * rule (#14.1).
   */
  CANCEL_HANG: 'cancel-hang',
  /** session/prompt resolves with a JSON-RPC error instead of a result. */
  ERROR_RESPONSE: 'error-response',
  /** session/prompt writes one line of invalid JSON to stdout, then goes quiet. */
  MALFORMED_JSON: 'malformed-json',
  /** the process exits before ever reading/answering initialize. */
  EXIT_BEFORE_INIT: 'exit-before-init',
  /** session/prompt streams one update, then the process exits without responding. */
  EXIT_MID_TURN: 'exit-mid-turn',
  /**
   * initialize responds with protocolVersion 999 -- a version the client
   * cannot have asked for -- to exercise the negotiation-failure path in
   * docs/research/acp-protocol.md #4.3 ("the Client SHOULD close the
   * connection").
   */
  PROTOCOL_MISMATCH: 'protocol-mismatch',
  /**
   * Auth-gated, `agent`-type only (#5.1, #5.2). initialize advertises two
   * default-variant auth methods (no `type` field) and
   * `agentCapabilities.auth.logout`, so `logout` is legal here (#5.4).
   * `session/new` fails with the -32000 "Authentication required" code
   * (#15) until a successful `authenticate`, and `logout` re-arms that
   * gate -- which is what lets one test prove authenticate() actually
   * changed the agent's state rather than merely returning without error.
   */
  AUTH_AGENT: 'auth-agent',
  /**
   * Auth-gated, advertising one `type: "terminal"` method alongside one
   * default `agent` method (#5.1, #5.3), and deliberately NOT advertising
   * `agentCapabilities.auth.logout`. Two obligations are checked against
   * this scenario: the client must never put the terminal method's id on
   * the wire in an `authenticate` request, and it must refuse `logout`
   * locally rather than sending an unsupported method. If an `authenticate`
   * for the terminal id ever does arrive, the mock answers -32602 and
   * records the frame, so the violation shows up in the log as well as in
   * the response.
   */
  AUTH_TERMINAL: 'auth-terminal',
  /**
   * initialize advertises a well-formed auth method alongside entries that
   * are not: a missing `name`, a non-string `id`, and a bare `null`. #5.1
   * requires `id` and `name`, so a client that casts instead of validating
   * hands callers half-formed objects and matches ids against junk.
   */
  AUTH_MALFORMED: 'auth-malformed',
  /**
   * initialize answers with the **presence-typed** `agentCapabilities`
   * shape (#4.4): `sessionCapabilities.*` and `auth.logout` as empty
   * objects rather than booleans, including the `fork` and `subagents`
   * keys. This is not invented -- it is the shape captured verbatim off
   * the wire from @agentclientprotocol/claude-agent-acp 0.75.1, which is
   * the only reason anyone knew `{}` was the real representation.
   *
   * Exists because a normalizer that expected booleans would read every
   * one of these as falsy, silently conclude the agent supports nothing,
   * and still pass every other test in this directory.
   */
  CAPS_PRESENCE: 'caps-presence',
  /**
   * Session Modes (#17.1). `session/new` reports a `modes` block shaped
   * like the one captured from claude-agent-acp 0.75.1, `session/set_mode`
   * is answered `{}` and followed by a `current_mode_update`, and a prompt
   * turn makes the agent switch mode UNILATERALLY, which #17.1 explicitly
   * permits.
   *
   * The two notifications deliberately disagree on spelling, because the
   * spec does: #8's catalog table names the field `currentModeId` while
   * #17.1's own worked example renders it `modeId`, and neither excerpt is
   * marked as the erroneous one. set_mode's follow-up uses `currentModeId`;
   * the unilateral switch uses `modeId`. A client that reads only one of
   * them silently stops tracking the mode -- and mode is what decides
   * whether the agent asks permission before touching files at all.
   */
  SESSION_MODES: 'session-modes',
  /**
   * Session Config Options (#17.2), the mechanism the spec calls current
   * and says will replace Session Modes. `session/new` reports BOTH
   * `configOptions` and `modes` -- which is what a real adapter does
   * during the transition -- so the precedence rule ("use configOptions
   * exclusively and ignore modes") has something to be tested against.
   *
   * `session/set_config_option` answers with the FULL option state, not
   * the single option that changed, and this mock uses that to make a
   * dependent change: setting `mode` to `plan` also moves `model`. A
   * client that patches only the field it just set will miss it, which is
   * precisely the bug #17.2's "allows Agents to reflect dependent changes"
   * sentence exists to prevent.
   */
  CONFIG_OPTIONS: 'config-options',
  /**
   * An agent that spells its presence-typed capabilities as literal
   * booleans -- `sessionCapabilities: {resume: false, ...}`, `auth:
   * {logout: false}` -- instead of #4.4's omit-or-`{}` convention.
   *
   * No agent observed does this, which is exactly why it is worth pinning:
   * a naive presence check (`!= null`) reads `false` as PRESENT, and the
   * client concludes the agent supports everything it explicitly said it
   * does not. The failure is silent and inverted, and there is no real
   * agent today to catch it.
   */
  CAPS_LITERAL_FALSE: 'caps-literal-false',
  /**
   * Capabilities spelled as explicit `null`. #4.4's rule is "omitted **or**
   * `null` means unsupported" and only the omitted half was ever asserted;
   * a presence check written `!== undefined` would pass every existing test
   * and read `null` as supported. This pins the other half.
   */
  CAPS_EXPLICIT_NULL: 'caps-explicit-null',
  // ---- added for the sidecar bridge oracle (test/sidecar/agent-*.test.ts,
  // written from docs/research/agent-protocol.md §2/§3/§5). Handled in
  // mock-agent.ts's handleSidecarScenario(); nothing above is touched.
  /**
   * `session/new` fails with the auth-required error agent-protocol.md §2
   * describes: code -32000, message "Authentication required", and
   * `data.reason: "auth_required"`. The `data.reason` field is INVENTED
   * from the spec's own note ("`data.reason` or message matching /auth/i --
   * record the exact shape the first time a real agent produces it"); no
   * real agent has been observed sending it yet. initialize advertises one
   * agent-type method (`agent-login`) so the bridge has something to
   * report as `authMethods`, and a successful `authenticate` for it lifts
   * the gate so an agent-type `agent/login` can be driven end to end.
   */
  AUTH_REQUIRED_SESSION: 'auth-required-session',
  /**
   * A prompt turn that streams exactly one update of each of the six kinds
   * agent-protocol.md §2 lists for `agent/update` -- UPDATE_KINDS_SEQUENCE
   * below, in that order -- then resolves end_turn. Exists so the bridge's
   * relay can be checked kind by kind, deep-equal, in order.
   */
  UPDATE_KINDS: 'update-kinds',
  /**
   * Impersonates the Claude adapter's auth surface from
   * docs/research/claude-adapter-auth.md §2-§3: initialize returns the two
   * terminal-type methods (`claude-ai-login`, `console-login`, args
   * verbatim, no `_meta` because only the spec capability is advertised),
   * and is followed by `_auth/status_update { authStatus }` -- the status
   * read from env ACP_MOCK_AUTH_STATUS (JSON) or, absent that,
   * `{ kind: "none", label: "Not logged in" }`. `session/new` succeeds
   * regardless of sign-in state (§3), with a session id that embeds the
   * process pid so two connections never collide. A prompt echoes one
   * message chunk and ends the turn.
   */
  CLAUDE_AUTH: 'claude-auth',
} as const;

/** The six §2 update kinds UPDATE_KINDS streams, in wire order (sessionId is added by the mock). */
export const UPDATE_KINDS_SEQUENCE: ReadonlyArray<Record<string, unknown>> = [
  { sessionUpdate: 'agent_message_chunk', messageId: 'msg_k1', content: { type: 'text', text: 'Reading the deck. ' } },
  { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Seven notes, all cloze.' } },
  { sessionUpdate: 'tool_call', toolCallId: 'call_k1', title: 'Reading deck.json', kind: 'read', status: 'pending', locations: [{ path: '/course/deck.json' }] },
  { sessionUpdate: 'tool_call_update', toolCallId: 'call_k1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '{"notes":[]}' } }] },
  { sessionUpdate: 'usage_update', used: 1234, size: 200000 },
  { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review the deck', input: null }] },
];

/** The `_auth/status_update` payload CLAUDE_AUTH sends when ACP_MOCK_AUTH_STATUS is unset (claude-adapter-auth.md §3, verbatim). */
export const CLAUDE_AUTH_SIGNED_OUT = { kind: 'none', label: 'Not logged in' } as const;

/** claude-adapter-auth.md §2's two methods, as they come back with the spec capability alone (no `_meta`). */
export const CLAUDE_AUTH_METHODS: ReadonlyArray<Record<string, unknown>> = [
  { id: 'claude-ai-login', name: 'Claude Subscription', description: 'Use Claude subscription ', type: 'terminal', args: ['--cli', 'auth', 'login', '--claudeai'] },
  { id: 'console-login', name: 'Anthropic Console', description: 'Use Anthropic Console (API usage billing)', type: 'terminal', args: ['--cli', 'auth', 'login', '--console'] },
];

export type ScenarioName = (typeof SCENARIOS)[keyof typeof SCENARIOS];
