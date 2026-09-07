# Claude adapter: install and sign-in, as observed

Verified 2026-09-07 against `@agentclientprotocol/claude-agent-acp` 0.75.1
(depends on `@anthropic-ai/claude-agent-sdk` 0.3.257) by reading its shipped
`dist/` and by two wire probes with a raw stdio harness. Every probe used an
isolated `CLAUDE_CONFIG_DIR` so the operator's real login was neither read
nor touched. Captures live in scratch, never in the tree; quotes below are
redacted (`code=`, `state=`, `code_challenge=` values removed).

## 1. The adapter brings Claude Code with it

`@anthropic-ai/claude-agent-sdk` has per-platform optional dependencies
(`@anthropic-ai/claude-agent-sdk-darwin-arm64` here) whose payload is the
native `claude` binary — the SDK's `manifest.json` lists `darwin-arm64`,
`darwin-x64`, `linux-x64`, `linux-arm64` (+musl) builds at ~200 MB each. An
`npm install @agentclientprotocol/claude-agent-acp` therefore yields a
complete, runnable Claude Code with no separate install step by the user.

Consequence for the app: "Install Claude" = run npm (with the app's bundled
Node) into the app data directory. Nothing else.

## 2. Sign-in is offered over ACP, but only if the client asks

`initialize` returns `authMethods: []` **unless** the client advertises
`clientCapabilities.auth.terminal: true` (spec §5.3 terminal auth) or the
adapter's own `_meta["terminal-auth"]: true`. With either, and no SSH/remote
environment markers, the adapter returns two `type: "terminal"` methods:

```json
{ "id": "claude-ai-login", "name": "Claude Subscription",
  "description": "Use Claude subscription ", "type": "terminal",
  "args": ["--cli", "auth", "login", "--claudeai"],
  "_meta": { "terminal-auth": { "command": "<node>", "args": ["<adapter>/dist/index.js", "--cli", "auth", "login", "--claudeai"], "label": "Claude Login" } } }
{ "id": "console-login", "name": "Anthropic Console",
  "description": "Use Anthropic Console (API usage billing)", "type": "terminal",
  "args": ["--cli", "auth", "login", "--console"], "_meta": { "...": "same shape, --console" } }
```

The `_meta["terminal-auth"]` block appears **only** when the client also
sends the adapter's own flag `clientCapabilities._meta["terminal-auth"]:
true`; with the spec capability alone (`auth.terminal: true`) the two methods
come back without `_meta`. Verified through the engine client after the §6
change: `authMethods` = `claude-ai-login`, `console-login`, both `terminal`,
`terminalAuthLaunch` derives `node <adapter> --cli auth login --claudeai`
from the connection's own command, and `authenticate()` on either is refused
locally per #5.3.

In a remote environment (`SSH_CONNECTION`, `NO_BROWSER`, `CLAUDE_CODE_REMOTE`
…) it offers a single `claude-login` method with `args: ["--cli"]` — the
interactive TUI — because the device-code fallback "doesn't work well over
ACP" (adapter source comment).

The engine's client currently hardcodes `clientCapabilities` to all-`false`
(`session.ts` `buildInitializeParams`) and so never sees these. It already
has `terminalAuthLaunch(methodId)` (§5.3) which derives the launch line from
the connection's own command; only the capability advertisement is missing.

## 3. Auth state is a notification, and sessions open regardless

Right after `initialize` the adapter sends
`_auth/status_update {"authStatus":{"kind":"none","label":"Not logged in"}}`
when signed out. `session/new` **still succeeds** signed out — modes and
config options come back normally — and the failure surfaces at the prompt
turn ("Not logged in · Please run /login", which the adapter recognises as a
synthetic login message). So: read `_auth/status_update`, do not infer auth
from `session/new` succeeding.

## 4. The login command runs headless

`node <adapter>/dist/index.js --cli auth login --claudeai` with stdin at
`/dev/null` and no TTY:

- prints `Opening browser to sign in…` and the authorize URL
  (`https://claude.com/cai/oauth/authorize?...&redirect_uri=http://localhost:<port>/callback&scope=...`)
- invokes `open <url>` from PATH (captured by a stub `open`; a second URL
  with a `platform.claude.com` redirect is printed as the manual fallback)
- waits for the localhost callback; on SIGTERM exits 143 having written a
  `.claude.json` (423 bytes, no credentials) into `CLAUDE_CONFIG_DIR`.

So the app can run this exact command as a child, let `open` raise the
user's browser, wait for exit 0, then re-read `_auth/status_update` on the
next `initialize`. No terminal window, no pasted codes on the default path.
Not exercised here: the completed callback (that requires a real sign-in).

## 5. What this settles for the app

| question | answer |
| --- | --- |
| must the user install Claude Code? | no — the adapter's npm install includes the binary |
| must the app bundle Node? | yes — the adapter is JS; bundled Node also runs the engine sidecar |
| how does "Sign in" work? | advertise `auth.terminal`, take `claude-ai-login`'s launch line, spawn it, wait |
| how does the app know it worked? | `_auth/status_update` on the next connection, `kind` ≠ `none` |
| subscription vs API billing? | two methods; the picker shows both |
| isolation for tests | `CLAUDE_CONFIG_DIR` — the CLI honours it for config and credentials |

## 6. Engine change this requires (spec for the oracle)

`ConnectOptions` gains one optional field:

```ts
clientCapabilities?: { auth?: { terminal?: boolean } }
```

- **Default unchanged.** With the field omitted, `initialize` carries exactly
  what it carries today: `{ fs: { readTextFile: false, writeTextFile: false },
  terminal: false }` and **no** `auth` key (lifecycle.test.ts's existing
  assertion stays valid byte-for-byte).
- With `clientCapabilities: { auth: { terminal: true } }`, the `initialize`
  params' `clientCapabilities` is `{ fs: {…false…}, terminal: false, auth:
  { terminal: true } }`. `fs` and `terminal` stay `false` regardless — this
  client still implements neither, and the option cannot turn them on.
- `{ auth: { terminal: false } }` sends `auth: { terminal: false }` explicitly.
- `terminalAuthLaunch(methodId)` is unchanged: given a `type: "terminal"`
  method carrying `args`, it returns the connection's own `command`, the
  connection's `args` followed by the method's `args`, merged `env`, and
  `cwd`. A method that also carries `_meta["terminal-auth"]` (the Claude
  adapter does, §2) is **not** consulted — the spec's derivation from the
  base launch wins, and `_meta` is passed through untouched on the
  `AuthMethod` object so a caller may read it.
- `AuthMethod` gains an optional `_meta?: Record<string, unknown>` field,
  preserved from the wire when present (§4.4-style pass-through, no
  validation of its contents).
