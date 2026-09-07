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
} as const;

export type ScenarioName = (typeof SCENARIOS)[keyof typeof SCENARIOS];
