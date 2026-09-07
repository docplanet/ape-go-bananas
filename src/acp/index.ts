// Public entry point for the ACP client. Pure re-export barrel -- no logic
// of its own (matches the convention in src/apkg/index.ts, src/checks/index.ts).
// Added alongside session.ts/protocol.ts because test/acp/*.test.ts imports
// from '../../dist/acp/index.js' directly and nothing else in this repo
// creates that file; every name below is defined in session.ts or
// protocol.ts, owned by those files, not this one.
//
// handlers.ts's fs/*, terminal/*, and combined-dispatch exports are
// deliberately NOT re-exported here. connect() (session.ts) never wires any
// of it in -- it hardcodes clientCapabilities all-false and answers fs/*/
// terminal/* with a flat -32601 -- so none of that code is reachable, let
// alone exercised, by anything `npm test` runs (see handlers.ts's own tail
// comment for the two session.ts changes a real integration would need).
// Putting untested, unreachable request/response and subprocess-spawning
// code on the public surface invites a caller to import it and assume the
// green suite covers it, which it does not. Import directly from
// './handlers.js' if you specifically need it ahead of that integration
// being finished.

export { connect } from './session.js';
export type { AcpClient, AcpSession, ConnectOptions, PermissionRequestHandler } from './session.js';

export {
  DEFAULT_CLIENT_INFO,
  PROTOCOL_VERSION,
} from './protocol.js';
export type {
  AgentCapabilities,
  AgentAuthMethod,
  Annotations,
  AudioContentBlock,
  AuthMethod,
  AvailableCommand,
  ClientCapabilities,
  ContentBlock,
  EmbeddedResource,
  EnvVariable,
  FileSystemCapabilities,
  HttpHeader,
  HttpMcpServer,
  Implementation,
  ImageContentBlock,
  InitializeResult,
  McpCapabilities,
  McpServer,
  NewSessionParams,
  PermissionOption,
  PermissionOptionKind,
  PlanEntry,
  PlanEntryPriority,
  PlanEntryStatus,
  ProtocolVersion,
  PromptCapabilities,
  PromptInput,
  PromptTurnResult,
  RequestPermissionOutcome,
  RequestPermissionParams,
  ResourceContentBlock,
  ResourceLinkContentBlock,
  SessionCapabilities,
  SessionConfigOption,
  SessionMode,
  SessionModeState,
  SessionId,
  SessionUpdate,
  SseMcpServer,
  StdioMcpServer,
  StopReason,
  TerminalAuthLaunch,
  TerminalAuthMethod,
  TextContentBlock,
  ToolCall,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
  AvailableCommandsUpdate,
  AgentMessageChunkUpdate,
  AgentThoughtChunkUpdate,
  ConfigOptionUpdate,
  CurrentModeUpdate,
  PlanUpdate,
  SessionInfoUpdate,
  ToolCallCreateUpdate,
  ToolCallPatchUpdate,
  UsageUpdate,
  UserMessageChunkUpdate,
} from './protocol.js';
