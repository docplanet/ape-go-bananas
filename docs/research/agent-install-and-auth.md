# How Zed installs and signs in "external agents" over ACP

Researched 2026-09-07. Sources read (all fetched that day):

- https://zed.dev/docs/ai/external-agents.md (and `/docs/llms.txt`, `/docs/ai/by-company.md`)
- https://agentclientprotocol.com/get-started/registry and https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
- https://github.com/agentclientprotocol/registry — `agent.schema.json`
- Zed source, `main` branch, github.com/zed-industries/zed:
  `crates/project/src/agent_registry_store.rs`, `crates/project/src/agent_server_store.rs`,
  `crates/agent_servers/src/{acp.rs,custom.rs,agent_servers.rs}`, `crates/node_runtime/src/node_runtime.rs`,
  `crates/paths/src/paths.rs`, `crates/agent_ui/src/conversation_view.rs`, `crates/acp_thread/src/connection.rs`
- https://github.com/agentclientprotocol/claude-agent-acp — README, `package.json`, `src/index.ts`,
  `src/acp-agent.ts`, `src/auth-status.ts`, `src/hide-claude-auth.ts`
- https://github.com/agentclientprotocol/codex-acp — README, `package.json`, `src/CodexAuthMethod.ts`,
  `src/CodexAcpClient.ts`, `src/CodexAcpServer.ts`, `src/CodexCli.ts`, `src/login.ts`
- https://github.com/zed-industries/codex-acp (archived), https://github.com/zed-industries/claude-code-acp (redirects)
- github.com/google-gemini/gemini-cli: `packages/cli/src/acp/acpRpcDispatcher.ts`,
  `packages/core/src/core/contentGenerator.ts`, `docs/cli/acp-mode.md`
- npm registry metadata for the packages named below

## 1. Zed's mechanism in one paragraph

Zed no longer hard-codes agents. It fetches the public **ACP Registry** JSON, shows it in a picker
(`zed: acp registry`), and installs whatever the user picks by one of two routes: an **npm package**
installed with Zed's own managed Node into Zed's data dir, or a **binary archive** downloaded and
extracted into the same dir. Both produce a `{path, args, env}` command that Zed spawns over stdio.
Sign-in is delegated to the agent: the agent advertises `authMethods` at `initialize`, and Zed either
calls ACP `authenticate` or, for `type: "terminal"` methods, opens a terminal running the agent's own
login command. Docs: "The ACP Registry is the primary way to install common External Agents in Zed."
and "Extension-provided agents are deprecated. The ACP Registry is now the way to install agents."

## 2. Which agents (docs + registry)

Zed docs list as "Common External Agents": Claude, Codex, OpenCode, Copilot, Cursor, Pi Coding Agent
("This list is curated, not exhaustive"), plus Gemini CLI and Poolside sections. The registry itself
has 39 entries today (version `1.0.0`, `extensions: []`). The four that matter here, verbatim from
`registry.json`:

| id | name | version | distribution |
|---|---|---|---|
| `claude-acp` | Claude Agent | 0.75.1 | `npx.package = "@agentclientprotocol/claude-agent-acp@0.75.1"` (no args) |
| `codex-acp` | Codex | 1.10.0 | `npx.package = "@agentclientprotocol/codex-acp@1.10.0"` (no args) |
| `gemini` | Gemini CLI | 0.58.0 | `npx.package = "@google/gemini-cli@0.58.0"`, `args: ["--acp"]` |
| `github-copilot-cli` | GitHub Copilot | 1.0.83 | `npx.package = "@github/copilot@1.0.83"`, `args: ["--acp"]` |

Binary examples: `opencode` (GitHub release zip/tar.gz per platform, `cmd: "./opencode"`,
`args: ["acp"]`, with `sha256`), `cursor` (`downloads.cursor.com/.../agent-cli-package.tar.gz`,
`cmd: "./dist-package/cursor-agent"`, `args: ["acp"]`, no sha256). `fast-agent` and `minion-code`
use `uvx`. Registry distribution keys are exactly `binary`, `npx`, `uvx` (schema `additionalProperties: false`).

Package-name history: `@zed-industries/claude-code-acp` (npm last publish 0.16.2, 2026-03-26) and
`@zed-industries/codex-acp` (0.16.0, 2026-06-23) are the old names; both carry deprecation notices on npm.
github.com/zed-industries/claude-code-acp now redirects to `agentclientprotocol/claude-agent-acp`;
zed-industries/codex-acp is archived: "Development has moved to `agentclientprotocol/codex-acp`."

## 3. The registry contract (agent.schema.json)

Required: `id`, `name`, `version`, `description`, `distribution`. `distribution.npx` / `.uvx` are
`packageDistribution`: `{package (name, optional @version), args[], env{}}`. `distribution.binary` is a map
keyed by `darwin-aarch64|darwin-x86_64|linux-aarch64|linux-x86_64|windows-aarch64|windows-x86_64`, each
`{archive (URL), sha256?, cmd, args[], env{}}`. Schema text: "URL to download archive (.zip, .tar.gz,
.tgz, .tar.bz2, .tbz2, or raw binary). Installer formats (.dmg, .pkg, .deb, .rpm) are not supported."
`cmd` is "Command to execute after extraction". The registry page: "all agent metadata including
distribution information for automatic installation." Submission is a PR adding `<id>/agent.json` (+ `icon.svg`).

## 4. How Zed fetches, installs, spawns, updates (source, cited)

**Fetch.** `crates/project/src/agent_registry_store.rs`:
`const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"`,
`REFRESH_THROTTLE_DURATION = 60 * 60 s`, `REGISTRY_FETCH_TIMEOUT = 30 s`. Cached at
`paths::external_agents_dir()/registry/registry.json`; icons cached alongside. `refresh_if_stale()` is
called on every agent connect (`custom.rs`). If an entry has both `binary` and `npx`, binary wins when it
supports the current platform, else npx.

**Where.** `crates/paths/src/paths.rs`: `external_agents_dir() = data_dir()/external_agents`
("This is where agent servers are downloaded to"); `data_dir()` is `~/Library/Application Support/Zed`
on macOS. npm agents go to `external_agents/registry/npx/<registry-id>/`; binary agents to a versioned
cache dir keyed by version + hash of archive URL (+ sha256).

**Node.** Zed does not ship Node in the app bundle; `crates/node_runtime/src/node_runtime.rs` first
tries `which node`/`npm` on PATH (`SystemNodeRuntime`, `MIN_VERSION = 22.0.0`), and otherwise
downloads `ManagedNodeRuntime::VERSION = "v24.11.0"` from
`https://nodejs.org/dist/{version}/node-{version}-{darwin|linux|win}-{x64|arm64}.{tar.gz|zip}` into
`data_dir()/node/node-<ver>-<os>-<arch>/` (binary at `bin/node`, npm at `bin/npm`). It validates the
managed copy by running `npm --version` with `--cache`, `--userconfig blank_user_npmrc`,
`--globalconfig blank_global_npmrc` under that dir, and re-downloads on failure.

**npm install + spawn.** `LocalRegistryNpxAgent::get_command` in `crates/project/src/agent_server_store.rs`,
run on every connect (there is no "already installed" short-circuit):

```rust
let install_dir = paths::external_agents_dir().join("registry").join("npx").join(sanitize_path_component(&registry_id));
let (package_name, package_spec) = bounded_npm_package_spec(&package);
node_runtime.run_npm_subcommand(Some(&install_dir), "install", &[package_spec.as_str(), "--save-exact"]).await?;
let executable = node_runtime::read_package_executable(install_dir.join("node_modules"), package_name).await?;
let node_binary = node_runtime.binary_path().await?;
env.extend(node_runtime::npm_command_env(&node_binary));   // PATH with node dir prepended (+ NODE_EXTRA_CA_CERTS)
env.extend(distribution_env); env.extend(extra_env); env.extend(settings_env);
let mut command_args = vec![executable.to_string_lossy().into_owned()];
command_args.extend(args); command_args.extend(extra_args);
AgentServerCommand { path: node_binary, args: command_args, env: Some(env) }
```

`read_package_executable` reads `node_modules/<pkg>/package.json` `bin` and resolves it to a path. So
the spawn line is literally `<node> <install_dir>/node_modules/<pkg>/<bin> [registry args]`, e.g.
`node .../npx/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js` and
`node .../npx/gemini/node_modules/@google/gemini-cli/bundle/gemini.js --acp`.

**Version pinning / updates.** `bounded_npm_package_spec` turns `pkg@1.2.3` into `pkg@0.0.0 - 1.2.3`
(a `<=` ceiling, not an exact pin). Source comment: "We set the version to now be a ceiling and not an
exact pin instead. This allows npm to resolve the latest version it can find that satisfies the
constraint." — done because users set npm `min-release-age`. Updates happen because the registry is
re-fetched (hourly throttle) and `npm install` re-runs on each connect; when the registry version string
for an agent changes while a connection is live, the store sends a "new version available" signal to
the connection (`agent_server_store.rs`, "compare the version. If it changed, notify the active
connection to reconnect"). The old extension-based `npm_package_latest_version` polling is not used here.

**Binary agents.** `LocalRegistryArchiveAgent::get_command`: download via
`http_client::github_download::download_server_binary` / `download_server_raw_binary` with the sha256
from the registry, or — if the URL is a GitHub release asset and no sha256 is given — the digest from
the GitHub release API; extract; `cmd` must start with `./` (else `bail!`), except `cmd == "node"` which
maps to Zed's Node. Stale versioned dirs are removed after a successful install.

**Spawn.** `AcpConnection::stdio` in `crates/agent_servers/src/acp.rs`: `ShellBuilder::new(&Shell::System,
cfg!(windows)).non_interactive().build_std_command(Some(path), &args)`, `child.envs(env)`, cwd = first
project root, stdin/stdout/stderr piped; stderr is logged.

**Env vars Zed adds** (`crates/agent_servers/src/custom.rs`, `connect`; ids `CLAUDE_AGENT_ID = "claude-acp"`,
`CODEX_ID = "codex-acp"`, `GEMINI_ID = "gemini"`, `CURSOR_ID = "cursor"`):
- proxy env from Zed settings (`load_proxy_env`); `NO_BROWSER=1` when the project is remote without a browser (`store.no_browser()`).
- Claude: `ANTHROPIC_API_KEY=""` (set to empty; the code gives no reason).
- Codex: forwards `CODEX_API_KEY` and `OPEN_AI_API_KEY` from Zed's own env if present (note the spelling `OPEN_AI_API_KEY` in the source).
- Gemini: `SURFACE=zed`; plus `GEMINI_API_KEY` = `$GEMINI_API_KEY` or `$GOOGLE_AI_API_KEY`, else the Google AI key from Zed's keychain. Docs: "Otherwise, if you have configured an API key for Zed's Google AI provider, Zed passes that key to Gemini CLI as `GEMINI_API_KEY`."
- Custom agents: user-supplied `agent_servers.<id>.{command,args,env}` in settings.json, `"type": "custom"`.

**Client capabilities Zed sends** (`client_capabilities_for_agent`): `fs.read/write`, `terminal: true`,
`auth.terminal: true`, `elicitation.form + url`, and `_meta: {"terminal_output": true, "terminal-auth": true}`.

## 5. Sign-in: how Zed drives it (client side)

`crates/agent_ui/src/conversation_view.rs`. Any ACP error with `code == AuthRequired` (returned by
`session/new` or `session/prompt`) puts the thread in `AuthState::Unauthenticated` and renders
`render_auth_required_state`: title "Authenticate to {agent}", one button per `connection.auth_methods()`.
Clicking a method: if `terminal_auth_task(method)` yields a command, Zed spawns it in the terminal panel
(`spawn_external_agent_login`) and waits — for `"claude-login"` and Gemini's `spawn-gemini-cli` it
watches stdout for `"Login successful"` / `"Type your message"`, otherwise it waits for exit code 0 —
then resets and reconnects. Otherwise it sends ACP `authenticate {methodId}`.
`terminal_auth_task` (`acp.rs`) accepts either a first-class `AuthMethod::Terminal` (gated by
`AcpBetaFeatureFlag`) or, "prior to stabilization", a `_meta["terminal-auth"] = {label, command, args, env}`
on any method. `supports_logout` = agent advertised `agentCapabilities.auth.logout`.

Gemini special case (`acp.rs`, "TODO: Remove this override once Google team releases their official
auth methods"): Zed discards Gemini's own `authMethods` and substitutes one method
`spawn-gemini-cli` "Login" / "Login with your Google or Vertex AI account" whose terminal-auth meta
runs the same command with `--acp`/`--experimental-acp` stripped — i.e. the interactive `gemini` TUI.

## 6. Claude Agent (`@agentclientprotocol/claude-agent-acp`)

**Bundling.** `package.json` 0.75.1: `bin: {"claude-agent-acp": "dist/index.js"}`, deps
`@agentclientprotocol/sdk 1.4.0`, `@anthropic-ai/claude-agent-sdk 0.3.257`, `zod`. It does NOT require a
separately installed Claude Code. The SDK ships the native CLI as platform optional deps
(`@anthropic-ai/claude-agent-sdk-{darwin,linux,win32}-{x64,arm64}[-musl]` 0.3.257). `claudeCliPath()`:
"The SDK's CLI is a native binary shipped as a platform-specific optional dependency of
@anthropic-ai/claude-agent-sdk", resolved via `require.resolve("@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude")`;
`CLAUDE_CODE_EXECUTABLE` overrides. The SDK query is created with `pathToClaudeCodeExecutable`.
`index.ts --cli` mode: `spawn(await claudeCliPath(), args-without---cli, {stdio: "inherit"})` — the adapter
doubles as a launcher for the bundled `claude`. README says nothing about install or auth.

**authMethods** (`acp-agent.ts` `initialize`). Offered only when the client says `auth.terminal: true`
or `_meta["terminal-auth"]: true`:
- local: `claude-ai-login` "Claude Subscription" `type: "terminal"`, `args: ["--cli","auth","login","--claudeai"]`;
  `console-login` "Anthropic Console" ("Use Anthropic Console (API usage billing)"), `args: ["--cli","auth","login","--console"]`.
  With `_meta["terminal-auth"]`: `{command: process.execPath, args: [...process.argv.slice(1), "--cli","auth","login","--claudeai"], label: "Claude Login"}`.
- remote (`NO_BROWSER`/`SSH_*`/`CLAUDE_CODE_REMOTE`): single `claude-login` "Log in with Claude",
  "Run `claude /login` in the terminal", `args: ["--cli"]` (opens the TUI). Comment: "the `auth login`
  subcommand would fall back to a device-code-like manual flow, which doesn't work well over ACP".
- `gateway` / `gateway-bedrock` only if client `auth._meta.gateway === true`; these are the only ids
  `authenticate()` implements — anything else: `throw new Error("Method not implemented.")`.
- `--hide-claude-auth` flag removes the subscription method and refuses subscription-billed turns.
So the vendor browser OAuth is run by `claude auth login` in a terminal the client opens; ACP
`authenticate` is not used for Claude sign-in. Capabilities: `auth: {logout: {}}` (`logout` runs
`claude auth logout`), `providers: {}`, `_meta.authStatus: {}`.

**Unauthenticated state.** A turn that fails auth yields a synthetic assistant message containing
"Please run /login"; the adapter suppresses it and rejects the turn with `RequestError.authRequired()`
("The `/login` instruction is Claude Code TUI-specific and meaningless to ACP clients"). It also pushes
`_auth/status_update` `{authStatus: {kind: "account"|"api_key"|"gateway"|"external"|"none", label, detail?,
account?}}` — a `_meta` extension, "Push only", sent at initialize (from `claude auth status --json`,
5 s timeout), after authenticate/logout, and at the start of each prompt; `kind: "none"` = "Not logged in".
`/login` and `/logout` are in `UNSUPPORTED_COMMANDS` and are filtered out of `available_commands_update`.
Unknown: Zed docs say "open a Claude Agent thread, run `/login`, and authenticate with an API key or with
Claude Code where supported", but the adapter hides `/login`; I found no `/login` handling in
`crates/agent_ui`. Whether typing `/login` still works via the CLI, or the docs are stale, is not verified.

## 7. Gemini CLI (`@google/gemini-cli`)

Installed as an npm package (`bin: {gemini: "bundle/gemini.js"}`), spawned with `--acp`
(`docs/cli/acp-mode.md`: "To start Gemini CLI in ACP mode, use the `--acp` flag"). Its `initialize`
advertises `authMethods` with ids from `AuthType`: `oauth-personal` "Log in with Google",
`gemini-api-key` "Gemini API key" (`_meta["api-key"].provider = "google"`), `vertex-ai` "Vertex AI",
`gateway` "AI API Gateway". `authenticate(methodId)` calls `config.refreshAuth(method, apiKey, baseUrl,
headers)` and persists `security.auth.selectedType`; an api key may arrive as `_meta["api-key"]` string.
What `refreshAuth` does for `oauth-personal` when no cached credential exists (browser launch vs. failure)
was not read. Zed ignores these methods (section 5) and runs the TUI `gemini` for login; docs: "may
prompt you to log in with Google, Vertex AI, or another Gemini-supported flow."

## 8. Codex (`@agentclientprotocol/codex-acp`)

**Distribution.** TypeScript adapter, npm: `bin: {"codex-acp": "dist/index.js"}`, deps `@openai/codex ^0.153.3`
(the Codex CLI itself, as an npm dep), `@agentclientprotocol/sdk ^1.4.0`, `open`, `vscode-jsonrpc`, `zod`.
README: "The npm package includes a compatible `@openai/codex` dependency. Set `CODEX_PATH` only when you
want the adapter to run a different Codex binary". `CodexCli.ts`: without `CODEX_PATH` it runs
`spawn(process.execPath, [require.resolve("@openai/codex/bin/codex.js"), ...args])`, i.e. the Codex App
Server ("`codex-acp` is a stdio ACP agent server. It starts the Codex App Server"). Latest GitHub release
`v1.10.0` has no binary assets; `npm run bundle:all` can build standalone binaries. The archived Rust
`zed-industries/codex-acp` shipped GitHub-release binaries and `npx @zed-industries/codex-acp`.

**authMethods** (`CodexAuthMethod.ts`, `getCodexAuthMethods`): `api-key` "API Key" (always;
`_meta["api-key"].provider = "openai"`), `chat-gpt` "ChatGPT" (unless `NO_BROWSER`), `chat-gpt-device-code`
"ChatGPT (device code)" — "Sign in to ChatGPT by opening a verification page and entering a one-time code"
(only if client supports URL elicitation), `gateway` (only if client `auth._meta.gateway === true`).
README: "The adapter advertises ACP auth methods during initialization."

**authenticate** (`CodexAcpClient.ts`): `api-key` → key from `_meta["api-key"].apiKey` else env
`CODEX_API_KEY` then `OPENAI_API_KEY`, then Codex `account/login {type:"apiKey"}`; `chat-gpt` →
`account/login {type:"chatgpt"}` then `await open(loginResponse.authUrl)` (opens the system browser from
the agent process) and waits for `account/login/completed`; `chat-gpt-device-code` → `account/login
{type:"chatgptDeviceCode"}`, then ACP `elicitation/create` with `url: verificationUrl`,
`message: "Sign in to ChatGPT and enter this code: ${userCode}"`, racing completion vs. user cancel.
`session/new` runs `checkAuthorization`: if Codex reports auth required and no `DEFAULT_AUTH_REQUEST`
env JSON is set, it throws `RequestError.authRequired()`. Capabilities include `auth: {logout: {}}`;
slash command `/logout` exists. Zed docs: "Codex may support ChatGPT login, Codex API keys, OpenAI API
keys, or Codex-native configuration depending on the installed version and environment."

## 9. Summary table

| Agent | Package / binary | Spawn line (Zed) | Sign-in |
|---|---|---|---|
| Claude | `@agentclientprotocol/claude-agent-acp@0.75.1` (bundles `claude` via SDK optional deps) | `node …/dist/index.js` | terminal methods `claude-ai-login` / `console-login` → `node …/dist/index.js --cli auth login --claudeai|--console` (browser OAuth by the CLI); unauth = `authRequired` error + `_auth/status_update` |
| Gemini | `@google/gemini-cli@0.58.0` | `node …/bundle/gemini.js --acp` | agent advertises `oauth-personal`/`gemini-api-key`/`vertex-ai`/`gateway` via `authenticate`; Zed instead opens the `gemini` TUI in a terminal; `GEMINI_API_KEY` passed through |
| Codex | `@agentclientprotocol/codex-acp@1.10.0` (bundles `@openai/codex`) | `node …/dist/index.js` | `authenticate` with `api-key` (env/`_meta`), `chat-gpt` (agent opens browser), `chat-gpt-device-code` (URL elicitation), `gateway` |
| OpenCode / Cursor / others | GitHub-release or vendor archive, `cmd` relative to extract dir | `./opencode acp`, `./dist-package/cursor-agent acp` | agent-owned; not researched |

## 10. Open unknowns

- Why Zed sets `ANTHROPIC_API_KEY=""` for Claude (no comment in source).
- How `/login` works in a Zed Claude thread given the adapter filters it (section 6).
- Gemini `refreshAuth` behaviour for `oauth-personal` over ACP without a cached credential.
- Whether Zed verifies npm package integrity beyond npm's own lockfile/`--save-exact` (no sha256 for npx entries in the schema).
