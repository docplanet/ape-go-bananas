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

## The audit is the method's, not the app's

The first real run put a card in front of the owner that split its subject
across the blank (`{{c1::<b>Peripheral</b>::which position?}} <b>nuclei</b>
…`) and asked "which type?" of nothing. The structural check passed it — by
design it judges shape, not meaning — and the app's audit stage at the time
adjudicated only what the owner had flagged, so no independent reader ever
saw the deck. The method's own run-sheet has that reader: `deck-auditor.md`,
a fixed brief that reads the whole deck against the sources and the seven
reference cards on four angles and files findings without editing. It now
ships as the fourth method file (`4-audit.md`) and the audit stage runs it
first, in a session that wrote none of the cards; its findings join the
owner's flags on the way to the adjudicator. The line holds: the app added a
stage the method already prescribed, not a rule of its own about cards.

## What is placeholder, and what is real

| piece | state |
| --- | --- |
| sidecar protocol + `src/sidecar/` | real; oracle in `test/sidecar/` written from the spec by a separate context |
| Rust sidecar owner, `sidecar_call` / `sidecar_status` | real |
| deck preview, checks pane, flag loop, `.apkg` export | real, against the engine |
| layout, styling, copy | **placeholder** — the shape from APP.md drawn plainly; replaced by Claude Design output |
| stage rail | real: extract / organize / cards run the method file on the folder; the review gates show the artifact; audit runs the method's deck-auditor brief over the whole deck in a fresh session, then a separate adjudicator rules on its findings plus the owner's flags and the writer applies fixes and cuts verbatim; deliver exports |
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
`prepare-bundle`, and publishes the release with `latest.json`. v0.1.0's Apple
silicon assets were first built by hand on this machine; the workflow's
first green run then added Intel Mac, Windows and Linux to the same release
and regenerated `latest.json`. Releasing from here on: bump `version` in
`tauri.conf.json`, tag `v<version>`, push the tag.

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

## Stage 3: the browser page drives a local agent through a bridge

A tab cannot spawn Claude Code — that is the browser sandbox, not a gap. So
the subscriber runs one command — `npx -p github:docplanet/ape-go-bananas
ape-bridge [course-folder]`, which builds itself on the first run because
npm runs `prepare` on a git install — and the page does the rest. The bridge is `src/sidecar` — the same method table the
Rust shell drove over stdio — listening on `127.0.0.1` (`src/sidecar/serve.ts`):
one Server-Sent Events stream carries everything outbound in the order the
sidecar said it, and requests arrive as newline-delimited JSON-RPC in POST
bodies. The Rust shell, the bundled Node, signing and the updater are not
needed for this path; the sidecar survived unchanged and gained a transport.

**Node floor.** `ape-bridge` starts on Node 20 (verified on 20.18.1, which has
no `node:sqlite` at all): `deck/export` defers its import to first use and the
page exports `.apkg` itself, so nothing the bridge does at start needs 24.

**The gate.** Loopback bind only, refused before listening otherwise. Every
request carries a per-run token the bridge minted and put in the page URL's
fragment — the one part of a URL never sent to the site hosting the page. Every
request's `Origin` must be on the allowlist (the site's origin, plus
`--allow-origin` for development); missing is refused like wrong. Preflights
echo the exact origin and answer Chrome's local-network header. `test/sidecar/
serve.test.ts` pins all of it, including a symlink that escapes the `/file`
root.

**What runs where.** The bridge spawns and owns the agent, reads and writes
the course folder, and serves image bytes beneath a named root (`GET /file`).
Checks, the card preview and the export run in the tab on the engine the tool
page already carries — the bridge only supplies `deck.json`'s text, the images
beside it, and `flags.json`. The preview mints one blob: URL per distinct image
inside its sandboxed iframe rather than inlining base64 per reference
(`site/src/tool.ts`, `withLocalImages`).

**Sessions and prompts.** The chat pane answers permission requests for its
own session only. The method's auditor and adjudicator run in fresh sessions
that no pane owns, so their requests — "write audit.md", "write verdicts.md"
— go to a fallback prompt (`site/src/agent/permission-any.ts`), registered at
low priority behind the bus (`bus.ts`). Without it the first live audit never
completed: its first request was refused and the session sat idle. Fresh
sessions also inherit the chat pane's model, effort and mode
(`Chat.applyConfigTo`); an audit the user started on Sonnet otherwise ran on
the agent's defaults.

**Run live, end to end, on 2026-09-10** from a browser tab against a bridge on
Node 20.18.1, Claude Agent installed through the page (0.76.0), signed in on
an existing claude.ai subscription, Sonnet 5: extract → inventory.md (20
facts, verbatim quotes) → organize → plan.md → cards → deck.json (20 notes) →
deck preview in the tab (two hint-length findings, same as `ape check` on
disk) → one owner flag → audit in a fresh session (16 findings, four angles)
→ adjudicate 16 flags in a fresh session (17 fix, 1 approve, 1 cut) → writer
applies (19 notes) → deck reloads clean → export. The final `deck.json`,
exported with `ape export`, imports into Anki 26.5: 19 notes, 38 cards.

**From the published site, same day.** The live page at
`docplanet.github.io/ape-go-bananas/tool/` reached a bridge on the same Mac
from Chrome 152 with no local-network prompt at all: `/health` 200, the
event stream 200, RPCs 202, the picker rendered. Brave refused the same
fetch silently — it blocks sites from reaching `127.0.0.1` unless the site
is added under `brave://settings/content/localhostAccess` — and the page's
error text now says so. (The desktop app's in-app browser pane refuses it
too, `ERR_BLOCKED_BY_CLIENT`, which is that pane's policy and no evidence
about any real browser.) Before any of that, the plain tool URL — no `#bridge=` fragment — came up
blank in both Brave and Chrome, and the page's own DOM said why: `#rail`
is `display: flex` in the stylesheet and starts with the `hidden`
attribute, and an author `display` beats the browser's `[hidden]`, so
outside the `.with-rail` grid it rendered as an empty white panel the
height of the viewport with the content below the fold. A `[hidden] {
display: none !important }` rule now means what the attribute says. The
first extract on a 4.4 MB lecture PDF then put
prompts in front of the user before the agent had read a page: "check
available PDF tooling" (`python3 -c`), then "look for the pipeline
SETUP.md" — a file `1-extract.md` names and the bridge had never fetched,
so the agent searched `skills/` and `.claude/` for it. Two changes: the
bridge fetches `SETUP.md` beside the step files and the extract prompt
attaches it (`src/pipeline`, `companions`); and the page answers reads,
searches and in-folder edits itself, asking only about commands, deletes and
anything outside the course folder (`site/src/agent/permission-policy.ts`,
six tests; both prompt panes consult it first, and an auto-answer is printed
in the chat so it is never silent). The tooling probe stays a prompt until
the page extracts PDF text and slide images itself — the next item below.

**PDFs are read in the tab.** Before the extract stage runs, the page
takes every PDF in the course folder that has no finished extraction and
makes one with pdf.js (`site/src/engine/pdf-extract.ts`, a lazy 430 KB
chunk plus its worker, fetched only then): the text of every page under
`## Page N` headings, and one JPEG per page at up to 1400 px, written beside
the material as `_extracted/<file>/text.md` and `pNNN.jpg` through a new
`course/write` (`src/sidecar/course.ts`, confined to the folder like
`course/read`). `course/list` reports the tree as `extracted`, never as
material, and the stage prompt describes it and links the text
(`src/pipeline`, `describeExtracted`): read these, do not look for
`pdftotext` or `pypdf`. Images go first and the text last, so `text.md` is
the mark of a finished extraction and a re-run skips it. Run live on the
41-page biochemistry lecture from a fresh Chrome: five seconds end to end,
41 JPEGs of 17–243 KB (6.6 MB; the first cut wrote 1.1 MB PNGs, 45 MB a
lecture), 17 KB of text, then the stage prompt went out with the extracted
paragraph and SETUP.md attached. Two honest limits: pdf.js puts stray
spaces inside words where a font's widths are odd ("c opied", on the same
slides where the rendered font is visibly loose), so the prompt tells the
agent the page image is the authority for exact wording; and a Web Worker
the browser kills gives no error, only promises that never settle — seen
once, on a tab that had already run one extraction and then sat at "page
11 of 41" for good — so every pdf.js call now has a deadline that turns
that into a message to reload the tab.

**The page leads with the first step.** The first version of the tool
page opened with the deck checker — the one thing a page can do alone —
and a student with lecture PDFs met a file picker with every file greyed
out and no word about a bridge. The page is now the two steps in order
(start the bridge, with the command and a copy button; open the link it
prints), the checker is a collapsed section at the bottom, and a lecture
file dropped on it is answered with where it goes. Attached to a bridge,
the steps disappear and the checker is the deck view.

## Stage 4: the engine runs in the tab, and the bridge becomes the exception

The bridge was the wrong front door. A first-time visitor with lecture PDFs
met a terminal command, and the answer to "why am I opening a terminal" is
not a good one: a page cannot start a process, so *something* local has to.
But WebContainer is a Node runtime compiled to WebAssembly, and it runs in
the tab -- which means the local something can be the page itself.

**The sidecar is not reimplemented; it is mounted.** `dist/` (62 files,
532 KB of plain JavaScript using only `node:` builtins) is mounted into the
container's filesystem and started as an ordinary child process, so
`deck/*`, `course/*`, `method/*`, `agents/*` and `agent/*` arrive intact and
`src/pipeline` and every pane are untouched. What differs between hosting it
on the user's machine and hosting it in the tab is only the pipe, and that
is now the whole of the difference: `site/src/engine/host.ts` is the
interface, `bridge-transport.ts` and `container/host.ts` are the two
implementations, and `makeSidecarClient` takes either.

**The pipe needs a wrapper.** WebContainer gives a spawned process a
pseudo-terminal, which echoes and is free to rewrite what crosses it -- the
first spike watched its own `initialize` come back as output. So a small
program inside the container (`container/wrapper.ts`) owns the real pipes to
the sidecar and relays each line base64-encoded (`container/framing.ts`,
8 tests). The first cut decoded frames with `atob` alone and rendered
"Step 1 â Extract" for "Step 1 — Extract"; base64 is over bytes, so the
round trip is `TextEncoder`/`TextDecoder` and is pinned by test.

**Cross-origin isolation without a server.** `SharedArrayBuffer` needs two
response headers, and GitHub Pages sends no custom headers. `site/public/
coi.js` is loaded in both contexts: on the page it registers itself as a
service worker and reloads once; as the worker it adds COOP/COEP to every
response. Verified against `vite preview`, which sets no headers either --
`crossOriginIsolated=true` on a cold load.

**Proven on the built site, 2026-09-10.** Cold page to
`engine 0.0.0 on node 22.22.3 — in this tab` in **2.7 s** (boot, method
files fetched, 62 engine files mounted, sidecar ready), then the agent
picker rendered **41 providers** from the live registry -- fetched by npm
inside the container -- with the course folder and all eight stages in the
rail.

**Claude Code is pinned, and Anthropic says to pin it.** From v2.1.113 the
npm package ships a per-platform native binary, which cannot execute in a
WebAssembly Node; Anthropic's own note on the change is "If you need the JS
build, pin to an earlier version." So the page installs **2.1.112** (the
last JavaScript build, 2026-04-16) into the container on demand and points
the adapters at it through `CLAUDE_CODE_EXECUTABLE`, which
`@anthropic-ai/claude-agent-sdk` reads before looking for a CLI itself.
`npm_config_omit=optional` in the sidecar's environment keeps every install
in the container from pulling native platform packages it cannot run. The
model the pinned CLI reaches is current -- it is server-side -- but the
wrapper ages, and the failure mode to expect is an auth or minimum-version
change rather than a missing feature. That is what the bridge remains for:
it runs whatever Claude Code the user has, native and current.

**What the search found.** Every other ACP web client solves this the way
the bridge does -- [acp-ui](https://github.com/formulahendry/acp-ui) states
plainly that its web build "omits local stdio agents", and
[acp2web](https://www.acp2web.com/) and Casper run the agent locally and
attach a browser UI. Running the agent *in the tab* appears to be new.
[webcode](https://github.com/wordbricks/webcode) puts Claude Code in
WebContainer as a terminal, but documents nothing about the native cutover.

**Licensing.** The WebContainer API is free for open source and requires a
commercial licence for production use in a for-profit setting; this repo is
the former, and that is a decision to revisit if the site ever is not.

**Material arrives by upload, and sign-in is the CLI's own flow.** In the
tab the course folder is inside the sandbox, so the rail offers a drop zone
instead of a path field and the bytes go straight to the container's
filesystem rather than through JSON-RPC (`writeCourseFile`). `wc.fs`
resolves against the workdir while the sidecar sees real absolute paths, and
the first upload wrote to `/home/<wd>/home/<wd>/course/...` before that was
understood; one `local()` helper now sits on every crossing.

Sign-in is not a protocol method -- the adapters advertise `authMethods: []`
and Claude's flow lives in the CLI -- so the page runs `claude setup-token`
in the container and relays its console verbatim (`agent/signin.ts`): what
it prints is shown, what the user types goes to its stdin, and nothing here
models the flow, so a change at Anthropic's end does not break a
reimplementation that never existed. Two things the terminal made necessary:
the process is given a 400-column pty, because at the default width the
OAuth URL was wrapped across lines and could not be a link; and
cursor-forward sequences are turned into spaces rather than stripped, which
is what turned "Paste code here if prompted" into one word.

**Run end to end in the tab, 2026-09-10**: cold page to a ready engine in
2.9 s, the 4.4 MB biochemistry lecture uploaded into the course folder,
Claude Code 2.1.112 fetched into the container in ~8 s, and `setup-token`
printing its authorise URL and waiting for the code. The token it writes
lands in the container's HOME -- the sandbox -- and does not outlive the tab.

**What the first person through the screen could not find.** They signed in,
connected Claude and uploaded a lecture, and then asked how to start the
process. Three separate failures, all fixed:

- **The steps were not buttons.** `<li>extract</li>` in a list reads as a
  progress display, not a control. Each step is now `role="button"`,
  keyboard-operable, hover-lit, with a `▶` on hover, under the heading
  "Steps — click one to run"; the status line after an upload or a
  connection now names the next click rather than saying "when you are
  ready".
- **"a stage is already running" was shown in red, as an error.** It was
  not one: extract reads the PDFs and then an agent writes, which takes
  minutes, and the second click was simply early. It now names what is
  running and where to watch it, in the ordinary colour.
- **Nothing said a stage was running.** The status line is one line and
  anything can overwrite it -- the error had already replaced
  "running extract…". The step itself now carries the state (`setBusy`
  marks it "running…" in the rail), where it cannot be clobbered, and the
  flag became a label so the refusal can say which.

Also: the "Sign in to Claude" button stayed visible after connecting, a
second door to a room the user was already in; it hides on connect and
returns with the picker. And `Agent` / `Deck` now sit under a "View"
heading with titles saying what each holds.

**Not done, deliberately or not yet.** No stage has been run on the in-tab
tier: sign-in was taken as far as the URL and deliberately not completed,
because finishing it is the account holder's action, not this session's.
The picker's copy still says subscription agents "install on this
computer", which in this tier is the tab, and it lists the registry in its
own order, so a marketplace entry sits above Claude Agent; and the chat bar
shows Mode twice, once as the ACP session mode and once as the adapter's
config option of the same name. Extraction runs only ahead of the extract
stage, so it needs an agent connected; the zero-install tool page cannot
yet extract a PDF on its own. Slides (`pptx`) and documents (`docx`) are
still the agent's to convert, with SETUP.md's commands. The package is not
on npm — `ape` is taken as a name — so the command is the `github:` form,
which works (verified on Node 20.18.1: install, `prepare` build and
`--help` in 5.5 s) but costs a first-run build a published package would
not. Only `npx`-distributed registry agents install —
`binary` ones (Cursor, Devin, Amp) list but do not. A page reload does not
resume its agent connection; reconnecting spawns a fresh adapter while the
old one lives until the bridge exits (`session/load` is the open item in
WORK.md). The agent's stderr is drained and discarded by design (`src/acp/
transport.ts`). Safari has not been tried against loopback from https.
