// ACP v1 message and content shapes: the payloads that ride on top of the
// generic JSON-RPC envelope framing.ts/transport.ts already handle. Types
// and constants only -- no I/O, no method dispatch, nothing stateful (see
// this file's owning task). Every shape below is traced to
// docs/research/acp-protocol.md; section numbers are cited inline so a
// disagreement can be checked against the source rather than trusted from
// memory.
//
// Scope note: this project's client never advertises fs/*, terminal/*,
// elicitation, or session config-options/modes support (session.ts's
// ClientCapabilities literal leaves them all unset, which per #4.4 means
// "unsupported"), so those method families are typed only as far as they
// appear *passively* in the `session/update` catalog (#8) -- e.g.
// `config_option_update`'s payload shape -- never as full request/response
// pairs this client can send. That is a deliberate scope boundary, not an
// oversight: a spec-compliant agent will never call a client method the
// client didn't advertise (#4.4), and session.ts's generic "unrecognized
// request -> -32601" fallback (#19) handles the rest safely either way.

// ---- version & identity (#4) ------------------------------------------

/** `ProtocolVersion` per the schema: `integer, uint16, 0-65535`. */
export type ProtocolVersion = number;

/** The only wire version this client speaks. See #1: v1 is stable, v2 is a draft. */
export const PROTOCOL_VERSION: ProtocolVersion = 1;

/** Opaque session identifier minted by the agent (#6.1). Never parse it. */
export type SessionId = string;

/** `Implementation` shape, used for both `clientInfo` and `agentInfo` (#4.2). */
export interface Implementation {
  name: string;
  title?: string | null;
  version: string;
}

/** Sent as `clientInfo` unless a caller overrides it via `ConnectOptions.clientInfo`. */
export const DEFAULT_CLIENT_INFO: Implementation = { name: 'ape-acp-client', version: '0.1.0' };

// ---- capabilities (#4.4) ------------------------------------------------
//
// `AgentCapabilities` below is this client's *normalized* view of the
// initialize response, not the raw wire shape: `promptCapabilities.*` and
// `mcpCapabilities.*` are already plain booleans on the wire, but
// `sessionCapabilities.*` and `auth.logout` are "presence-typed" --
// omitted/null means unsupported, an empty object `{}` means supported
// (#4.4's own stated convention, uniform across every such field). This
// type flattens that presence check to a plain boolean for all of them, so
// callers never have to know which representation a given field uses on
// the wire. session.ts's normalizeAgentCapabilities() does the flattening;
// nothing here performs it -- types and constants only.

export interface FileSystemCapabilities {
  readTextFile: boolean;
  writeTextFile: boolean;
}

/** What this client sends as `clientCapabilities` (#4.1). Deliberately narrow: only the two families this client can ever populate truthfully. */
export interface ClientCapabilities {
  fs: FileSystemCapabilities;
  terminal: boolean;
}

export interface PromptCapabilities {
  image: boolean;
  audio: boolean;
  embeddedContext: boolean;
}

export interface McpCapabilities {
  http: boolean;
  sse: boolean;
}

/**
 * Normalized (boolean-flattened) form of the wire's presence-typed
 * `sessionCapabilities.*` fields.
 *
 * `fork` and `subagents` are here because a real agent advertises them:
 * @agentclientprotocol/claude-agent-acp 0.75.1 sends all seven. They were
 * previously dropped on the floor -- normalized away into a five-key object
 * -- so a caller had no way to see capabilities the agent genuinely
 * offered. Not covered by the read sections of the spec, so they are
 * modeled from the observed wire rather than from #4.4's prose.
 */
export interface SessionCapabilities {
  resume: boolean;
  close: boolean;
  delete: boolean;
  list: boolean;
  additionalDirectories: boolean;
  fork: boolean;
  subagents: boolean;
}

/** Normalized `agentCapabilities` from the initialize response, with every documented default (#4.4) already applied. */
export interface AgentCapabilities {
  loadSession: boolean;
  promptCapabilities: PromptCapabilities;
  mcpCapabilities: McpCapabilities;
  sessionCapabilities: SessionCapabilities;
  auth: { logout: boolean };
}

/** The raw `initialize` result shape as it actually arrives on the wire, before normalization -- every level genuinely optional per #4.4. */
export interface InitializeResult {
  protocolVersion: ProtocolVersion;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: Partial<PromptCapabilities>;
    mcpCapabilities?: Partial<McpCapabilities>;
    // Presence-typed on the wire (object-or-null): the *value*, when
    // present, is conventionally `{}` and carries no fields this client
    // reads -- only whether the key is there (and non-null) matters (#4.4).
    sessionCapabilities?: Partial<
      Record<'resume' | 'close' | 'delete' | 'list' | 'additionalDirectories' | 'fork' | 'subagents', unknown>
    >;
    auth?: { logout?: unknown };
  };
  agentInfo?: Implementation | null;
  authMethods?: AuthMethod[];
}

// ---- authentication (#5) -------------------------------------------------
//
// `authenticate` (#5.2) and `logout` (#5.4) ARE implemented, on AcpClient in
// session.ts. What is deliberately NOT implemented is the terminal-type
// flow's interactive half (#5.3 steps 3-4: "presents the terminal to the
// user and waits for the process to exit", then "reconnects and
// reinitializes") -- that is a UI plus a reconnect loop, neither of which
// belongs in a transport client. This file's TerminalAuthLaunch and
// session.ts's terminalAuthLaunch() cover steps 1-2 (derive the command,
// append args, apply env) so a host can drive the rest itself.
//
// Consequence worth knowing before reading the terminal guard as a live
// code path: buildInitializeParams() does not advertise
// `clientCapabilities.auth.terminal`, and #5.1 says an agent may only offer
// a terminal method to a client that did. Claiming that capability while
// unable to present a terminal would be a lie, so the guard in
// authenticate() is defensive coding against a NON-compliant agent, not a
// path a spec-following one can reach.

/** Default variant when `type` is absent (#5.1); its `id` is what `authenticate` takes. */
export interface AgentAuthMethod {
  type?: undefined;
  id: string;
  name: string;
  description?: string | null;
}

/** `type: "terminal"` variant (#5.1, #5.3). Its `id` must never be sent to `authenticate`. */
export interface TerminalAuthMethod {
  type: 'terminal';
  id: string;
  name: string;
  description?: string | null;
  args?: string[];
  env?: Record<string, string>;
}

export type AuthMethod = AgentAuthMethod | TerminalAuthMethod;

/**
 * A resolved launch configuration for #5.3 steps 1-2, as returned by
 * `AcpClient.terminalAuthLaunch()`. Describing the relaunch is all this
 * client does: it never spawns the process, presents a terminal, or
 * reconnects afterwards (steps 3-4), which is why this is a plain value
 * rather than a method that performs anything.
 *
 * `env` is the connection's own effective environment with the method's
 * `env` merged over it, matching the transport's `{...process.env,
 * ...options.env}` -- #5.3's "base launch configuration", not a bare copy
 * of the method's own additions.
 */
export interface TerminalAuthLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

// ---- content blocks (#9) -- five variants, all pass-through -------------
//
// Per #23 item 6: promptCapabilities gates what THIS CLIENT may put into a
// prompt (session.ts enforces that on send); it does not gate what an agent
// may emit in its own output. Every variant here must therefore be typed
// and renderable regardless of negotiated capabilities.

/** MCP-borrowed display hints; `audience`'s exact value enum is not spelled out in the read sections of the spec, so it is left loosely typed rather than guessed. */
export interface Annotations {
  audience?: string[];
  lastModified?: string;
  priority?: number;
}

export interface TextContentBlock {
  type: 'text';
  text: string;
  annotations?: Annotations | null;
}

/** Requires `promptCapabilities.image` when the *client* sends one (#9); ungated on receipt (#23 item 6). */
export interface ImageContentBlock {
  type: 'image';
  data: string;
  mimeType: string;
  uri?: string | null;
  annotations?: Annotations | null;
}

/** Requires `promptCapabilities.audio` when the *client* sends one (#9); ungated on receipt. */
export interface AudioContentBlock {
  type: 'audio';
  data: string;
  mimeType: string;
  annotations?: Annotations | null;
}

/** Always allowed, like `text` -- no capability gate in either direction (#9). */
export interface ResourceLinkContentBlock {
  type: 'resource_link';
  uri: string;
  name: string;
  mimeType?: string;
  title?: string;
  description?: string;
  size?: number | null;
  annotations?: Annotations | null;
}

export type EmbeddedResource = { uri: string; text: string; mimeType?: string } | { uri: string; blob: string; mimeType?: string };

/** Requires `promptCapabilities.embeddedContext` when the *client* sends one (#9); ungated on receipt. */
export interface ResourceContentBlock {
  type: 'resource';
  resource: EmbeddedResource;
  annotations?: Annotations | null;
}

export type ContentBlock = TextContentBlock | ImageContentBlock | AudioContentBlock | ResourceLinkContentBlock | ResourceContentBlock;

// ---- tool calls (#10) -----------------------------------------------------

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** All 10 schema values (#10.3 -- the hand-written prose page lists only 9, `switch_mode` is schema-only). Hints only; treat any unrecognized future value as `other`. */
export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';

/**
 * `line` is documented as 0-indexed here (schema `Minimum: 0`) despite the
 * protocol's general 1-based line convention (`fs/read_text_file`). #23
 * item 1: the spec does not say whether this is a real inconsistency or a
 * generic non-negativity constraint -- render whatever an agent sends
 * as-is, do not apply off-by-one arithmetic to it.
 */
export interface ToolCallLocation {
  path: string;
  line?: number | null;
}

export type ToolCallContent =
  | { type: 'content'; content: ContentBlock }
  | { type: 'diff'; path: string; oldText: string | null; newText: string }
  | { type: 'terminal'; terminalId: string };

/** `tool_call` update payload (#10.1): `toolCallId`/`title` required, everything else optional. */
export interface ToolCall {
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

/** `tool_call_update` patch payload (#10.4): only `toolCallId` is required; every other present field *replaces* (never merges with) the prior value. */
export interface ToolCallUpdate {
  toolCallId: string;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  kind?: ToolKind;
  locations?: ToolCallLocation[];
  title?: string | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

// ---- permission requests (#11) -------------------------------------------

/** Hints only, for icon/UI choice (#11.2) -- never gate behavior on these. */
export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

/**
 * The two `RequestPermissionOutcome` variants (#11.3). `cancelled` is not
 * merely one policy choice among others -- #14.1 makes responding with it
 * MANDATORY, and unilaterally, whenever the client cancels a turn while a
 * permission request is outstanding, regardless of what a policy callback
 * would otherwise have decided. session.ts enforces that; this is just the
 * wire shape.
 */
export type RequestPermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };

/**
 * `session/request_permission` params, verbatim (#11.1). `toolCall` reuses
 * the `tool_call_update` *patch* shape (not the full `ToolCall` shape) --
 * this is the spec's own choice, not a simplification made here: it lets an
 * agent surface a rich snapshot (title, kind, content) in the same object
 * that would otherwise just carry an id.
 */
export interface RequestPermissionParams {
  sessionId: SessionId;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
}

// ---- prompt turn (#7) -----------------------------------------------------

/** `StopReason` enum (#7.3). `cancelled` carries a schema-level MUST: agents must return it even if cancellation raised an internal exception -- never surface such an exception as an error to the user (#14.1). */
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

/** `session/prompt`'s success result (#7.3): `{"stopReason": "..."}`. */
export interface PromptTurnResult {
  stopReason: StopReason;
}

/** What a caller may hand to `AcpSession.prompt()`: a plain string (wrapped as a single `text` block) or a caller-assembled block list for richer turns (#7.2, #9). */
export type PromptInput = string | ContentBlock[];

// ---- session/new (#6.1) ---------------------------------------------------

export interface EnvVariable {
  name: string;
  value: string;
}
export interface HttpHeader {
  name: string;
  value: string;
}

/** stdio is the only universally-supported transport (#6.8); all four fields are required on the wire even when empty. */
export interface StdioMcpServer {
  name: string;
  command: string;
  args: string[];
  env: EnvVariable[];
}
/** Gated by `agentCapabilities.mcpCapabilities.http` (#6.8). */
export interface HttpMcpServer {
  type: 'http';
  name: string;
  url: string;
  headers: HttpHeader[];
}
/** Gated by `agentCapabilities.mcpCapabilities.sse`; deprecated upstream in MCP (#6.8). */
export interface SseMcpServer {
  type: 'sse';
  name: string;
  url: string;
  headers: HttpHeader[];
}
export type McpServer = StdioMcpServer | HttpMcpServer | SseMcpServer;

/**
 * Caller-facing params for `AcpClient.newSession()`. `mcpServers` is
 * optional *here* only as an ergonomic default -- the wire field itself is
 * required and session.ts always sends `[]` when omitted (#6.1, and see
 * framing.test.ts's explicit assertion of this). `additionalDirectories`
 * must never be set unless the agent advertised
 * `sessionCapabilities.additionalDirectories` (#6.7); session.ts guards
 * this at the call site.
 */
export interface NewSessionParams {
  cwd: string;
  mcpServers?: McpServer[];
  additionalDirectories?: string[];
}

// ---- session/update catalog (#8) -- eleven variants, all pass-through ---
//
// These are never reconstructed field-by-field at runtime (session.ts casts
// the raw notification payload rather than rebuilding it), so an agent that
// sends extra spec-legal fields this file doesn't model (e.g. `_meta`, #3)
// still flows through unmodified -- these types describe the documented
// shape for callers, they do not police it.

export type PlanEntryPriority = 'high' | 'medium' | 'low';
export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';
export interface PlanEntry {
  content: string;
  priority: PlanEntryPriority;
  status: PlanEntryStatus;
}

/** `AvailableCommand` per #18's worked example: `{name, description, input?: {hint}}`. */
export interface AvailableCommand {
  name: string;
  description: string;
  input?: { hint: string };
}

/** `SessionConfigOption` per #17.2. The `boolean` variant is only legal from an agent whose client advertised the matching capability -- this client never does, so it should never receive one in practice. */
export type SessionConfigOption =
  | {
      id: string;
      name: string;
      description?: string;
      category?: string;
      type: 'select';
      currentValue: string;
      options: Array<{ value: string; name: string; description?: string }>;
    }
  | { id: string; name: string; description?: string; category?: string; type: 'boolean'; currentValue: boolean };

export interface UserMessageChunkUpdate {
  sessionUpdate: 'user_message_chunk';
  content: ContentBlock;
  messageId?: string | null;
}
export interface AgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  content: ContentBlock;
  messageId?: string | null;
}
export interface AgentThoughtChunkUpdate {
  sessionUpdate: 'agent_thought_chunk';
  content: ContentBlock;
  messageId?: string | null;
}
/** Announces a NEW tool call (#10.1) -- full `ToolCall` shape, not a patch. */
export interface ToolCallCreateUpdate extends ToolCall {
  sessionUpdate: 'tool_call';
}
/** Patches an EXISTING tool call (#10.4) -- only changed fields are present. */
export interface ToolCallPatchUpdate extends ToolCallUpdate {
  sessionUpdate: 'tool_call_update';
}
/** Full-replace, never a merge (#8's explicit "replace vs. patch" callout). */
export interface PlanUpdate {
  sessionUpdate: 'plan';
  entries: PlanEntry[];
}
/** Full-replace of the slash-command catalog (#8, #18). */
export interface AvailableCommandsUpdate {
  sessionUpdate: 'available_commands_update';
  availableCommands: AvailableCommand[];
}
/** One selectable mode (#17.1). `_meta` is passed through untouched (#3). */
export interface SessionMode {
  id: string;
  name: string;
  description?: string | null;
}

/** The `modes` block on a session/new/load/resume result (#17.1). */
export interface SessionModeState {
  currentModeId: string;
  availableModes: SessionMode[];
}

export interface CurrentModeUpdate {
  sessionUpdate: 'current_mode_update';
  // STILL UNRESOLVED, now handled rather than deferred. #8's catalog table
  // names this field `currentModeId`; #17.1's own worked example renders it
  // `{"sessionUpdate": "current_mode_update", "modeId": "code"}`. The doc
  // disagrees with itself and neither excerpt is marked as the error.
  //
  // A live capture could not settle it: claude-agent-acp 0.75.1 reports
  // `modes.currentModeId` on the session/new *result* (confirmed on the
  // wire), but was never observed emitting this notification at all, so the
  // spelling it would use is still unknown. Guessing one and dropping the
  // other is the expensive failure -- the mode decides whether the agent
  // asks permission before touching files, so a client that stops tracking
  // it silently believes it is in a mode it is not.
  //
  // Both are therefore optional here and session.ts reads whichever is
  // present. Narrow this to a single required field only once a real agent
  // has been seen sending one.
  currentModeId?: string;
  modeId?: string;
}
/** Full-replace of config-option state, never a merge (#8, #17.2). */
export interface ConfigOptionUpdate {
  sessionUpdate: 'config_option_update';
  configOptions: SessionConfigOption[];
}
/** Partial patch: omitted fields unchanged, an explicit `null` clears (#6.6, #8) -- the opposite convention from `plan`/`available_commands_update`/`config_option_update` above. */
export interface SessionInfoUpdate {
  sessionUpdate: 'session_info_update';
  title?: string | null;
  updatedAt?: string | null;
}
export interface UsageUpdate {
  sessionUpdate: 'usage_update';
  used: number;
  size: number;
  cost?: { amount: number; currency: string } | null;
}

export type SessionUpdate =
  | UserMessageChunkUpdate
  | AgentMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | ToolCallCreateUpdate
  | ToolCallPatchUpdate
  | PlanUpdate
  | AvailableCommandsUpdate
  | CurrentModeUpdate
  | ConfigOptionUpdate
  | SessionInfoUpdate
  | UsageUpdate;
