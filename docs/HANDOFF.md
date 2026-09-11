# Handoff: back to the desktop app

Written 2026-09-10, at the end of a long session. It records what was built,
what was learned, why the browser direction was abandoned, and what the next
session should do. Nothing here is deleted work — read "What to keep" before
touching anything.

## Pick-up note, written 2026-09-11 (read this first)

**Where things are.** The desktop app in `app/` is the product; everything
in §7 below through step 5 is done and committed on `main` (last commit
`f4f5767`, nothing pushed). The shell was rebuilt twice tonight after the
owner tried it:

1. **Main screen is card generation; the agent is a setting.** Rail: deck
   name, the eight steps, Settings. Main pane: a Next bar that says what is
   next and runs it, the artifact gate, the agent's output, the deck view at
   step 6. Settings holds the agent (installed first, registry folded away;
   "Use" remembers it) and the app's facts. The chosen agent connects on its
   own whenever a deck opens. Files: `app/src/agent/{app,stages,settings,
   picker,home,materials}.ts`, styles in `agent/shell.css`.
2. **Decks are workspaces the app owns.** No folder picking. Home lists
   decks (`decks/list`) with their state; New deck by name, or drop files /
   a folder anywhere on the window and a deck is made from them. The deck
   screen shows a tile per file (kind, size, pages read after extract) with
   remove and Add files. Engine methods added: `decks/list`, `decks/create`,
   `course/import` (paths, desktop), `course/delete`; `course/read` gained
   `encoding: "base64"`. All in `src/sidecar/course.ts`, 14 course tests,
   documented in `docs/research/course-protocol.md`.

**Verified** (in a browser over `ape-bridge`, which runs the identical
shell): home, new deck by name and by drop, tiles, remove, Settings, Use
Claude Agent connecting and returning to the steps, reload resuming the
deck with the agent reconnected, deck preview through the bar, the bar
moving to the audit. Suites: 347 engine, 8 app, 1 site, all green.

**Not yet verified, and the first thing to do tomorrow**, in the desktop
app itself:
- a **drop of a PDF or a folder onto the window** (desktop drops arrive as
  paths and go through `course/import`; the browser check used bytes);
- **New deck** working after the last fix -- the dev build had been running
  a weeks-old staged engine (`src-tauri/resources/engine`), which is why
  the owner saw `method not found: decks/create`; debug builds now prefer
  the repo's `dist/` (`app/src-tauri/src/sidecar.rs`, `resolve_paths`);
- **a real extract stage** with Claude connected (never run in the app;
  the same code ran the whole method live from the page on the 10th).

**How to run it:**
`cd app && PATH=~/.nvm/versions/node/v24.12.0/bin:$PATH npm run app:dev`.
The engine must be built first (`npm run build` at the root; the app
imports `dist/pipeline` and spawns `dist/sidecar`). Decks live under
`~/Library/Application Support/dev.docplanet.ape/decks/`.

**Known rough edges, deliberately left:** flagging a card uses
`window.prompt`; no "start over" for a deck (re-running step 1 overwrites
`inventory.md`); the deck name lives in localStorage keyed by folder
(`ape.name:<path>`), the folder name is derived from it once; the site's
bridge tier still works but is only a developer route.

**Still open from §7.6:** Apple signing ($99/yr, removes the "unidentified
developer" wall), and whether `ape-bridge` stays.

---

## 1. Where this started

A.P.E. shipped as a Tauri desktop app. The prompting question was: Squoosh,
CyberChef and Whisper Web do real local computation on a hosted page with
nothing installed — could A.P.E. do the same, and skip the download, the
Gatekeeper warning, the four-platform release matrix and the signing key?

The plan (`~/.claude/plans/hey-claude-had-a-sorted-spring.md`) split it into
three tiers on one page:

| Tier | Install | Status now |
| --- | --- | --- |
| Engine — checks, review, `.apkg` | nothing | **works, keep** |
| Full pipeline over a real folder | a local bridge | works, keep as fallback |
| ACP agents (Claude / Gemini / Codex) | same bridge | works, keep as fallback |

A fourth tier was then attempted — running the ACP agent *inside the browser
tab* via WebContainer. That is the part being abandoned.

---

## 2. What was actually built (all committed, all on `main`)

**Stage 1 — the engine stopped knowing which platform it is on** (`b4a78de`).
SQLite, deflate, media reads and the media-existence check became injected
dependencies; `buildApkg` and `parseDeckNotes` were split out; `sha1` and
`crc32` were written in pure TypeScript and pinned against `node:crypto` /
`node:zlib`. The CLI and sidecar were unaffected. **This is the most valuable
work of the whole detour and is platform-independent.**

**Stage 2 — the zero-install tool page** (`e5e36df`). `site/` gained a Vite
build: sql.js + fflate adapters, the engine in a Web Worker, checks, the card
review and real `.apkg` export with nothing installed, plus a parity test
proving the browser writer is byte-identical to the Node one.

**Stage 3 — the bridge** (`a85b01f`, `6d7628a`). The sidecar gained a second
transport (SSE + POST over loopback, `src/sidecar/serve.ts`), an `ape-bridge`
binary, and `src/pipeline/` was lifted out of `app/src/pipeline.ts` so a
second shell could use it. The page became the full app over that bridge and
ran a real lecture end to end.

**Stage 4 — the engine in the tab** (`2dad160`, `1691073`, …). WebContainer
(Node compiled to WebAssembly) ran the *actual* sidecar in the browser: 62
files of `dist/` mounted into a virtual filesystem, a wrapper process doing
base64 line-framing because WebContainer hands a spawned process a
pseudo-terminal that mangles JSON-RPC, and a service worker faking the
COOP/COEP headers GitHub Pages will not send. It worked: cold page to a ready
engine in 2.9 s, 41 agents listed, a 4.4 MB lecture uploaded, Claude Code
installed in-tab, and `claude setup-token` printing a real OAuth URL.

Along the way, two genuinely good fixes that have nothing to do with browsers:

- **PDFs are read without external tooling** (`819b765`). The first live run
  watched the agent ask to run `python3` to look for `pdftotext`. Now pdf.js
  extracts the text of every page (under `## Page N` headings) plus one JPEG
  per page, written beside the material under `_extracted/`, and the stage
  prompt says so. A 41-page lecture takes ~5 s.
- **The page stops asking permission for the agent to read** (`80f8e2c`).
  Reads, searches, thinking and fetches are allowed automatically; edits are
  allowed when every path is inside the course folder; commands, deletes and
  moves still ask. `bypassPermissions` is still refused.

---

## 3. Why the browser direction is being abandoned

Not because it failed — it demonstrably worked — but because the foundation
is unsound:

1. **It rests on a discontinued artifact.** From v2.1.113 (17 April 2026) the
   Claude Code npm package ships a per-platform *native binary*, which cannot
   execute on a WebAssembly Node. The in-tab tier therefore pins **2.1.112**,
   the last JavaScript build, frozen forever. Anthropic's own guidance is "if
   you need the JS build, pin to an earlier version", so the pin is
   sanctioned — but it has an invisible termination date. When the auth flow
   or a minimum-version check changes, the front door breaks for everyone at
   once.
2. **There is no persistence.** Every page load is a fresh sandbox — the
   workdir hash changed on every run. A reload loses the uploaded lecture,
   the 18 MB Claude install, the sign-in and every artifact. The pipeline is
   eight stages over many minutes. This alone is close to disqualifying.
3. **It is workarounds stacked on workarounds**, each existing to paper over
   the one below it. And WebContainer is free for open source but needs a
   commercial licence for for-profit production — a dependency with unknown
   cost if this becomes a product.

The owner's call, which is correct: **build the desktop app properly
instead.** A desktop process can spawn the user's real, current, native
Claude Code. Every problem above disappears — no pin, no ageing, no sandbox,
no licence, no header shims.

---

## 4. What to keep (read this before deleting anything)

**Keep entirely — platform-independent, 344 passing tests:**

- `src/` — the whole engine. Checks, `.apkg` writer, ACP client, agent
  registry, the sidecar and its method table.
- `src/pipeline/` — **the canonical pipeline.** Stage definitions, the
  auditor/adjudicator briefs, `stageBlocks`, `describeExtracted`. See §5.
- `src/sidecar/` — including the methods added this week: `course/write`
  (confined to the folder like `course/read`, 11 tests) and
  `course/list`'s `extracted` field.
- `src/bridge/` — `ape-bridge`. Still works; keep as a developer tool and a
  fallback even if it is not the front door.

**Keep and port into the desktop app — these are the week's real wins:**

- `site/src/engine/pdf-extract.ts` — pdf.js text + page images. The Tauri
  app has a webview, so this works there unchanged and removes the
  `pdftotext` / `pypdf` dependency entirely. **High value, port first.**
- `site/src/agent/permission-policy.ts` — pure, 6 tests, no DOM. Drops
  straight in.
- `site/src/agent/*` — `picker.ts`, `chat.ts`, `stages.ts`, `signin.ts`,
  `bus.ts`, `permission-any.ts`, `app.ts`. **This is a more developed UI
  than `app/src/` has** (1,294 lines vs 1,190, and it covers the eight
  stages, the review gates, flags, the audit → adjudicate → apply route and
  the agent picker). It should become the desktop app's UI.
- `site/src/engine/host.ts` — the `EngineHost` interface. This is the seam
  that makes the above portable: one interface, currently two
  implementations (`bridge-transport.ts` over HTTP, `container/host.ts` over
  WebContainer). Adding a third over Tauri's `invoke` is the main task.

**Keep deployed as-is:**

- The zero-install tool page (`site/tool/`) minus the container tier. Drop a
  `deck.json` in, get checks, the card preview and a real `.apkg` with
  nothing installed. It is genuinely useful and costs nothing to keep.

**Demote or delete:**

- `site/src/container/*` (WebContainer host, wrapper, framing, pinned
  version) and `site/public/coi.js`. Either delete, or keep behind an
  explicitly labelled experiment that nothing links to. **Do not leave it as
  the front door** — `site/src/tool.ts` currently makes "Start a deck" boot
  the container.
- `site/tool/index.html`'s hero should stop advertising the in-tab tier.

---

## 5. The bug to fix first

`app/src/pipeline.ts` is a **fork**. When the pipeline was lifted into
`src/pipeline/` for the browser, the desktop app kept its own 154-line copy,
and it has none of this week's work:

- no `companions` → the desktop app still sends the agent hunting through
  `skills/` and `.claude/` for `SETUP.md`, which the bridge now fetches and
  attaches.
- no `describeExtracted` → it still lets the agent probe for `pdftotext`,
  and dies on a machine without it.

Nothing imports `app/src/pipeline.ts` except the app itself. Delete it and
import `src/pipeline/` instead. This is the single highest-value change in
the repo right now.

The root cause is structural: **`app/` is in no CI job.** `ci.yml` and
`pages.yml` do not mention it; only `release.yml` does, and that runs on
`v*` tags. `npm test` and `npm run typecheck` do not cover it. That is why
it rotted silently — fix the CI gap at the same time.

---

## 6. State of the desktop app, as of this handoff

| | |
| --- | --- |
| Last touched | `5a00f04`, 2026-09-07 — 21 commits before HEAD |
| Typechecks against the current engine | **yes, clean** (`cd app && npx tsc --noEmit`) |
| Released | **v0.1.0**, 16 assets: `.dmg` (arm64 + x64), `.exe`, `.deb`, `.AppImage`, all with `.sig`, plus `latest.json` for the updater |
| Downloads | ~1 each — effectively none |
| In CI | **no** |
| Toolchain here | cargo 1.92.0, rustc 1.92.0, tauri-cli 2.11.4 — a local build should work |
| Rust side | `app/src-tauri/src/{lib,main,sidecar}.rs`, 401 lines; owns the Node child process and speaks the sidecar protocol |
| Signing | updater only (`TAURI_SIGNING_PRIVATE_KEY`, minisign). **Apple signing is not configured** — macOS users still get "unidentified developer" |

`app/src/sidecar.ts` (203 lines) already has exactly the `EngineHost` shape:
a single `call()` over `invoke('sidecar_call', {method, params})`, plus
`onNotification` / `onRequest` over Tauri events and `answer` / `refuse` over
`invoke('sidecar_answer')`. Writing `TauriHost implements EngineHost` should
be roughly 60 lines of adapter over what is already there.

Per `docs/APP.md`, the desktop layout is **a placeholder by declaration** —
which is exactly why importing the browser UI is attractive rather than
wasteful.

---

## 7. Suggested plan for the next session

1. **Stop the rot.** Add `app/` to `ci.yml`: `npm --prefix app run build`
   (which is `tsc --noEmit && vite build`). Cheap, and it would have caught
   the fork.
2. **Kill the fork.** Delete `app/src/pipeline.ts`; import `src/pipeline/`.
   Confirm the extract prompt now carries `SETUP.md` and the extracted-PDF
   paragraph.
3. **Port PDF extraction.** Move `site/src/engine/pdf-extract.ts` somewhere
   both shells can use it, and run it before the extract stage in the app the
   way `site/src/agent/extract.ts` does. Needs a write path — the sidecar
   already has `course/write`.
4. **Decide the UI question.** Either (a) make `app/` use `site/src/agent/*`
   behind a `TauriHost implements EngineHost`, which gets the eight stages,
   gates, flags and the audit route for roughly the cost of one adapter; or
   (b) keep `app/src/main.ts` and port pieces across. (a) is recommended and
   is what the `EngineHost` work was for.
5. **Demote the container tier** in `site/`, and make the tool page a plain
   deck checker again with a download link.
6. **Then the product questions**, in this order: Apple signing ($99/yr,
   removes the "unidentified developer" wall and was the original reason for
   the whole browser detour), and whether `ape-bridge` stays.

---

## 8. Facts worth carrying over

- **Node**: this machine defaults to v20.18.1; the engine's tests and build
  need **v24.12.0** (`~/.nvm/versions/node/v24.12.0/bin`). `npm test` guards
  this — on Node 20 the test runner silently discovers zero `.ts` tests and
  exits 0, a false green.
- **Tests**: 344 engine + 16 site, all passing at `cb0ebec`. `npm test` at
  the root, `npm --prefix site test` for the site.
- **Claude Code versions**: 2.1.112 (2026-04-16) is the last JavaScript
  build; 2.1.113 onward is native. Irrelevant once the desktop app spawns
  the user's own CLI — which is the point.
- **Model overrides** (found but never shipped): the CLI reads
  `ANTHROPIC_DEFAULT_SONNET_MODEL` / `_OPUS_MODEL` with an unconditional
  early return and **no allowlist**, and the ACP adapter reads
  `ANTHROPIC_CUSTOM_MODEL_OPTION` (exempt from the allowlist, but only
  applied if the bundled SDK already knows the model). Useful if a model
  list ever needs forcing.
- **`@anthropic-ai/claude-agent-sdk` is not an alternative to the CLI** — it
  spawns it. Its `/browser` export is a client for a session running on
  Anthropic's infrastructure, not a local runtime. Its
  `spawnClaudeCodeProcess` hook ("custom spawn logic for VM execution") may
  be useful later.
- **Method files** live in their own repo
  (`docplanet/anki-process-engine-live`), fetched at run time. `SETUP.md`
  sits at the repository root, not in `method/` — the bridge fetches both.
- The live tool page is
  <https://docplanet.github.io/ape-go-bananas/tool/>; `pages.yml` deploys it
  on every push to `main`.

---

## 9. One process note

Most of this session's second half was spent fixing surface problems — rail
affordances, escape-sequence rendering, a stale model dropdown — on a
foundation that had a termination date. Each fix was correct and none of
them mattered. The owner had to be the one to step back and say so. Worth
remembering: when the third consecutive fix is cosmetic, check whether the
thing underneath is sound before polishing it further.
