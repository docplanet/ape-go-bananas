# The app: decisions made while building it

The design is `APP.md` in the method repo (`~/Dev/Anki/APP.md`). This page is
the build log for that design: each decision below was forced by something
concrete, and the reason is written next to it so it can be revisited on
purpose rather than drifted away from.

## Where it lives

`app/` in this repo. The engine at the root keeps its zero-runtime-dependency
rule; `app/` has its own `package.json` (Tauri CLI, `@tauri-apps/api`, the
dialog plugin, Vite, TypeScript) and its own `src-tauri/` crate. One repo
because the app imports nothing from the engine at build time — it *spawns*
it — and the two must move together when the sidecar protocol changes.

## How the app reaches the engine: a Node sidecar, owned by Rust

The webview cannot run `node:sqlite` or spawn an agent CLI. So the engine
runs as a child process, `dist/sidecar/index.js` (`src/sidecar/`, also the
`ape-sidecar` bin), speaking newline-delimited JSON-RPC 2.0 over stdio —
`docs/research/sidecar-protocol.md`, the same framing as ACP, reusing
`src/acp/framing.ts` unchanged.

The Rust side (`app/src-tauri/src/sidecar.rs`) spawns and owns it, rather
than the webview spawning it through a shell plugin, for three reasons:

1. **Which Node.** The engine needs Node ≥ 24; the `node` on a developer's
   PATH is often 20 (it was here — the first smoke test died on
   `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`). Rust resolves `APE_NODE`, then
   PATH, runs `--version`, and refuses below 24 with a message that names the
   fix. A static capability file could not make that decision.
2. **Lifetime.** `kill_on_drop` plus an explicit kill on `RunEvent::Exit`: the
   engine dies with the window. No orphaned Node processes.
3. **The reverse direction.** `agent/requestPermission` (protocol §5) will be
   a request *from* the sidecar *to* the app. It needs a place to land that
   is not a fire-and-forget event. `sidecar.rs` already routes any id-bearing
   inbound method to a `sidecar://request` event; answering it is the next
   slice.

The frontend surface is `app/src/sidecar.ts`: one typed function per
protocol method, all going through the `sidecar_call` command. Screens call
that and nothing else.

## Frontend: vanilla TypeScript + Vite, no framework yet

The handoff flagged a UI framework as a decision to record, not a default to
drift into. The placeholder shell needed none — `main.ts` is under 200 lines
of DOM. The real screens are to come from **Claude Design**, which produces
HTML artboards; a framework choice (if any) is best made when those exist and
their interaction needs are known, not before. Until then nothing is
committed to that cannot be replaced by deleting `main.ts` and `style.css`.

## The card preview is the engine's review page, framed

`app/src/preview.ts` shows `renderReview`'s HTML — byte-for-byte what `ape
review` writes — in a sandboxed `srcdoc` iframe, with two additions layered
on by script: a **Flag** button per card, posting the card's index to the
app, and an outline on already-flagged cards. The app does not re-render a
card. If the review page changes in the engine, the preview changes with it.

Images: the engine writes `file://` paths into the review HTML. A Tauri
webview cannot load those from its own origin, so `preview.ts` rewrites them
through `convertFileSrc` and `tauri.conf.json` scopes the asset protocol to
`$HOME/**` — course folders and the Anki media directory both live there.
Narrow the scope when the app knows the course folder.

Flags persist as `flags.json` beside `deck.json` (`flags/read`,
`flags/write`) — the same "artifact beside the course folder" shape as
`inventory.md` and `plan.md`. The sidecar validates the shape and stores it;
nothing in app or engine code interprets a flag. That is the adjudicator's
job, over the agent bridge.

## Agents: the picker is the registry, sign-in is a button

Slice 2 copied Zed (`docs/research/agent-install-and-auth.md`): the app reads
the public ACP registry, installs any `npx` entry with npm under its data
directory using the same Node the sidecar runs on, and spawns it from there.
The Claude entry's npm package includes the Claude Code binary, so nothing
else is installed. Sign-in: the client advertises `auth.terminal`, the
adapter offers Subscription and Console methods, and `agent/login` runs the
method's launch line headless — it opens the browser itself and waits for
the OAuth callback (`docs/research/claude-adapter-auth.md`). Gemini and
Codex use ACP's own `authenticate`; Codex opens the browser from inside the
agent.

The API-key tier is OpenRouter, run by an agent loop inside the sidecar
(`src/agent`) that emits the same update stream as an ACP agent, so the chat
pane, selectors and permission prompt are one implementation. Keys go to
the OS credential store through Rust (`keyring`), reach the sidecar only
inside `agent/connect`, and are never written by it.

## What is placeholder, and what is real

| piece | state |
| --- | --- |
| sidecar protocol + `src/sidecar/` | real; oracle in `test/sidecar/` written from the spec by a separate context |
| Rust sidecar owner, `sidecar_call` / `sidecar_status` | real |
| deck preview, checks pane, flag loop, `.apkg` export | real, against the engine |
| layout, styling, copy | **placeholder** — the shape from APP.md drawn plainly; replaced by Claude Design output |
| stage rail | real: extract / organize / cards run the method file on the folder; the review gates show the artifact; audit adjudicates flags in a fresh session and the writer applies verdicts; deliver exports |
| provider picker, install, sign-in, chat, selectors, permission prompt | real, against the engine; clicks unverified from a session, calls verified at the sidecar |
| icon | a generated teal square (`app/app-icon.png`); regenerate with `npx tauri icon <png> -o src-tauri/icons` |

## Packaging: the download is the whole onboarding

`app/scripts/prepare-bundle.mjs` (run by `tauri build` through
`beforeBuildCommand`) stages four inputs (`docs/research/tauri-packaging.md`):

| what | where in the bundle | why there |
| --- | --- | --- |
| the official nodejs.org `node` for the target, checksum-verified against `SHASUMS256.txt` | `externalBin` → `Contents/MacOS/node` | executables must be signed; `tauri build` re-signs every externalBin with the app's identity and `Entitlements.plist` (JIT entitlements kept for V8) |
| npm from the same distribution | resource `npm/` | JS, no signing; `agents/install` runs it through `APE_NPM_CLI` |
| the engine's `dist/` | resource `engine/` | the sidecar and everything it imports |
| the method files | resource `method/` | prose, unmodified, read at run time |

`resolve_paths` prefers the bundled node and engine when present, then env
overrides, then the dev checkout. Nothing is downloaded at run time except
agents the user chooses to install. Not shipped: SEA or pkg (Node 24's SEA
is experimental and the binary is the same size either way).

**Ad-hoc signed, not notarized, on purpose.** `signingIdentity: "-"` seals
the bundle so a copy out of a zip stays internally consistent (an unsealed
copy failed to find its own Resources), but this is free software and no one
is paying Apple 99 dollars a year for a Developer ID. Gatekeeper checks signatures on every
downloaded app regardless of licence, so a Mac user's first launch is:
double-click, "cannot be opened", System Settings → Privacy & Security →
**Open Anyway**, once. The download page says so in two lines. Windows
shows a SmartScreen warning with "More info → Run anyway"; Linux has no
gate. If the app ever earns a sponsor, signing is four environment
variables at build time (`APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
`APPLE_PASSWORD`, `APPLE_TEAM_ID`) and `Entitlements.plist` is already
right for the re-signed node. Artifacts: a `.zip` of the app (`ditto -c -k --keepParent`) and a plain
`.dmg` (`hdiutil create -format UDZO`); Tauri's own DMG step drives Finder
through Apple events and cannot run headless. **Updates and releases.** `tauri-plugin-updater` checks
`https://github.com/docplanet/ape-go-bananas/releases/latest/download/latest.json`
on launch and offers a bar; the archive is verified against the minisign
public key in `tauri.conf.json`, which is unrelated to Apple signing. The
private key lives outside the repo (`~/.tauri/ape.key` on the build machine,
`TAURI_SIGNING_PRIVATE_KEY` as a repository secret). Lose it and no shipped
build can ever be updated again. `.github/workflows/release.yml` builds
Apple silicon, Intel Mac, Windows and Linux on a `v*` tag, runs the engine
suite against a checkout of the method repo, stages the target's Node with
`prepare-bundle`, and publishes the release with `latest.json`. v0.1.0 was
built and signed by hand on this machine before that workflow existed.

## Running it

```sh
# engine, once (and after every engine change)
cd ~/Dev/APE && npm run build
# app
cd ~/Dev/APE/app && npm install && npm run app:dev
```

`app:dev` sets `APE_NODE` to whatever `node` npm itself is running under —
with `nvm use` in the engine repo that is 24 — then starts Vite and the
Tauri window. `APE_SIDECAR` overrides the engine script path (debug builds
default to `../../dist/sidecar/index.js` relative to `src-tauri/`).

## Open, deliberately

- **CSP.** `tauri.conf.json` sets an explicit policy; `script-src 'self'`
  means the review page's own inline script runs only because the iframe is
  sandboxed `srcdoc`. Re-check when the designed screens arrive.
- **Asset scope** `$HOME/**`, see above.
- **`window.prompt` for the flag text** — a stand-in for a designed flag
  sheet.
