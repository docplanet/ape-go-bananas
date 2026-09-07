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
} as const;

export type ScenarioName = (typeof SCENARIOS)[keyof typeof SCENARIOS];
