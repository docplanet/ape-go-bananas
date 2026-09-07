# Agent Client Protocol (ACP) — Implementer's Reference for a Client

Compiled 2026-09-07 from primary sources only: the official spec site
(agentclientprotocol.com), the canonical `schema.json` from the spec's GitHub
releases, and the source code of the two agent implementations this
document names (`@agentclientprotocol/claude-agent-acp`, `@google/gemini-cli`).
Every claim below is either a direct quote/transcription from one of those
sources (URL given inline) or is explicitly marked as inference. Nothing here
comes from model memory of ACP — see `## 23. Unverified` near the end for
the few points that could not be nailed down from primary sources.

**Audience**: this document specifies the wire protocol so you can implement
an ACP **client** (the side that spawns an agent subprocess, drives it, and
exposes editor-like services to it) in TypeScript/Node with zero runtime
dependencies. It does not assume you will use the official `@agentclientprotocol/sdk`
npm package — every message shape is given as raw JSON so you can hand-roll
the JSON-RPC layer.

---

## 0. TL;DR — the five things most likely to be implemented wrong

1. **Transport is newline-delimited JSON-RPC 2.0 over stdio, NOT LSP-style
   `Content-Length` framing.** Each message is exactly one line of UTF-8 JSON
   terminated by `\n`, with no embedded newlines. Source:
   https://agentclientprotocol.com/protocol/v1/transports
2. **There are two unrelated cancellation mechanisms.** `session/cancel` is a
   session/prompt-turn-specific notification. `$/cancel_request` is a
   generic, protocol-level, per-JSON-RPC-request cancellation notification
   (modeled on LSP's `$/cancelRequest`). They are not the same thing and an
   agent may use both together (see the cascading-cancellation example in
   §14.2). Source: https://agentclientprotocol.com/protocol/v1/cancellation
3. **ACP has a v2, but it is a DRAFT, not the spec to implement.** v2 changes
   the core turn lifecycle (`session/prompt` no longer ends the turn; a new
   `state_update` notification does). Everything in this document targets
   **v1**, which is the stable, deployed protocol version as of this writing
   (integer `1`). See §1.
4. **"Claude Code" has no built-in ACP mode.** The `claude` CLI binary does
   not speak ACP. The ACP-speaking program is a *separate* npm package,
   `@agentclientprotocol/claude-agent-acp`, that wraps the Claude Agent SDK.
   **Gemini CLI**, by contrast, natively speaks ACP via a CLI flag
   (`gemini --acp`). See §20–21.
5. **Required-ness of `mcpServers` differs by session method.** `session/new`
   and `session/load` require the `mcpServers` field (send `[]` if you have
   none) — `session/resume` does not. Getting this wrong produces a spec
   violation that some agents may accept leniently and others may reject.
   See §6.

---

## 1. Which protocol version to build: v1 (stable), not v2 (draft)

The spec site publishes **two** parallel versions of the protocol docs,
`/protocol/v1/*` and `/protocol/v2/*` (full list: https://agentclientprotocol.com/llms.txt).
This is not a typo or a leftover — both are live, current documentation trees.

Primary-source confirmation that v2 is a draft, not a replacement to build
against yet, from the v2 announcement itself
(https://agentclientprotocol.com/announcements/acp-v2-draft):

> v2 is a Draft ... gate your implementation behind the version negotiation
> AND feature flags. Don't ship it by default in production until we are
> closer to stabilization. ... v1-only peers will remain common for some
> time.

The magnitude of the difference matters for a client implementer: per the v1→v2
migration guide (https://agentclientprotocol.com/protocol/v2/migration), in
v2 "the `session/prompt` response no longer ends the turn" — it returns an
empty `{}` immediately, and turn progress/completion moves to a new
`state_update` notification with states `running`/`idle`/`requires_action`.
v2 also drops `session/load` (replaced by `session/resume` with a
`replayFrom` option), drops the client filesystem/terminal methods entirely,
and drops the Session Modes API. **None of this applies to v1.** If you build
a v1 client and later see an agent negotiate down to some future v2, treat it
as a different protocol, not a superset.

Every section below is v1. The negotiated `protocolVersion` value to send is
the integer `1` (see §4). The npm package `@agentclientprotocol/sdk` at the
version this document observed (`1.4.0`, https://registry.npmjs.org/@agentclientprotocol/sdk)
and the canonical schema release `schema-v1.21.0` (published 2026-08-20,
https://github.com/agentclientprotocol/agent-client-protocol/releases/latest)
are both v1 artifacts — the "1.x"/"v1.21.0" package/schema version numbers are
*not* the same axis as the wire `protocolVersion` integer; don't confuse them.

---

## 2. Transport

Source: https://agentclientprotocol.com/protocol/v1/transports (quoted verbatim except where noted)

> ACP uses JSON-RPC to encode messages. JSON-RPC messages **MUST** be UTF-8
> encoded.
>
> The protocol currently defines the following transport mechanisms for
> agent-client communication:
>
> 1. stdio, communication over standard in and standard out
> 2. *Streamable HTTP (draft proposal in progress)*
>
> Agents and clients **SHOULD** support stdio whenever possible.

**stdio is the only usable transport today.** The "Streamable HTTP &
WebSocket" alternative is an RFD still in the pitch stage as of this writing
(https://agentclientprotocol.com/rfds/streamable-http-websocket-transport —
it proposes a `/acp` endpoint with long-lived SSE GET streams plus POST, or a
WebSocket upgrade, but is explicitly a proposal, not implemented spec). Build
for stdio only.

stdio transport rules, quoted verbatim from the same page:

> * The client launches the agent as a subprocess.
> * The agent reads JSON-RPC messages from its standard input (`stdin`) and
>   sends messages to its standard output (`stdout`).
> * Messages are individual JSON-RPC requests, notifications, or responses.
> * Messages are delimited by newlines (`\n`), and **MUST NOT** contain
>   embedded newlines.
> * The agent **MAY** write UTF-8 strings to its standard error (`stderr`)
>   for logging purposes. Clients **MAY** capture, forward, or ignore this
>   logging.
> * The agent **MUST NOT** write anything to its `stdout` that is not a
>   valid ACP message.
> * The client **MUST NOT** write anything to the agent's `stdin` that is
>   not a valid ACP message.

Practical implication for your client: spawn the agent subprocess, write one
JSON document + `\n` per outbound message to its stdin, and read its stdout
line by line, `JSON.parse`-ing each line as one message. Route agent stderr
to your own logs (or discard it) — never treat stderr as protocol data.
Independent confirmation that real implementations do exactly this: Gemini
CLI's own ACP transport code sets up "Web streams for standard input/output"
and builds its connection "using line-delimited JSON (ndjson)"
(https://github.com/google-gemini/gemini-cli — `packages/cli/src/acp/README.md`,
and `packages/cli/src/acp/acpStdioTransport.ts` calls
`acp.ndJsonStream(stdout, stdin)`).

**Framing checklist** (this is the single most common integration bug):
- No `Content-Length` header, no `Content-Type` header — that is LSP, not ACP.
- One complete JSON value per line. Never split a message across lines and
  never put two messages on one line.
- The agent's stdout may only ever contain ACP messages — if you need to
  debug, read stderr instead, don't try to filter stdout.

---

## 3. JSON-RPC 2.0 conventions used by ACP

Source: https://agentclientprotocol.com/protocol/v1/overview

> The protocol follows the JSON-RPC 2.0 specification with two types of
> messages:
> * **Methods**: Request-response pairs that expect a result or error
> * **Notifications**: One-way messages that don't expect a response

Standard JSON-RPC 2.0 envelope applies throughout (this is not ACP-specific,
but stated explicitly on the overview page): "Successful responses include a
`result` field", "Errors include an `error` object with `code` and
`message`", "Notifications never receive responses (success or error)".

Concretely, every outbound **request** you send looks like:
```json
{"jsonrpc": "2.0", "id": 0, "method": "<method name>", "params": { ... }}
```
every **notification** you send (no response expected, and the recipient
must not send one) omits `id` entirely — it is not present and not `null`:
```json
{"jsonrpc": "2.0", "method": "<method name>", "params": { ... }}
```
and every **response** you receive is one of:
```json
{"jsonrpc": "2.0", "id": 0, "result": { ... }}
{"jsonrpc": "2.0", "id": 0, "error": {"code": -32602, "message": "...", "data": {}}}
```
The schema's own `RequestId` type definition
(https://agentclientprotocol.com/protocol/v1/schema#requestid) is worth
reading verbatim because it explains *why* omission (not `null`) marks a
notification:

> An identifier established by the Client that MUST contain a String,
> Number, or NULL value if included. If it is not included it is assumed to
> be a notification.

`RequestId` itself is a union of `null | number (int64) | string` — but ACP's
own request builders always send a number or string; a literal `null` id is
legal JSON-RPC but discouraged and you should never emit one.

**Naming/casing conventions**, quoted from
https://agentclientprotocol.com/protocol/v1/overview:

> Unless explicitly defined otherwise in the schema, ACP-defined JSON object
> property keys use `camelCase`. String values carried by discriminator
> fields use `snake_case`. The JSON-RPC envelope fields (`jsonrpc`, `id`,
> `method`, `params`, `result`, and `error`) follow the JSON-RPC 2.0
> specification.

Example of the mixed convention: the field is `sessionUpdate` (camelCase)
but its value is `"tool_call_update"` (snake_case). Method names themselves
use a `namespace/verb_with_underscores` shape, e.g. `session/request_permission`,
`fs/read_text_file`, `terminal/wait_for_exit`.

**Argument-wide rules**, also from the overview page: "All file paths in the
protocol **MUST** be absolute" and "Line numbers are 1-based."

**`_meta` field**: every object type in the protocol (requests, responses,
notifications, and nested types like content blocks, tool calls, plan
entries, capability objects) carries an optional `_meta: { [key: string]: unknown } | null`
you may use for out-of-band metadata; omitted and `null` are equivalent.
Reserved root-level `_meta` keys `traceparent`, `tracestate`, `baggage` are
carved out for W3C trace-context propagation. You **MUST NOT** invent new
root-level fields on any spec-defined type — only `_meta` is open for
extension. Source: https://agentclientprotocol.com/protocol/v1/extensibility


---

## 4. Initialization handshake

Source: https://agentclientprotocol.com/protocol/v1/initialization and
https://agentclientprotocol.com/protocol/v1/schema

The client **MUST** call `initialize` before doing anything else on the
connection.

### 4.1 Request (client → agent)

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {
      "fs": {
        "readTextFile": true,
        "writeTextFile": true
      },
      "terminal": true
    },
    "clientInfo": {
      "name": "my-client",
      "title": "My Client",
      "version": "1.0.0"
    }
  }
}
```
(https://agentclientprotocol.com/protocol/v1/initialization)

`InitializeRequest` fields per the schema
(https://agentclientprotocol.com/protocol/v1/schema#initializerequest):
- `protocolVersion` (`ProtocolVersion` = `integer, uint16, 0–65535`) — **required**. Send the latest version you support; for a v1 client this is `1`.
- `clientCapabilities` (`ClientCapabilities`) — optional; if omitted the agent must assume the default shown in §4.4.
- `clientInfo` (`Implementation | null`) — optional today ("in future versions of the protocol, this will be required" per both the initialization doc and the schema). Always send it.
- `_meta` — optional.

### 4.2 Response (agent → client)

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "loadSession": true,
      "promptCapabilities": {
        "image": true,
        "audio": true,
        "embeddedContext": true
      },
      "mcpCapabilities": {
        "http": true,
        "sse": true
      }
    },
    "agentInfo": {
      "name": "my-agent",
      "title": "My Agent",
      "version": "1.0.0"
    },
    "authMethods": []
  }
}
```
(https://agentclientprotocol.com/protocol/v1/initialization)

`InitializeResponse` fields
(https://agentclientprotocol.com/protocol/v1/schema#initializeresponse):
- `protocolVersion` — **required**. "The protocol version the client specified if supported by the agent, or the latest protocol version supported by the agent."
- `agentCapabilities` (`AgentCapabilities`) — optional, default shown in §4.4.
- `agentInfo` (`Implementation | null`) — optional today, same "will be required" caveat.
- `authMethods` (`AuthMethod[]`) — optional, default `[]`.

`Implementation` shape (used for both `clientInfo`/`agentInfo`):
`{ name: string, title?: string | null, version: string }` — `name` is the
programmatic/fallback-display name, `title` is the human-facing display
name, `version` is a free-form string.
(https://agentclientprotocol.com/protocol/v1/schema#implementation)

### 4.3 Version negotiation — exact rule

Quoted verbatim, https://agentclientprotocol.com/protocol/v1/initialization:

> The `initialize` request **MUST** include the latest protocol version the
> Client supports.
>
> If the Agent supports the requested version, it **MUST** respond with the
> same version. Otherwise, the Agent **MUST** respond with the latest
> version it supports.
>
> If the Client does not support the version specified by the Agent in the
> `initialize` response, the Client **SHOULD** close the connection and
> inform the user about it.

So: send your highest supported version; compare the *response's*
`protocolVersion` against what you can handle; if you can't handle it,
disconnect and surface an error to the user rather than trying to proceed.

### 4.4 Capabilities — what "omitted" means, and the exact defaults

General rule (https://agentclientprotocol.com/protocol/v1/initialization):
"All capabilities included in the `initialize` request are **OPTIONAL**...
Clients and Agents **MUST** treat all capabilities omitted in the `initialize`
request as **UNSUPPORTED**." New capabilities are additive, never breaking.

The schema page gives the literal default object the agent must assume if
the client omits `clientCapabilities` entirely, and vice versa
(https://agentclientprotocol.com/protocol/v1/schema#initializerequest,
https://agentclientprotocol.com/protocol/v1/schema#initializeresponse):

- Default `clientCapabilities` if omitted:
  `{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,"auth":{"terminal":false}}`
- Default `agentCapabilities` if omitted:
  `{"loadSession":false,"promptCapabilities":{"image":false,"audio":false,"embeddedContext":false},"mcpCapabilities":{"http":false,"sse":false},"sessionCapabilities":{},"auth":{}}`

**`ClientCapabilities` full shape** (https://agentclientprotocol.com/protocol/v1/schema#clientcapabilities):

| Field | Type | Default | Meaning |
|---|---|---|---|
| `fs` | `FileSystemCapabilities` | `{"readTextFile":false,"writeTextFile":false}` | which `fs/*` methods you (the client) will answer |
| `terminal` | `boolean` | `false` | whether you implement all `terminal/*` methods |
| `auth.terminal` | `boolean` (nested in `AuthCapabilities`) | `false` | whether you can re-launch the configured agent program interactively for terminal-type auth (§5.3) |
| `elicitation` | `ElicitationCapabilities \| null` | unsupported if omitted/null | which `elicitation/create` modes (`form`, `url`) you support — see §16 |
| `session.configOptions.boolean` | `BooleanConfigOptionCapabilities \| null` | unsupported if omitted/null | whether you render `type: "boolean"` session config options — see §17 |

Note the elicitation quirk called out explicitly in the initialization docs:
"Unlike MCP, ACP does not treat `{}` as form support" for the elicitation
capability — each mode (`form`/`url`) must be its own present, non-null key.

**`AgentCapabilities` full shape** (https://agentclientprotocol.com/protocol/v1/schema#agentcapabilities):

| Field | Type | Default | Meaning |
|---|---|---|---|
| `loadSession` | `boolean` | `false` | `session/load` is available |
| `promptCapabilities.image` | `boolean` | `false` | prompts may contain `ContentBlock::Image` |
| `promptCapabilities.audio` | `boolean` | `false` | prompts may contain `ContentBlock::Audio` |
| `promptCapabilities.embeddedContext` | `boolean` | `false` | prompts may contain `ContentBlock::Resource` |
| `mcpCapabilities.http` | `boolean` | `false` | agent can connect to MCP servers over HTTP |
| `mcpCapabilities.sse` | `boolean` | `false` | agent can connect to MCP servers over SSE (deprecated transport upstream in MCP) |
| `auth.logout` | `LogoutCapabilities \| null` | unsupported if omitted/null | `logout` method is available |
| `sessionCapabilities.resume` | object or `null` | unsupported if omitted/null | `session/resume` is available |
| `sessionCapabilities.close` | object or `null` | unsupported if omitted/null | `session/close` is available |
| `sessionCapabilities.delete` | object or `null` | unsupported if omitted/null | `session/delete` is available |
| `sessionCapabilities.list` | object or `null` | unsupported if omitted/null | `session/list` is available |
| `sessionCapabilities.additionalDirectories` | object or `null` | unsupported if omitted/null | `additionalDirectories` accepted on session lifecycle calls |

Baseline (always available, no capability flag): `session/new`,
`session/prompt`, `session/cancel`, `session/update`, and on the client side
`session/request_permission`. Every other method is capability-gated — check
before calling, and never call a method whose gating capability was
omitted/false/null.

For every one of these "presence-typed" capabilities (the `X | null` ones
using an object rather than a boolean), the convention is uniform across the
whole spec and worth internalizing once: **omitted or `null` means
unsupported; an empty object `{}` means supported.** This shows up
identically for `sessionCapabilities.*`, `auth.logout`, `elicitation.form`/`.url`,
and `session.configOptions.boolean`.

---

## 5. Authentication

Source: https://agentclientprotocol.com/protocol/v1/authentication

### 5.1 How an agent advertises auth

The agent lists methods in the `initialize` response's `authMethods` array;
if it supports ending the authenticated state it also sets
`agentCapabilities.auth.logout`:

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "auth": { "logout": {} }
    },
    "authMethods": [
      {
        "id": "agent-login",
        "name": "Agent login",
        "description": "Sign in using the agent's login flow"
      }
    ]
  }
}
```
(https://agentclientprotocol.com/protocol/v1/authentication)

`AuthMethod` is a **union keyed by an optional `type` field**
(https://agentclientprotocol.com/protocol/v1/schema#authmethod): "The `type`
field acts as the discriminator ... When no `type` is present, the method is
treated as `agent`." Two variants:

- **`agent`** (default, no `type` field): `{ id, name, description? }`. The
  client calls `authenticate` with this `id` (§5.2).
- **`terminal`** (`type: "terminal"`): `{ id, name, description?, args?: string[], env?: object }`.
  The client must **never** send this `id` to `authenticate` — instead it
  re-launches the configured agent program interactively (§5.3). An agent
  may only advertise a `terminal` method if the client advertised
  `clientCapabilities.auth.terminal: true` during `initialize`.

### 5.2 Protocol-driven (`agent`-type) authentication

```json
{"jsonrpc": "2.0", "id": 1, "method": "authenticate", "params": {"methodId": "agent-login"}}
```
Success response is an empty object:
```json
{"jsonrpc": "2.0", "id": 1, "result": {}}
```
(https://agentclientprotocol.com/protocol/v1/authentication)

After a successful `authenticate`, the client can create sessions without
getting an `auth_required`-flavored error (ACP models this as the
`-32000` "Authentication required" error code, §15) on
authentication-gated calls.

### 5.3 Terminal-type authentication

Quoted verbatim, the exact 4-step client procedure
(https://agentclientprotocol.com/protocol/v1/authentication):

> 1. Launches a separate interactive process using the same configured Agent
>    program and base launch configuration as the ACP connection.
> 2. Appends the method's `args` and applies its `env`, overriding any
>    same-named variables in the base launch configuration.
> 3. Presents the terminal to the user and waits for the process to exit.
>    Exit status zero signals success; a non-zero status, termination
>    without an exit status, or cancellation signals failure.
> 4. Reconnects and reinitializes the ACP Agent.

Key constraint: "The descriptor cannot provide a command. The Client derives
the command from its own Agent configuration" — and "the Client **MUST NOT**
send an `authenticate` request for a terminal method." This entire flow
happens outside the ACP JSON-RPC connection (it's a side-channel process
launch), which is why it needs its own separate interactive process rather
than reusing the existing stdio pipe.

### 5.4 Logout

```json
{"jsonrpc": "2.0", "id": 2, "method": "logout", "params": {}}
```
```json
{"jsonrpc": "2.0", "id": 2, "result": {}}
```
Only call this if `agentCapabilities.auth.logout` was present (non-null) at
`initialize` time. Per spec, behavior of already-running sessions after
`logout` is explicitly **undefined** — "Agents may terminate them, keep them
running, or return `auth_required` errors for future session activity." A
client should be ready for authentication errors on any in-flight session
call after a logout and re-prompt the user to authenticate.
(https://agentclientprotocol.com/protocol/v1/authentication)


---

## 6. Session setup

Source: https://agentclientprotocol.com/protocol/v1/session-setup,
https://agentclientprotocol.com/protocol/v1/session-list,
https://agentclientprotocol.com/protocol/v1/session-delete,
https://agentclientprotocol.com/protocol/v1/schema

A session is an independent conversation context; one connection can host
several. `initialize` must complete before any session call.

### 6.1 `session/new` — always available (baseline)

Request:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session/new",
  "params": {
    "cwd": "/home/user/project",
    "mcpServers": [
      {"name": "filesystem", "command": "/path/to/mcp-server", "args": ["--stdio"], "env": []}
    ]
  }
}
```
Response:
```json
{"jsonrpc": "2.0", "id": 1, "result": {"sessionId": "sess_abc123def456"}}
```
(https://agentclientprotocol.com/protocol/v1/session-setup)

`NewSessionRequest` fields (https://agentclientprotocol.com/protocol/v1/schema#newsessionrequest):
- `cwd: string` — **required**, absolute path.
- `mcpServers: McpServer[]` — **required** (send `[]`, do not omit).
- `additionalDirectories?: string[]` — optional; only send if the agent advertised `sessionCapabilities.additionalDirectories` (§6.7).

`NewSessionResponse`: `sessionId: SessionId` (opaque string) — **required**;
plus optional `configOptions?: SessionConfigOption[] | null` and
`modes?: SessionModeState | null` (§17) if the agent supports either
config-selector mechanism and wants to report initial state.

May fail with the `-32000` "Authentication required" error code if the agent
needs auth first (https://agentclientprotocol.com/protocol/v1/schema — see
the `initialize`/`session/new` method descriptions: "May return an
`auth_required` error if the agent requires authentication").

### 6.2 `session/load` — gated by `agentCapabilities.loadSession`

Do not call unless `loadSession` was `true`. Request:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session/load",
  "params": {
    "sessionId": "sess_789xyz",
    "cwd": "/home/user/project",
    "mcpServers": [
      {"name": "filesystem", "command": "/path/to/mcp-server", "args": ["--mode", "filesystem"], "env": []}
    ]
  }
}
```
`LoadSessionRequest` fields: `sessionId` **required**, `cwd` **required**,
`mcpServers: McpServer[]` **required** (same as `session/new`),
`additionalDirectories?` optional.
(https://agentclientprotocol.com/protocol/v1/schema#loadsessionrequest)

**Before responding**, the agent replays the *entire* prior conversation to
you as ordinary `session/update` notifications (same shapes as live
streaming, §9) — e.g. a replayed user turn:
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_789xyz",
    "update": {
      "sessionUpdate": "user_message_chunk",
      "messageId": "msg_user_8f7a1",
      "content": {"type": "text", "text": "What's the capital of France?"}
    }
  }
}
```
followed by the assistant's reply chunk, etc. Only once *all* history has
streamed does the agent answer the original request — and note the response
`result` is literally `null` in the doc's own example, not `{}`:
```json
{"jsonrpc": "2.0", "id": 1, "result": null}
```
(https://agentclientprotocol.com/protocol/v1/session-setup — the
`LoadSessionResponse` schema entry only lists optional `configOptions`/`modes`/`_meta`
fields, all of which are absent in this example, which is presumably why the
docs render the bare result as `null` rather than `{}`; treat either an
empty-fields object or `null` as a valid success result here.) Your client
must be ready to receive an unbounded number of `session/update`
notifications *before* the matching response arrives for this one request —
don't assume request/response are adjacent on the wire.

### 6.3 `session/resume` — gated by `agentCapabilities.sessionCapabilities.resume`

The lighter-weight alternative to `session/load`: same restoration, **no**
history replay.

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/resume",
  "params": {
    "sessionId": "sess_789xyz",
    "cwd": "/home/user/project",
    "mcpServers": []
  }
}
```
```json
{"jsonrpc": "2.0", "id": 2, "result": {}}
```
(https://agentclientprotocol.com/protocol/v1/session-setup)

**Field-requiredness difference from `session/new`/`session/load`, verified
against the schema
(https://agentclientprotocol.com/protocol/v1/schema#resumesessionrequest):**
`sessionId` and `cwd` are required, but **`mcpServers` is optional** here
(no `required` marker on it in the schema, unlike the other two methods).
`ResumeSessionResponse` may include `configOptions`/`modes` just like
`session/new`'s response.

> The response **MAY** also include initial mode, model, or session
> configuration state when those features are supported by the Agent.
(https://agentclientprotocol.com/protocol/v1/session-setup)

### 6.4 `session/close` — gated by `sessionCapabilities.close`

```json
{"jsonrpc": "2.0", "id": 2, "method": "session/close", "params": {"sessionId": "sess_789xyz"}}
```
```json
{"jsonrpc": "2.0", "id": 2, "result": {}}
```
Semantics: "The Agent **MUST** cancel any ongoing work for that session as if
`session/cancel` had been called, then free the resources associated with
the session." Agents "MAY return an error if the session does not exist or
is not currently active."
(https://agentclientprotocol.com/protocol/v1/session-setup)

### 6.5 `session/delete` — gated by `sessionCapabilities.delete`

```json
{"jsonrpc": "2.0", "id": 3, "method": "session/delete", "params": {"sessionId": "sess_abc123def456"}}
```
```json
{"jsonrpc": "2.0", "id": 3, "result": {}}
```
This is a **history-list removal**, not necessarily a live-session
teardown — quoted verbatim
(https://agentclientprotocol.com/protocol/v1/session-delete):

> * Deleted sessions no longer appear in future `session/list` results.
> * Deleting an already-deleted session, or a session that never existed,
>   **SHOULD** succeed silently.
> * Agents may implement soft delete or hard delete. ACP only specifies the
>   user-facing session-list behavior.
> * Behavior for `session/load` on a deleted session is implementation-defined.
> * Behavior for deleting an active session is implementation-defined.

### 6.6 `session/list` — gated by `sessionCapabilities.list`, cursor-paginated

Request (all params optional; empty `params` = first page, unfiltered):
```json
{"jsonrpc": "2.0", "id": 2, "method": "session/list", "params": {"cwd": "/home/user/project", "cursor": "eyJwYWdlIjogMn0="}}
```
Response:
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "sessions": [
      {"sessionId": "sess_abc123def456", "cwd": "/home/user/project", "title": "Implement session list API", "updatedAt": "2025-10-29T14:22:15Z"},
      {"sessionId": "sess_xyz789ghi012", "cwd": "/home/user/another-project", "title": "Debug authentication flow", "updatedAt": "2025-10-28T16:45:30Z"}
    ],
    "nextCursor": "eyJwYWdlIjogM30="
  }
}
```
(https://agentclientprotocol.com/protocol/v1/session-list)

`SessionInfo` fields: `sessionId` required, `cwd` required,
`title?: string | null`, `updatedAt?: string | null` (ISO 8601),
`additionalDirectories?: string[]`, `_meta?`.

Pagination rules, quoted verbatim
(https://agentclientprotocol.com/protocol/v1/session-list):

> * Clients **MUST** treat a missing `nextCursor` as the end of results
> * Clients **MUST** treat cursors as opaque tokens — do not parse, modify,
>   or persist them
> * Agents **SHOULD** return an error if the cursor is invalid

`session/list` is **read-only discovery** — it does not restore state; you
still call `session/load` afterward to actually resume a chosen session
(https://agentclientprotocol.com/protocol/v1/session-list, "Interaction with
Other Session Methods").

Agents may also push live metadata updates via a `session_info_update`
`session/update` variant (title changes, etc.) — see §8.

### 6.7 Working directory and additional workspace roots

`cwd` rules, quoted verbatim (https://agentclientprotocol.com/protocol/v1/session-setup):

> * **MUST** be an absolute path
> * **MUST** be used for the session regardless of where the Agent
>   subprocess was spawned
> * **MUST** remain the base for relative-path resolution
> * **MUST** be part of the session's effective root set

If the agent advertised `sessionCapabilities.additionalDirectories`, the
session's effective root set is `[cwd, ...additionalDirectories]`, and you
may pass `additionalDirectories: string[]` (absolute paths) on `session/new`,
`session/load`, and `session/resume`. On `session/load`/`session/resume` you
must resend the **complete** intended list each time — it is not merged with
any previously stored list, and omitting it does not "keep" a prior list, it
clears it (https://agentclientprotocol.com/protocol/v1/session-setup,
"Additional Workspace Roots"). Never send this field unless the capability
was advertised.

### 6.8 MCP server configs — three transport variants

`McpServer` is a union (https://agentclientprotocol.com/protocol/v1/schema#mcpserver).
**Only `stdio` is universally supported** — "All Agents MUST support this
transport." `http`/`sse` are gated by `agentCapabilities.mcpCapabilities.http`/`.sse`.

- **stdio** (no `type` discriminator field — this is the untagged/default
  variant): `{ name: string, command: string (absolute path), args: string[], env: EnvVariable[] }`.
  All four fields are **required** on the wire per the schema (send `[]` for
  empty `args`/`env`, never omit them).
  ```json
  {"name": "filesystem", "command": "/path/to/mcp-server", "args": ["--stdio"], "env": [{"name": "API_KEY", "value": "secret123"}]}
  ```
- **http** (`type: "http"`, requires `mcpCapabilities.http`):
  `{ type: "http", name: string, url: string, headers: HttpHeader[] }` — all required.
  ```json
  {"type": "http", "name": "api-server", "url": "https://api.example.com/mcp", "headers": [{"name": "Authorization", "value": "Bearer token123"}]}
  ```
- **sse** (`type: "sse"`, requires `mcpCapabilities.sse`, **deprecated by
  upstream MCP spec** — don't build new integrations on it):
  `{ type: "sse", name: string, url: string, headers: HttpHeader[] }`.

(All examples: https://agentclientprotocol.com/protocol/v1/session-setup)
`EnvVariable = { name: string, value: string }`, `HttpHeader = { name: string, value: string }`.

New agents "SHOULD support the HTTP transport to ensure compatibility with
modern MCP servers" even though it's optional
(https://agentclientprotocol.com/protocol/v1/session-setup) — as the client,
that's a note for you about what to expect from well-behaved agents, not
something you implement yourself (the client only *supplies* MCP server
configs; it is the agent that connects to them).


---

## 7. The Prompt Turn

Source: https://agentclientprotocol.com/protocol/v1/prompt-turn,
https://agentclientprotocol.com/protocol/v1/schema

A prompt turn is one full request/response cycle: user message in, zero or
more model↔tool round-trips, final stop reason out. It may involve many
`session/update` notifications and nested requests (permission, fs,
terminal) before the original `session/prompt` call resolves.

### 7.1 Lifecycle, step by step (paraphrased from the spec's own sequence diagram and prose)

1. Client sends `session/prompt` (§7.2).
2. Agent forwards the message to its model.
3. Agent streams the model's output back via `session/update` notifications:
   optionally a `plan` update first, then `agent_message_chunk` update(s),
   and/or `tool_call` update(s) if the model requested tool use (§10).
4. **If there are no pending tool calls**, the turn ends now and the agent
   answers the original `session/prompt` with a stop reason (§7.3).
5. **If there are tool calls**: the agent may first call
   `session/request_permission` (§11) before running one; once
   permitted (or if no permission was needed), the agent marks the tool
   `in_progress`, executes it (possibly calling back into your `fs/*` or
   `terminal/*` methods, §12–13), then marks it `completed`/`failed` with
   results.
6. The agent feeds tool results back to the model and returns to step 2 —
   this loops until the model stops requesting tools or the turn is stopped.
7. At any point the client may send `session/cancel` (§14.1) to abort the
   turn early.

(https://agentclientprotocol.com/protocol/v1/prompt-turn)

### 7.2 Request (client → agent)

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/prompt",
  "params": {
    "sessionId": "sess_abc123def456",
    "prompt": [
      {"type": "text", "text": "Can you analyze this code for potential issues?"},
      {"type": "resource", "resource": {"uri": "file:///home/user/project/main.py", "mimeType": "text/x-python", "text": "def process_data(items):\n    for item in items:\n        print(item)"}}
    ]
  }
}
```
(https://agentclientprotocol.com/protocol/v1/prompt-turn)

`PromptRequest`: `sessionId` required, `prompt: ContentBlock[]` required.
**Content-type gating**: "As a baseline, the Agent MUST support
`ContentBlock::Text` and `ContentBlock::ResourceLink`, while other variants
are optionally enabled via `PromptCapabilities`... The Client MUST adapt its
interface according to `PromptCapabilities`" — i.e. you (the client) must
not put an `image`/`audio`/`resource` block into a prompt unless the agent
advertised the matching `promptCapabilities.*` flag at `initialize` time
(https://agentclientprotocol.com/protocol/v1/schema#promptrequest). When you
do have the choice between `resource` (embedded) and `resource_link`
(reference), prefer embedded `resource` — "it avoids extra round-trips and
allows the message to include pieces of context from sources the agent may
not have access to" — but only if `embeddedContext` capability is present;
otherwise use `resource_link`.

### 7.3 Response (agent → client) and Stop Reasons

```json
{"jsonrpc": "2.0", "id": 2, "result": {"stopReason": "end_turn"}}
```
`StopReason` enum, quoted verbatim (https://agentclientprotocol.com/protocol/v1/prompt-turn):

| Value | Meaning |
|---|---|
| `end_turn` | "The language model finishes responding without requesting more tools" |
| `max_tokens` | "The maximum token limit is reached" |
| `max_turn_requests` | "The maximum number of model requests in a single turn is exceeded" |
| `refusal` | "The Agent refuses to continue" — and per the schema, "The user prompt and everything that comes after it won't be included in the next prompt, so this should be reflected in the UI." |
| `cancelled` | "The Client cancels the turn" |

The schema adds an important MUST for `cancelled` specifically
(https://agentclientprotocol.com/protocol/v1/schema#stopreason): "This stop
reason MUST be returned when the client sends a `session/cancel`
notification, even if the cancellation causes exceptions in underlying
operations" — see the cancellation warning in §14.1 about why agents must
swallow SDK-level "aborted" exceptions and translate them to this stop
reason rather than an error response.

### 7.4 Message IDs

Message-chunk updates (`user_message_chunk`, `agent_message_chunk`,
`agent_thought_chunk`) may carry a `messageId: string | null`. Quoted
verbatim (https://agentclientprotocol.com/protocol/v1/prompt-turn): "Chunks
with the same `messageId` belong to the same message; a changed `messageId`
indicates a new message." Treat it as opaque; don't assume monotonic or
sequential values.

### 7.5 Usage/cost reporting

Agents may optionally emit a `usage_update` (§8) mid-turn with cumulative
token/cost accounting. `used` and `size` (both `uint64`, token counts) are
required whenever this update is sent; `cost: {amount: number, currency: string}`
(ISO 4217 code, e.g. `"USD"`) is optional.
(https://agentclientprotocol.com/protocol/v1/prompt-turn)

---

## 8. `session/update` — the complete notification catalog

Source: https://agentclientprotocol.com/protocol/v1/schema#sessionupdate
(cross-checked against https://agentclientprotocol.com/protocol/v1/prompt-turn,
/tool-calls, /agent-plan, /slash-commands, /session-modes,
/session-config-options, /session-list)

Every `session/update` **notification** (no response expected — never
respond to these) has the outer shape:
```json
{"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "<SessionId>", "update": { "sessionUpdate": "<variant>", ... }}}
```
`update.sessionUpdate` is the discriminator (snake_case string). There are
exactly **eleven** variants defined in v1's `SessionUpdate` union. All are
agent → client. Fields listed below are in addition to the shared
`sessionUpdate` discriminator and optional `_meta`.

| `sessionUpdate` value | Other fields | Notes |
|---|---|---|
| `user_message_chunk` | `content: ContentBlock` (required), `messageId?: string \| null` | streamed replay/echo of the user's own message (used during `session/load` replay, §6.2) |
| `agent_message_chunk` | `content: ContentBlock` (required), `messageId?` | the model's visible reply, streamed |
| `agent_thought_chunk` | `content: ContentBlock` (required), `messageId?` | the model's internal reasoning, streamed (only if the agent chooses to surface it) |
| `tool_call` | `toolCallId` (required), `title` (required), `kind?: ToolKind`, `status?: ToolCallStatus` (defaults `pending`), `content?: ToolCallContent[]`, `locations?: ToolCallLocation[]`, `rawInput?: object`, `rawOutput?: object` | announces a **new** tool call — see §10 |
| `tool_call_update` | `toolCallId` (required — the only required field besides the discriminator), `status?`, `content?`, `kind?`, `locations?`, `title?: string \| null`, `rawInput?`, `rawOutput?` | patches an existing tool call; **only include fields that changed** — see §10 |
| `plan` | `entries: PlanEntry[]` (required) | full plan replacement every time (§8.1) |
| `available_commands_update` | `availableCommands: AvailableCommand[]` (required) | slash-command catalog, replaces prior list (§18) |
| `current_mode_update` | `currentModeId: SessionModeId` (required) | agent unilaterally switched legacy "mode" (§17.1) |
| `config_option_update` | `configOptions: SessionConfigOption[]` (required) | full config-option state replacement (§17.2) |
| `session_info_update` | `title?: string \| null`, `updatedAt?: string \| null` | partial metadata patch — omitted fields unchanged, `null` clears (§6.6) |
| `usage_update` | `used: uint64` (required), `size: uint64` (required), `cost?: {amount, currency} \| null` | context-window/cost accounting (§7.5) |

Two important "replace vs. patch" distinctions the table above encodes and
that are easy to get backwards:
- **`plan`**: quoted verbatim (https://agentclientprotocol.com/protocol/v1/agent-plan):
  "The Agent **MUST** send a complete list of all plan entries in each
  update... The Client **MUST** replace the current plan completely." Same
  full-replace semantics apply to `available_commands_update` and
  `config_option_update`.
- **`tool_call_update`** and **`session_info_update`**, by contrast, are
  genuine partial patches: "All fields except `toolCallId` are optional in
  updates. Only the fields being changed need to be included"
  (https://agentclientprotocol.com/protocol/v1/tool-calls); for
  `session_info_update`, "omitted fields are left unchanged" and an explicit
  `null` clears a field, rather than being a no-op
  (https://agentclientprotocol.com/protocol/v1/session-list).

### 8.1 `PlanEntry` shape
(https://agentclientprotocol.com/protocol/v1/agent-plan)
```json
{"content": "Check for syntax errors", "priority": "high", "status": "pending"}
```
`content: string` required; `priority: "high" | "medium" | "low"` required;
`status: "pending" | "in_progress" | "completed"` required.


---

## 9. Content blocks

Source: https://agentclientprotocol.com/protocol/v1/content,
https://agentclientprotocol.com/protocol/v1/schema#contentblock

`ContentBlock` is a `type`-discriminated union, deliberately identical to
MCP's `ContentBlock` shape "to enable Agents to seamlessly forward content
from MCP tool outputs without transformation"
(https://agentclientprotocol.com/protocol/v1/content). It appears in
`session/prompt` params, in `session/update` message chunks, and inside
`ToolCallContent` (§10.5). Five variants:

**`text`** — always allowed everywhere, no capability gate.
```json
{"type": "text", "text": "What's the weather like today?"}
```
`text: string` required. "Clients SHOULD render this text as Markdown"
(https://agentclientprotocol.com/protocol/v1/schema#contentblock) — this is
stated as the default rendering assumption for the whole protocol, not just
this field (see also the intro page: "The default format for user-readable
text is Markdown").

**`image`** — requires `promptCapabilities.image` when used in a prompt (no
gate when the *agent* emits it in output).
```json
{"type": "image", "mimeType": "image/png", "data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB..."}
```
`data: string` (base64) required, `mimeType: string` required,
`uri?: string | null` optional.

**`audio`** — requires `promptCapabilities.audio` in prompts.
```json
{"type": "audio", "mimeType": "audio/wav", "data": "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAAB..."}
```
`data`, `mimeType` required (same shape as image, minus `uri`).

**`resource_link`** — always allowed (baseline, like `text`).
```json
{"type": "resource_link", "uri": "file:///home/user/document.pdf", "name": "document.pdf", "mimeType": "application/pdf", "size": 1024000}
```
`uri` required, `name` required, `mimeType?`, `title?`, `description?`,
`size?: integer | null` (bytes) all optional.

**`resource`** (embedded) — requires `promptCapabilities.embeddedContext` in
prompts. Preferred over `resource_link` when available, since it avoids a
round-trip and can carry content the agent has no independent access to.
```json
{"type": "resource", "resource": {"uri": "file:///home/user/script.py", "mimeType": "text/x-python", "text": "def hello():\n    print('Hello, world!')"}}
```
`resource` is itself a union of two shapes:
- text resource: `{uri: string, text: string, mimeType?: string}`
- blob resource: `{uri: string, blob: string (base64), mimeType?: string}`

All five variants also accept an optional `annotations: Annotations | null`
object (`audience?: Role[]`, `lastModified?: string`, `priority?: number`) —
MCP-borrowed display hints, not required for correctness.
(https://agentclientprotocol.com/protocol/v1/content)

---

## 10. Tool calls

Source: https://agentclientprotocol.com/protocol/v1/tool-calls,
https://agentclientprotocol.com/protocol/v1/schema

Tool calls are how the agent narrates what it (or the underlying model) is
doing on the client's behalf. Everything here is agent → client
(`session/update` notifications); the client's only *response* role is
answering `session/request_permission` (§11) if the agent asks.

### 10.1 Creation — `tool_call` update

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123def456",
    "update": {"sessionUpdate": "tool_call", "toolCallId": "call_001", "title": "Reading configuration file", "kind": "read", "status": "pending"}
  }
}
```
(https://agentclientprotocol.com/protocol/v1/tool-calls)
`toolCallId` and `title` are the only required fields besides the
discriminator; `kind`, `status` (defaults `pending`), `content`,
`locations`, `rawInput`, `rawOutput` are all optional.

### 10.2 `ToolCallStatus` (4 values)
(https://agentclientprotocol.com/protocol/v1/tool-calls#status)

| Value | Meaning |
|---|---|
| `pending` | "hasn't started running yet because the input is either streaming or awaiting approval" |
| `in_progress` | currently running |
| `completed` | succeeded |
| `failed` | "failed with an error" |

### 10.3 `ToolKind` (10 values — the docs prose lists 9, the schema has 10)

Cross-checked https://agentclientprotocol.com/protocol/v1/tool-calls against
the canonical https://agentclientprotocol.com/protocol/v1/schema#toolkind —
the schema additionally defines `switch_mode`, which the hand-written
tool-calls.md prose page omits (it's documented instead, with an example, on
the session-modes page). Full authoritative list:

`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`,
`switch_mode`, `other` (default). These are hints only ("help Clients choose
appropriate icons and optimize how they display tool execution progress") —
never gate behavior on them, and treat any future unrecognized value as
equivalent to `other`.

### 10.4 Updating — `tool_call_update`

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123def456",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call_001",
      "status": "completed",
      "content": [{"type": "content", "content": {"type": "text", "text": "Analysis complete:\n- No syntax errors found\n- Consider adding type hints for better clarity"}}]
    }
  }
}
```
(https://agentclientprotocol.com/protocol/v1/prompt-turn) — patch semantics:
only `toolCallId` is required; every other field, when present, **replaces**
the corresponding value on the tool call (e.g. sending `content` replaces
the whole content array, it does not append).

### 10.5 `ToolCallContent` — 3 variants (`type`-discriminated)

(https://agentclientprotocol.com/protocol/v1/tool-calls#content)

- **`content`** — wraps a normal `ContentBlock` (§9):
  ```json
  {"type": "content", "content": {"type": "text", "text": "Analysis complete. Found 3 issues."}}
  ```
- **`diff`** — a file modification shown as before/after text:
  ```json
  {"type": "diff", "path": "/home/user/project/src/config.json", "oldText": "{\n  \"debug\": false\n}", "newText": "{\n  \"debug\": true\n}"}
  ```
  `path` (absolute) and `newText` required; `oldText: string | null` — `null`
  signals a newly created file.
- **`terminal`** — embeds a live terminal you created via `terminal/create`
  (§13) so the client keeps rendering its output:
  ```json
  {"type": "terminal", "terminalId": "term_xyz789"}
  ```
  "The terminal must be added before calling `terminal/release`" and once
  embedded, "the Client displays live output as it's generated and
  continues to display it even after the terminal is released."
  (https://agentclientprotocol.com/protocol/v1/schema#toolcallcontent,
  https://agentclientprotocol.com/protocol/v1/terminals)

### 10.6 `ToolCallLocation` — "follow along"

```json
{"path": "/home/user/project/src/main.py", "line": 42}
```
`path` (absolute) required, `line?: integer | null` (0-indexed minimum per
schema, despite the rest of the protocol's 1-based line convention for
`fs/read_text_file` — treat `line` here as whatever the agent sends and
don't assume it lines up with the `fs/*` line-numbering convention; the spec
does not clarify this asymmetry, see §23 Unverified). Populate an array of
these on a `tool_call`/`tool_call_update` to let the client UI highlight
"the agent is currently looking at/editing this file/line."
(https://agentclientprotocol.com/protocol/v1/tool-calls#following-the-agent)


---

## 11. Permission requests

Source: https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission,
https://agentclientprotocol.com/protocol/v1/schema

This is the one core request your client **must** answer (it's a baseline
client method, not capability-gated) — the agent asks before running a
sensitive tool call, you present options to the user, you return their
choice.

### 11.1 Request (agent → client) and response (client → agent)

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/request_permission",
  "params": {
    "sessionId": "sess_abc123def456",
    "toolCall": {"toolCallId": "call_001"},
    "options": [
      {"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
      {"optionId": "reject-once", "name": "Reject", "kind": "reject_once"}
    ]
  }
}
```
```json
{"jsonrpc": "2.0", "id": 5, "result": {"outcome": {"outcome": "selected", "optionId": "allow-once"}}}
```
(https://agentclientprotocol.com/protocol/v1/tool-calls)

`RequestPermissionRequest`: `sessionId` required, `options: PermissionOption[]`
required, `toolCall: ToolCallUpdate` required — note the type is the same
*update* shape used for `tool_call_update` (§10.4), so it may carry a full
tool-call snapshot (title, kind, content, etc.) beyond just the id, letting
the agent show rich context in the permission prompt (e.g. the session-modes
doc's "exit plan mode" example embeds `title`, `kind: "switch_mode"`, and a
`content` block with the plan text directly in the permission request —
https://agentclientprotocol.com/protocol/v1/session-modes).

### 11.2 `PermissionOptionKind` (4 values)
(https://agentclientprotocol.com/protocol/v1/tool-calls#permission-options)

`allow_once`, `allow_always`, `reject_once`, `reject_always` — hints only,
for choosing icons/UI treatment. "Clients **MAY** automatically allow or
reject permission requests according to the user settings" — i.e. you are
explicitly permitted to auto-answer based on a saved policy rather than
always prompting a human.

### 11.3 `RequestPermissionOutcome` — 2 variants

- `{"outcome": "selected", "optionId": "<id>"}` — user picked one of the given options.
- `{"outcome": "cancelled"}` — **mandatory** response if the current prompt
  turn is cancelled while this request is outstanding: "If the client
  cancels the prompt turn via `session/cancel`, it MUST respond to this
  request with `RequestPermissionOutcome::Cancelled`"
  (https://agentclientprotocol.com/protocol/v1/schema#session%2Frequest_permission).
  See §14.1 for the full cancellation interaction.

---

## 12. Client-exposed filesystem methods

Source: https://agentclientprotocol.com/protocol/v1/file-system,
https://agentclientprotocol.com/protocol/v1/schema

Both methods are gated: only implement/answer them if you advertised
`clientCapabilities.fs.readTextFile`/`.writeTextFile` at `initialize` time;
if you didn't, the agent "MUST NOT attempt to call" them. Their purpose is
letting the agent see/edit **unsaved editor buffer state**, not just what's
on disk — that's the reason these exist instead of the agent just doing its
own file I/O.

### 12.1 `fs/read_text_file`

```json
{"jsonrpc": "2.0", "id": 3, "method": "fs/read_text_file", "params": {"sessionId": "sess_abc123def456", "path": "/home/user/project/src/main.py", "line": 10, "limit": 50}}
```
```json
{"jsonrpc": "2.0", "id": 3, "result": {"content": "def hello_world():\n    print('Hello, world!')\n"}}
```
(https://agentclientprotocol.com/protocol/v1/file-system)

`sessionId` and `path` (absolute) required; `line?: integer | null` and
`limit?: integer | null` optional. **Minor primary-source inconsistency
worth flagging explicitly**: the prose doc calls `line` "Optional line
number to start reading from (**1-based**)", but the machine schema
(https://agentclientprotocol.com/protocol/v1/schema#readtextfilerequest)
states `Minimum: 0` for the same field with no mention of indexing base.
Both could be simultaneously true (a 1-based line count whose JSON Schema
constraint is merely "non-negative" and happens never to be exercised at 0),
so treat this as unresolved rather than a confirmed bug — see §23. Response
has exactly one field, `content: string`.

### 12.2 `fs/write_text_file`

```json
{"jsonrpc": "2.0", "id": 4, "method": "fs/write_text_file", "params": {"sessionId": "sess_abc123def456", "path": "/home/user/project/config.json", "content": "{\n  \"debug\": true,\n  \"version\": \"1.0.0\"\n}"}}
```
`sessionId`, `path` (absolute), `content` all required. "The Client **MUST**
create the file if it doesn't exist."
(https://agentclientprotocol.com/protocol/v1/file-system)

**Response-shape discrepancy between the prose doc and the schema, also
worth flagging explicitly**: the file-system.md walkthrough shows
```json
{"jsonrpc": "2.0", "id": 4, "result": null}
```
while the machine schema defines `WriteTextFileResponse` as an object type
whose only member is the universal optional `_meta`
(https://agentclientprotocol.com/protocol/v1/schema#writetextfileresponse) —
implying the "proper" empty success value is `{}`. Emit `{}` from your
client when answering this request (it satisfies both the object-typed
schema and any lenient agent expecting `null`), but when acting as a JSON-RPC
*caller* elsewhere in the protocol, be tolerant of agents that reply with a
bare `null` for "no-content" successes, since the docs' own examples do
this in at least two places (`session/load`'s response is likewise shown as
literal `null`, §6.2).

---

## 13. Client-exposed terminal methods

Source: https://agentclientprotocol.com/protocol/v1/terminals,
https://agentclientprotocol.com/protocol/v1/schema

Gated by the single boolean `clientCapabilities.terminal` (there is no
per-sub-method granularity — it's all five methods or none): "If `terminal`
is `false` or not present, the Agent **MUST NOT** attempt to call any
terminal methods." These let the agent run shell commands inside your
environment with live output streaming and out-of-band kill/wait control.

### 13.1 `terminal/create` — starts a command, returns immediately

```json
{
  "jsonrpc": "2.0", "id": 5, "method": "terminal/create",
  "params": {
    "sessionId": "sess_abc123def456", "command": "npm", "args": ["test", "--coverage"],
    "env": [{"name": "NODE_ENV", "value": "test"}], "cwd": "/home/user/project", "outputByteLimit": 1048576
  }
}
```
```json
{"jsonrpc": "2.0", "id": 5, "result": {"terminalId": "term_xyz789"}}
```
(https://agentclientprotocol.com/protocol/v1/terminals)

`sessionId`, `command` required; `args?`, `env?`, `cwd?` (absolute if
present), `outputByteLimit?: integer | null` (min `0`) all optional. Buffer
truncation rule, quoted verbatim: "Once exceeded, earlier output is
truncated to stay within this limit... the Client truncates from the
beginning of the output... The Client **MUST** ensure truncation happens at
a character boundary to maintain valid string output, even if this means
the retained output is slightly less than the specified limit" — i.e.
truncate on the *front*, and respect UTF-8/UTF-16 code-unit boundaries so you
never hand back a mangled multi-byte character.

The call returns a `terminalId` **without waiting for the process to
exit** — "This allows the command to run in the background while the Agent
performs other operations." **You (the client) own releasing it** — "The
Agent MUST release the terminal using `terminal/release` when it's no
longer needed" is stated as the agent's obligation, but as the client you
must keep the terminal's resources (PTY/process handle, output buffer)
alive until that `terminal/release` call arrives.

### 13.2 `terminal/output` — poll current output + exit status, non-blocking

```json
{"jsonrpc": "2.0", "id": 6, "method": "terminal/output", "params": {"sessionId": "sess_abc123def456", "terminalId": "term_xyz789"}}
```
```json
{"jsonrpc": "2.0", "id": 6, "result": {"output": "Running tests...\n✓ All tests passed (42 total)\n", "truncated": false, "exitStatus": {"exitCode": 0, "signal": null}}}
```
`output` and `truncated` required; `exitStatus?: TerminalExitStatus | null`
present only once the process has exited — `{exitCode: integer | null, signal: string | null}`.
(https://agentclientprotocol.com/protocol/v1/terminals)

### 13.3 `terminal/wait_for_exit` — blocks until the command exits

```json
{"jsonrpc": "2.0", "id": 7, "method": "terminal/wait_for_exit", "params": {"sessionId": "sess_abc123def456", "terminalId": "term_xyz789"}}
```
```json
{"jsonrpc": "2.0", "id": 7, "result": {"exitCode": 0, "signal": null}}
```
Note the response shape here is the **bare** `{exitCode, signal}` pair, not
wrapped in an `exitStatus` key like `terminal/output`'s response — these are
two structurally distinct (if field-identical) response types
(`WaitForTerminalExitResponse` vs. `TerminalOutputResponse.exitStatus:
TerminalExitStatus`) — don't assume you can share one deserializer for both.
(https://agentclientprotocol.com/protocol/v1/terminals)

### 13.4 `terminal/kill` — end the process, keep the terminal handle valid

```json
{"jsonrpc": "2.0", "id": 8, "method": "terminal/kill", "params": {"sessionId": "sess_abc123def456", "terminalId": "term_xyz789"}}
```
Empty-object result. Unlike `terminal/release`, the `terminalId` **stays
usable** afterward for `terminal/output` (to fetch final output) and
`terminal/wait_for_exit` (to fetch the exit status) — this is the documented
building block for agent-side timeouts: create → race a timer against
`wait_for_exit` → on timeout, `kill` then `output` then still `release`.
(https://agentclientprotocol.com/protocol/v1/terminals, "Building a Timeout")

### 13.5 `terminal/release` — free all resources, invalidate the id

```json
{"jsonrpc": "2.0", "id": 9, "method": "terminal/release", "params": {"sessionId": "sess_abc123def456", "terminalId": "term_xyz789"}}
```
"Kills the command if still running and releases all resources." After this
call, "the terminal ID becomes invalid for all other `terminal/*` methods" —
**except** that if this terminal was ever embedded in a tool call via
`ToolCallContent::terminal` (§10.5), "the client **SHOULD** continue to
display its output after release" — i.e. release the process/resources but
don't erase the already-rendered transcript.
(https://agentclientprotocol.com/protocol/v1/terminals)


---

## 14. Cancellation — two distinct mechanisms, do not conflate them

Source: https://agentclientprotocol.com/protocol/v1/cancellation,
https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation,
https://agentclientprotocol.com/protocol/v1/schema

### 14.1 `session/cancel` — prompt-turn cancellation (notification, client → agent)

```json
{"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": "sess_abc123def456"}}
```
This is the one you'll use in practice — "the user cancelled the prompt"
button. It is a **notification** (no `id`, no response to this message
itself). Instead, its effect surfaces as the *eventual response to the
original `session/prompt` request*, which the agent must resolve with
`stopReason: "cancelled"` (§7.3).

Exact obligations on both sides, quoted verbatim
(https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation):

> The Client **SHOULD** preemptively mark all non-finished tool calls
> pertaining to the current turn as `cancelled` as soon as it sends the
> `session/cancel` notification.
>
> The Client **MUST** respond to all pending `session/request_permission`
> requests with the `cancelled` outcome.
>
> When the Agent receives this notification, it **SHOULD** stop all
> language model requests and all tool call invocations as soon as
> possible.
>
> After all ongoing operations have been successfully aborted and pending
> updates have been sent, the Agent **MUST** respond to the original
> `session/prompt` request with the `cancelled` stop reason.

And the important "don't let this leak as a visible error" warning aimed at
agent implementers (useful for you to know so you can sanity-check an
agent's behavior, and to *not* surface a scary error toast to the user if
you do see one slip through):

> API client libraries and tools often throw an exception when their
> operation is aborted, which may propagate as an error response to
> `session/prompt`. Clients often display unrecognized errors from the Agent
> to the user, which would be undesirable for cancellations as they aren't
> considered errors. Agents **MUST** catch these errors and return the
> semantically meaningful `cancelled` stop reason.

Also note: the agent **may** still send `session/update` notifications
after it received your `session/cancel`, as long as they land before its
`session/prompt` response — "The Client **SHOULD** still accept tool call
updates received after sending `session/cancel`." Don't drop updates on the
floor just because you're in a "cancelling" state client-side.

### 14.2 `$/cancel_request` — generic per-request cancellation (notification, either direction)

This is a completely separate, protocol-level mechanism (deliberately named
after LSP's `$/cancelRequest`) for cancelling **any single outstanding
JSON-RPC request**, not specifically a prompt turn. Quoted verbatim
(https://agentclientprotocol.com/protocol/v1/cancellation):

```json
{"jsonrpc": "2.0", "method": "$/cancel_request", "params": {"requestId": <RequestId of the request to cancel>}}
```

> Cancellation remains optional as it might not be implementable in all
> clients or servers... When a `$/cancel_request` notification is received
> by a supporting implementation, the implementation:
> * **MAY** cancel the corresponding request activity and all nested
>   activities related to that request
> * **MAY** finish sending any pending notifications before responding
> * **MUST** send one of these responses for the original request:
>   * A valid response with appropriate data (such as partial results or
>     cancellation marker)
>   * An error response with code `-32800` (Request Cancelled)

Implementations may also self-cancel without receiving this notification
("Internal Cancellation" — client closes the IDE, agent hits a context
limit, etc.) and **SHOULD** respond with the same `-32800` error in that
case, "to ensure consistent behavior regardless of cancellation source."

**Why both exist, illustrated by the spec's own cascading example**
(https://agentclientprotocol.com/protocol/v1/cancellation): a single
`session/cancel` for a prompt turn can cause the agent to internally issue
*multiple* `$/cancel_request` notifications — one per outstanding nested
request it had open with you (e.g. a `terminal/create` call and a
`session/request_permission` call it was waiting on) — each of which you
must answer with a `-32800` error, before the agent finally resolves the
*original* `session/prompt` with `stopReason: "cancelled"`. So: implement
`$/cancel_request` handling as a generic "abort whatever request this id
refers to and reply with -32800" utility, independent of your
`session/cancel` handling.

`RequestId` for `$/cancel_request`'s `requestId` param is the same union as
the JSON-RPC envelope `id` (`null | number | string`) — see §3.

---

## 15. Error codes

Source: https://agentclientprotocol.com/protocol/v1/schema#errorcode
(cross-verified byte-for-byte against the canonical `schema.json`,
`schema-v1.21.0`, https://github.com/agentclientprotocol/agent-client-protocol/releases/latest/download/schema.json)

> These codes follow the JSON-RPC 2.0 specification for standard errors and
> use the reserved range (-32000 to -32099) for protocol-specific errors.

| Code | Name | Meaning |
|---|---|---|
| `-32700` | Parse error | "Invalid JSON was received by the server." |
| `-32600` | Invalid request | "The JSON sent is not a valid Request object." |
| `-32601` | Method not found | "The method does not exist or is not available." |
| `-32602` | Invalid params | "Invalid method parameter(s)." |
| `-32603` | Internal error | "Reserved for implementation-defined server errors." |
| `-32800` | Request cancelled | used by both cancellation mechanisms (§14) |
| `-32000` | Authentication required | pre-auth call to an auth-gated method (§5) |
| `-32002` | Resource not found | "A given resource, such as a file, was not found." |
| (any other) | Other | "Other undefined error code" — the schema explicitly allows arbitrary additional integer codes beyond this named set; treat any code you don't recognize as an opaque, generic failure rather than erroring your parser |

Note that only **two** codes are named in the -32000..-32099 ACP-reserved
band (`-32000`, `-32002`) — `-32001`, `-32003`, etc. are not currently
assigned to anything by the spec; do not infer meaning for them if an agent
sends one. The standard `Error` object shape wrapping any of these codes is
plain JSON-RPC 2.0: `{code: integer, message: string, data?: object}`.


---

## 16. Elicitation

Source: https://agentclientprotocol.com/protocol/v1/elicitation,
https://agentclientprotocol.com/protocol/v1/schema

A secondary but fully-specified part of v1: lets the agent ask the user for
structured input (beyond the plain chat/tool-call flow), adapted from "the
locked MCP 2026-07-28 release-candidate elicitation specification." Two
modes, `form` (a restricted-JSON-Schema-driven form) and `url` (an
out-of-band browser interaction, e.g. OAuth). Gated by
`clientCapabilities.elicitation.form`/`.url` — recall from §4.4 that, unlike
MCP, ACP requires each mode to be explicitly and separately advertised;
`{}` alone means *no* modes are supported.

### 16.1 Requests are scoped two ways at once (mode × scope), flattened into one object

`elicitation/create` is a request (agent → client) whose JSON body is the
*flattening* of two independent unions: a **scope** (`ElicitationSessionScope`:
`{sessionId, toolCallId?}`, or `ElicitationRequestScope`: `{requestId}`) and a
**mode** (`form`, `url`, or an unknown/future `other`). `_meta` and
`message: string` (required) are shared across every combination.
(https://agentclientprotocol.com/protocol/v1/schema#createelicitationrequest,
https://agentclientprotocol.com/protocol/v1/elicitation)

Form mode, session-scoped:
```json
{
  "jsonrpc": "2.0", "id": 43, "method": "elicitation/create",
  "params": {
    "sessionId": "sess_abc123", "mode": "form",
    "message": "How should I approach this refactoring?",
    "requestedSchema": {"type": "object", "properties": {"strategy": {"type": "string", "enum": ["conservative", "balanced", "aggressive"]}}, "required": ["strategy"]}
  }
}
```
URL mode, request-scoped (outside any session — e.g. during auth):
```json
{
  "jsonrpc": "2.0", "id": 44, "method": "elicitation/create",
  "params": {
    "requestId": 12, "mode": "url", "elicitationId": "github-oauth-001",
    "url": "https://agent.example.com/connect?elicitationId=github-oauth-001",
    "message": "Please authorize access to your repositories."
  }
}
```
(https://agentclientprotocol.com/protocol/v1/elicitation)

### 16.2 Response — `accept` / `decline` / `cancel`

```json
{"jsonrpc": "2.0", "id": 43, "result": {"action": "accept", "content": {"strategy": "balanced"}}}
```
`content` is only meaningful (and only schema-validated) on `accept`; it's
optional there too (omit for a URL-mode accept, since "the interaction
happens out of band"), and is ignored for `decline`/`cancel`.
(https://agentclientprotocol.com/protocol/v1/elicitation)

### 16.3 Hard requirements worth surfacing verbatim

> Form mode **MUST NOT** be used to request secrets or credentials that
> grant access or authorize transactions, such as passwords, API keys,
> access or refresh tokens, private keys, recovery codes, or payment
> credentials... If the Client does not support URL mode, the Agent **MUST
> NOT** fall back to form mode; it must use another safe flow or fail the
> operation.
>
> Clients **MUST NOT** prefetch the URL or open it without explicit user
> consent. They **MUST** show the full URL before asking for consent...
> Clients **MUST** open the URL in a secure context that prevents the
> Client or Agent's language model from inspecting the page or user input.

For URL mode specifically, an `elicitationId` uniquely identifies the
out-of-band interaction; the agent may later send a fire-and-forget
`elicitation/complete` **notification** once that external flow finishes:
```json
{"jsonrpc": "2.0", "method": "elicitation/complete", "params": {"elicitationId": "github-oauth-001"}}
```
"Clients **MUST** ignore unknown or already-completed IDs." A request for a
mode you never advertised produces a `-32602` Invalid params error (§15).
(All of §16: https://agentclientprotocol.com/protocol/v1/elicitation)

---

## 17. Session Modes (legacy) and Session Config Options (current)

Source: https://agentclientprotocol.com/protocol/v1/session-modes,
https://agentclientprotocol.com/protocol/v1/session-config-options

The spec explicitly documents these as **the same concept at two points in
time** — Session Modes is the older, narrower mechanism (a single named
"mode" like ask/architect/code); Session Config Options is the newer,
general mechanism (arbitrary selectors: mode, model, reasoning level, or
anything else an agent wants to expose). Quoted verbatim
(https://agentclientprotocol.com/protocol/v1/session-modes): "Dedicated
session mode methods will be removed in a future version of the protocol.
Until then, you can offer both to clients for backwards compatibility."

### 17.1 Session Modes (`SessionModeState`)

Reported at session-setup time (`session/new`/`session/load`/`session/resume`
response's `modes` field) as `{currentModeId: string, availableModes: [{id, name, description?}]}`.
Client changes it with `session/set_mode`:
```json
{"jsonrpc": "2.0", "id": 2, "method": "session/set_mode", "params": {"sessionId": "sess_abc123def456", "modeId": "code"}}
```
→ `{"jsonrpc": "2.0", "id": 2, "result": {}}`. The agent may instead change
its own mode unilaterally and tell you via the `current_mode_update`
`session/update` variant (§8): `{"sessionUpdate": "current_mode_update", "modeId": "code"}`.
(https://agentclientprotocol.com/protocol/v1/session-modes)

### 17.2 Session Config Options (`SessionConfigOption[]`) — the preferred mechanism

Reported the same way (`session/new`/`load`/`resume` response's
`configOptions` field), each entry shaped as either:
- `type: "select"`: `{id, name, description?, category?, type: "select", currentValue: string, options: [{value, name, description?}]}`
- `type: "boolean"`: `{id, name, description?, category?, type: "boolean", currentValue: boolean}` — **only** legal if the client advertised `clientCapabilities.session.configOptions.boolean: {}`; "Agents **MUST NOT** include `type: "boolean"` options in `configOptions` payloads unless the Client advertised support."

Example (https://agentclientprotocol.com/protocol/v1/session-config-options):
```json
{"id": "mode", "name": "Session Mode", "description": "Controls how the agent requests permission", "category": "mode", "type": "select", "currentValue": "ask", "options": [{"value": "ask", "name": "Ask", "description": "Request permission before making any changes"}, {"value": "code", "name": "Code", "description": "Write and modify code with full tool access"}]}
```
Client sets a value with `session/set_config_option`:
```json
{"jsonrpc": "2.0", "id": 2, "method": "session/set_config_option", "params": {"sessionId": "sess_abc123def456", "configId": "mode", "value": "code"}}
```
(boolean variant additionally sends `"type": "boolean"` alongside a boolean
`value`). **The response always contains the full config-option state
again** (not just the one you changed) — "This allows Agents to reflect
dependent changes... if changing the model affects available reasoning
options." Same full-state-replacement rule applies to the agent-initiated
`config_option_update` notification (§8).

Known `category` values (UX hints only, never required for correctness):
`mode`, `model`, `model_config`, `thought_level`, plus an open `_`-prefixed
namespace for custom categories.
(https://agentclientprotocol.com/protocol/v1/session-config-options)

**Precedence when an agent sends both** (transition period): "Clients that
support config options **SHOULD** use `configOptions` exclusively and
ignore `modes`... Clients that don't support config options **SHOULD** fall
back to `modes`." Build your client to prefer `configOptions` and treat
`modes` purely as a fallback for agents that haven't migrated.

---

## 18. Slash commands

Source: https://agentclientprotocol.com/protocol/v1/slash-commands

Agents advertise a catalog via the `available_commands_update`
`session/update` variant (§8):
```json
{"sessionUpdate": "available_commands_update", "availableCommands": [{"name": "web", "description": "Search the web for information", "input": {"hint": "query to search for"}}, {"name": "test", "description": "Run tests for the current project"}]}
```
`AvailableCommand = {name: string, description: string, input?: {hint: string}}`.
This is purely advisory metadata for building an autocomplete UI — **there
is no separate "run command" RPC**. Commands are invoked by including the
literal command text as a normal `text` content block inside an ordinary
`session/prompt` call:
```json
{"jsonrpc": "2.0", "id": 3, "method": "session/prompt", "params": {"sessionId": "sess_abc123def456", "prompt": [{"type": "text", "text": "/web agent client protocol"}]}}
```
The agent is solely responsible for recognizing the `/name` prefix; your
client's job is just to surface the catalog and let the prefix through
verbatim. The list can change mid-session (agent may resend the
notification at any time to add/remove/edit entries).
(https://agentclientprotocol.com/protocol/v1/slash-commands)

---

## 19. Extensibility

Source: https://agentclientprotocol.com/protocol/v1/extensibility

Already covered the `_meta` field rules in §3. The other mechanism is
underscore-prefixed custom **methods**:

```json
{"jsonrpc": "2.0", "id": 1, "method": "_zed.dev/workspace/buffers", "params": {"language": "rust"}}
```
"The protocol reserves any method name starting with an underscore (`_`) for
custom extensions." Custom **requests** must get a response (matching
`id`); custom **notifications** must not. If you receive a custom request
you don't recognize, reply with the standard `-32601` Method not found — do
**not** silently drop it (that's the treatment reserved for unrecognized
*notifications*, which "implementations **SHOULD** ignore"). Advertise
support for your own extensions via `_meta` on the relevant capability
object during `initialize`, e.g.:
```json
{"agentCapabilities": {"loadSession": true, "_meta": {"zed.dev": {"workspace": true, "fileNotifications": true}}}}
```
so callers can probe for the extension before using it rather than
discovering support via a failed call.
(https://agentclientprotocol.com/protocol/v1/extensibility)


---

## 20. Driving Claude as an ACP agent

**Claude Code (the `claude` CLI binary itself) does not speak ACP.** There is
no `--acp` flag, no hidden mode. Verified by: (a) `agentclientprotocol.com`'s
own curated agent list does **not** list "Claude Code" — it lists **"Claude
Agent"**, described as reachable "via Zed's SDK adapter"
(https://agentclientprotocol.com/get-started/agents); (b) Zed's own docs
draw the distinction explicitly (https://zed.dev/docs/ai/by-company,
fetched 2026-09-07):

| Path | Support level | What you get |
|---|---|---|
| Claude Agent via ACP | Hosted in Zed | "Claude in an External Agent thread" |
| Claude Code CLI | Run in terminal | "**Native** Claude Code experience in a **Terminal** Thread" (i.e. plain terminal, not ACP) |

### 20.1 The actual ACP-speaking program: `@agentclientprotocol/claude-agent-acp`

This is a standalone adapter that wraps the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk` — a different, lower-level package than the
`claude` CLI) and exposes it over ACP. It is a separately-versioned,
separately-installed package, not a mode switch on Claude Code.

- **npm package**: `@agentclientprotocol/claude-agent-acp`
  (https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) —
  **version observed: `0.75.1`** (checked 2026-09-07 via the npm registry API).
- **GitHub repo**: https://github.com/agentclientprotocol/claude-agent-acp —
  note this repo **moved** from `zed-industries/claude-agent-acp` (that URL
  now 301-redirects to the `agentclientprotocol` org, confirmed by a direct
  `curl -I` against `github.com/zed-industries/claude-agent-acp`). It was
  originally built and maintained by Zed and has since been transferred into
  the ACP org itself. Its `package.json` declares `"dependencies"` on
  `@agentclientprotocol/sdk` and `@anthropic-ai/claude-agent-sdk`, and
  `"engines": {"node": ">=22"}` — compatible with this project's pinned
  Node 24.12.0.
- **Binary / invocation**: `package.json` declares `"bin": {"claude-agent-acp": "dist/index.js"}`.
  To run it as a stdio ACP agent, spawn:
  ```
  npx @agentclientprotocol/claude-agent-acp
  ```
  (or, if installed, the bare `claude-agent-acp` binary) with **no special
  flag required** — the ordinary invocation *is* the ACP server; it speaks
  ACP over stdin/stdout immediately. Verified directly from the published
  entrypoint source, `src/index.ts`
  (https://raw.githubusercontent.com/agentclientprotocol/claude-agent-acp/main/src/index.ts,
  fetched 2026-09-07): the default branch (no recognized flag) calls
  `runAcp(logger)` and does `process.stdin.resume()` to keep the process
  alive across the ACP connection. The same file also confirms the process
  redirects `console.log`/`.info`/`.warn`/`.debug` to `console.error`
  specifically "to make sure it doesn't interfere with ACP" on stdout —
  independent confirmation of the "agent MUST NOT write non-ACP data to
  stdout" transport rule (§2).
- **Other flags found in the same source file** (for completeness, not
  needed for normal ACP use): `--cli` delegates straight through to the
  *real* underlying `claude` binary (found via an internal `claudeCliPath()`
  helper) for interactive passthrough use, bypassing ACP entirely;
  `--version`/`-v` prints the adapter's own version and exits.
- **Logging**: set `CLAUDE_AGENT_LOGS=<dir>` to have it write an
  `agent.log` file there; otherwise it logs nothing to disk.
- **Node requirement**: `>=22` per `package.json` `engines` — this
  project's pinned `24.12.0` satisfies it.

### 20.2 A same-named decoy package to avoid

`claude-code-acp` (no scope, **not** `@agentclientprotocol/claude-agent-acp`)
also exists on npm — **do not use it**. It is an unrelated, unofficial,
community package ("Claude Code agent for Zed Editor via Agent Client
Protocol", repo `github.com/carlrannaberg/cc-acp`), latest version `0.1.1`
published 2025-09-03, with no evident relationship to the ACP org or
Anthropic. Verified via the npm registry API 2026-09-07. The similarity of
the two names is an easy copy-paste mistake — double-check the scope
(`@agentclientprotocol/`) before installing.

### 20.3 What Claude-the-adapter supports (per its own README)

Quoted from https://raw.githubusercontent.com/agentclientprotocol/claude-agent-acp/main/README.md
(fetched 2026-09-07) — the adapter advertises support for: "Context
@-mentions, Images, Tool calls (with permission requests), Following, Edit
review, TODO lists, Nested subagent transcripts, Interactive (and
background) terminals, Custom Slash commands, Client MCP servers,"
plus several `_meta`/extension-based features layered on top of core ACP
(a "goal extension," a "session failure extension," and a "permission
extension" — all documented in that repo's `docs/` directory but **outside
core ACP v1** and not covered by this reference; treat them as optional
enhancements your client can ignore).

---

## 21. Driving Gemini CLI as an ACP agent

**Gemini CLI has native, first-party, built-in ACP support** — a real
contrast with Claude: no separate adapter package is needed.

- **npm package**: `@google/gemini-cli` (binary name `gemini`,
  `"bin": {"gemini": "bundle/gemini.js"}`, `"engines": {"node": ">=20"}` per
  its `package.json` — compatible with Node 24.12.0). **Version observed**:
  latest stable on the npm registry is `0.58.0`; the `main` branch of the
  GitHub repo was at a nightly `0.60.0-nightly.20260901.g0bd1d4397` when
  checked 2026-09-07 (https://registry.npmjs.org/@google/gemini-cli,
  https://raw.githubusercontent.com/google-gemini/gemini-cli/main/package.json).
- **Invocation**:
  ```
  gemini --acp
  ```
  This is the **current, documented, non-deprecated** flag. Confirmed
  directly in source, `packages/cli/src/config/config.ts`
  (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/config/config.ts,
  fetched 2026-09-07):
  ```ts
  .option('acp', { type: 'boolean', description: 'Starts the agent in ACP mode' })
  .option('experimental-acp', { type: 'boolean', description: 'Starts the agent in ACP mode (deprecated, use --acp instead)' })
  ```
  and `const isAcpMode = !!argv.acp || !!argv.experimentalAcp;` — i.e.
  **either flag works today**, but `--experimental-acp` is explicitly
  marked deprecated in favor of `--acp` in the source. **Primary-source
  discrepancy worth flagging**: the shipped docs page
  `docs/cli/acp-mode.md` (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/acp-mode.md)
  correctly tells users to run `gemini --acp`, but the separate CLI-flags
  reference table in `docs/cli/cli-reference.md` still lists only
  `--experimental-acp` and calls it "**Experimental feature**" — that
  second doc page has not been updated to match the source-level
  deprecation. Use `--acp`; don't be misled by the stale reference table.
- **Transport confirmation** (independent second source for §2's framing
  rule): Gemini's own ACP implementation notes
  (`packages/cli/src/acp/README.md`) state its `acpStdioTransport.ts`
  "sets up the Web streams for standard input/output and creates the
  `AgentSideConnection` using line-delimited JSON (ndjson)" — matching this
  document's stdio/newline framing exactly.
- **Debugging**: `gemini --acp --debug` for verbose logs; or set
  `GEMINI_TELEMETRY_ENABLED=true GEMINI_TELEMETRY_TARGET=local GEMINI_TELEMETRY_OUTFILE=/path/to/log.json`
  for a structured telemetry log including ACP request/response events.
  (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/acp-mode.md)
- **Client-side note found in Gemini's own docs**: "ACP includes a proxied
  file system service. This means that when the agent needs to read or
  write files, it does so through the ACP client" — i.e. Gemini CLI in ACP
  mode is written to actively prefer your `fs/read_text_file`/`fs/write_text_file`
  over touching disk directly, so make sure your client actually advertises
  and implements both if you want Gemini to see unsaved buffer state (same
  point applies to Claude's adapter, which advertises "Following" / "Edit
  review" as relying on the same client-side fs methods).
- **ACP is cited as the reference-quality implementation to study**: the
  ACP project's own TypeScript library docs page recommends it — "For a
  complete, production-ready implementation of an ACP agent, check out
  [Gemini CLI]" (https://agentclientprotocol.com/libraries/typescript,
  linking to `github.com/google-gemini/gemini-cli/tree/main/packages/cli/src/acp`).

---

## 22. Quick-reference: every v1 method, who calls it, and its gate

"Client" = your ACP client (this project). "Agent" = the spawned
Claude/Gemini subprocess. Direction is the JSON-RPC **caller** →
**callee**. All sourced from https://agentclientprotocol.com/protocol/v1/schema
and the per-topic pages cited throughout this document.

| Method | Direction | Kind | Capability gate |
|---|---|---|---|
| `initialize` | Client → Agent | request | none (first call) |
| `authenticate` | Client → Agent | request | agent advertised a matching `agent`-type `authMethods` entry |
| `logout` | Client → Agent | request | `agentCapabilities.auth.logout` present |
| `session/new` | Client → Agent | request | none (baseline) |
| `session/load` | Client → Agent | request | `agentCapabilities.loadSession` |
| `session/resume` | Client → Agent | request | `agentCapabilities.sessionCapabilities.resume` |
| `session/close` | Client → Agent | request | `agentCapabilities.sessionCapabilities.close` |
| `session/delete` | Client → Agent | request | `agentCapabilities.sessionCapabilities.delete` |
| `session/list` | Client → Agent | request | `agentCapabilities.sessionCapabilities.list` |
| `session/prompt` | Client → Agent | request | none (baseline) |
| `session/cancel` | Client → Agent | **notification** | none (baseline) |
| `session/set_mode` | Client → Agent | request | agent returned `modes` at session setup |
| `session/set_config_option` | Client → Agent | request | agent returned `configOptions` at session setup |
| `session/update` | Agent → Client | **notification** | none (baseline) |
| `session/request_permission` | Agent → Client | request | none (baseline client method) |
| `fs/read_text_file` | Agent → Client | request | `clientCapabilities.fs.readTextFile` |
| `fs/write_text_file` | Agent → Client | request | `clientCapabilities.fs.writeTextFile` |
| `terminal/create` | Agent → Client | request | `clientCapabilities.terminal` |
| `terminal/output` | Agent → Client | request | `clientCapabilities.terminal` |
| `terminal/wait_for_exit` | Agent → Client | request | `clientCapabilities.terminal` |
| `terminal/kill` | Agent → Client | request | `clientCapabilities.terminal` |
| `terminal/release` | Agent → Client | request | `clientCapabilities.terminal` |
| `elicitation/create` | Agent → Client | request | `clientCapabilities.elicitation.form`/`.url` (per mode used) |
| `elicitation/complete` | Agent → Client | **notification** | (URL-mode elicitation was used) |
| `$/cancel_request` | either → either | **notification** | none, but support itself is optional |

---

## 23. Unverified

Everything above was traced to a primary source and, wherever two sources
existed (a prose doc page and the machine schema; or the spec site and an
implementation's own source), cross-checked between them. The following
points either could not be resolved from primary sources, or are primary
sources visibly disagreeing with each other — flagged rather than guessed:

1. **`line` field indexing base, `ToolCallLocation` vs. `fs/read_text_file`**
   (§10.6, §12.1): `fs/read_text_file`'s prose doc explicitly says its
   `line` param is "1-based," but both that field and `ToolCallLocation.line`
   carry a machine-schema constraint of `Minimum: 0`. It is not possible to
   tell from the spec alone whether `ToolCallLocation.line` is 0-based (a
   real inconsistency with the rest of the protocol's stated 1-based
   convention) or whether `Minimum: 0` is simply a generic non-negativity
   constraint applied uniformly to integer fields regardless of indexing
   base. Recommendation: do not assume 0-based; render whatever value an
   agent sends as-is and don't do off-by-one arithmetic on it.
2. **Exact JSON-RPC success-result convention for "no data" responses**
   (§6.2, §12.2): the spec's own worked examples show at least two
   different renderings of an empty/void success — literal `result: null`
   (`session/load`, `fs/write_text_file` in the prose walkthroughs) versus
   an empty object `{}` implied by the corresponding schema type (which
   defines only an optional `_meta` field and nothing else). Both are valid
   JSON-RPC 2.0 and this document could not find a rule stating clients
   must accept only one form — treat `null` and `{}` as equivalent "void
   success" on receipt, and prefer emitting `{}` yourself.
3. **Streamable HTTP / WebSocket transport**: confirmed to be an active RFD
   (https://agentclientprotocol.com/rfds/streamable-http-websocket-transport)
   with a named champion and authors, but with no merged/stabilized spec
   page, no schema entries, and no shipped implementation found in either
   the Claude or Gemini agents checked for this document. Do not build
   against it; this document deliberately omits any wire details for it
   beyond the "proposed shape" summarized in §2, since nothing there is
   final.
4. **v2 timeline**: the v2 draft announcement gives no committed
   stabilization date, only "closer to stabilization" as an unspecified
   future point. This document cannot tell you when (or whether) v1-only
   clients will need a v2 upgrade path; monitor
   https://agentclientprotocol.com/updates and
   https://agentclientprotocol.com/protocol/v2/overview periodically rather
   than treating v1 as permanently frozen.
5. **Whether Gemini CLI's `--acp` flag output is byte-identical to a fresh
   spawn on every version**: this document verified the flag and framing
   against the `main` branch of `google-gemini/gemini-cli` (nightly
   `0.60.0-nightly.20260901.g0bd1d4397`) and cross-checked the flag's
   existence against the latest stable npm release metadata (`0.58.0`), but
   did **not** execute either binary end-to-end against a live ACP client
   to observe an actual `initialize` handshake on the wire — this is a
   source-code-level verification, not a runtime capture. The same caveat
   applies to `@agentclientprotocol/claude-agent-acp` (`0.75.1`): verified
   from its published source and `package.json`, not from an executed
   session. Before shipping, do a live smoke test against both: spawn each
   process, send a real `initialize`, and confirm the response shape
   matches §4 exactly for the installed version.
6. **`session/prompt`'s interaction with `PromptCapabilities` for content
   the client sends vs. receives**: the spec is explicit that
   `promptCapabilities` gates what the **client may put into** a
   `session/prompt` request (§7.2). It does not separately state whether
   those same flags constrain what content types the **agent may emit**
   in `session/update` message chunks flowing the other direction (i.e.,
   can an agent send `image`/`audio` content blocks in its own
   `agent_message_chunk` output even if it advertised
   `promptCapabilities.image: false`, since that flag is about inbound
   prompts?). Treat output-side content blocks as ungated by
   `promptCapabilities` and be prepared to render any of the five
   `ContentBlock` variants regardless of what capabilities were negotiated.


---

## 24. Source index

Spec site (Mintlify docs, each `.md` suffix fetched as raw markdown to avoid
lossy rendering):
- https://agentclientprotocol.com/llms.txt — sitemap used to enumerate every page below
- https://agentclientprotocol.com/get-started/introduction
- https://agentclientprotocol.com/get-started/architecture
- https://agentclientprotocol.com/get-started/agents
- https://agentclientprotocol.com/get-started/clients
- https://agentclientprotocol.com/protocol/v1/overview
- https://agentclientprotocol.com/protocol/v1/transports
- https://agentclientprotocol.com/protocol/v1/initialization
- https://agentclientprotocol.com/protocol/v1/authentication
- https://agentclientprotocol.com/protocol/v1/session-setup
- https://agentclientprotocol.com/protocol/v1/session-list
- https://agentclientprotocol.com/protocol/v1/session-delete
- https://agentclientprotocol.com/protocol/v1/prompt-turn
- https://agentclientprotocol.com/protocol/v1/content
- https://agentclientprotocol.com/protocol/v1/tool-calls
- https://agentclientprotocol.com/protocol/v1/elicitation
- https://agentclientprotocol.com/protocol/v1/file-system
- https://agentclientprotocol.com/protocol/v1/cancellation
- https://agentclientprotocol.com/protocol/v1/terminals
- https://agentclientprotocol.com/protocol/v1/agent-plan
- https://agentclientprotocol.com/protocol/v1/session-modes
- https://agentclientprotocol.com/protocol/v1/session-config-options
- https://agentclientprotocol.com/protocol/v1/slash-commands
- https://agentclientprotocol.com/protocol/v1/extensibility
- https://agentclientprotocol.com/protocol/v1/schema (the full machine-oriented schema reference page, ~5,900 lines, used as the ground truth for every field table in this document)
- https://agentclientprotocol.com/protocol/v2/overview
- https://agentclientprotocol.com/protocol/v2/migration
- https://agentclientprotocol.com/announcements/acp-v2-draft
- https://agentclientprotocol.com/libraries/typescript
- https://agentclientprotocol.com/rfds/streamable-http-websocket-transport

Canonical machine schema (downloaded and diffed against the rendered
`schema.md` page above for §15's error-code table):
- https://github.com/agentclientprotocol/agent-client-protocol/releases/latest/download/schema.json — resolved release `schema-v1.21.0`, published 2026-08-20

GitHub org / repos (`agentclientprotocol`), enumerated via the GitHub API
(`api.github.com/orgs/agentclientprotocol/repos`) 2026-09-07:
`agent-client-protocol`, `claude-agent-acp`, `python-sdk`, `kotlin-sdk`,
`typescript-sdk`, `rust-sdk`, `symposium-acp`, `java-sdk`, `codex-acp`,
`registry`, `docs`, `acpr`, `meetings`.

Claude adapter:
- https://github.com/agentclientprotocol/claude-agent-acp (README, `package.json`, `src/index.ts` fetched raw via `raw.githubusercontent.com`)
- https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp/latest (npm registry API — version `0.75.1`)
- https://registry.npmjs.org/claude-code-acp (npm registry API — the unrelated decoy package, version `0.1.1`)
- `curl -I https://github.com/zed-industries/claude-agent-acp` — confirms 301 redirect to the `agentclientprotocol` org

Gemini CLI:
- https://github.com/google-gemini/gemini-cli — `docs/cli/acp-mode.md`, `docs/cli/cli-reference.md`, `packages/cli/src/config/config.ts`, `packages/cli/src/acp/README.md`, root `package.json` (all fetched raw via `raw.githubusercontent.com`), searched with `gh search code ... --repo google-gemini/gemini-cli`
- https://registry.npmjs.org/@google/gemini-cli/latest (npm registry API — version `0.58.0` stable)

Secondary/consumer-side confirmation (Zed, the reference ACP client — used
only to corroborate the Claude-Code-vs-Claude-Agent distinction in §20, not
as a source of wire-format detail):
- https://zed.dev/docs/ai/external-agents
- https://zed.dev/docs/ai/by-company

All version numbers, redirects, and file contents above were fetched live on
2026-09-07 and may drift; re-check before relying on an exact version string
in production.
