# Work claims

Two Claude sessions have worked in this repo concurrently. Cross-session
messages are delivered *between* turns, so while one session is mid-task the
other's message sits queued — every status message either sent or received
during a long turn is stale on arrival. That happened repeatedly and it
caused near-duplicate work.

Messages are asynchronous. The repo is not. So claims live here, not in
messages.

## Protocol

1. **Before starting anything: `git pull`/check HEAD, then read this file.**
   Not the last message you received — that is older than HEAD.
2. **To claim: add a row, commit it alone, then start.** A commit is atomic
   and both sessions see it. If two claims race, the later commit loses and
   that session picks something else.
3. **To finish: move the row to Done with its commit SHA.**
4. **Never claim by message.** A message can cross with the work it claims.
5. If a row is claimed and untouched for a long time, take it — but commit
   the re-claim first.

## Ownership

| area | owner |
| --- | --- |
| `src/**`, `test/**` | whichever session holds the claim below |
| `README.md`, `docs/STATUS.md`, `docs/WORK.md` | the docs session (currently: this one) |

Stage explicit paths on every commit. `git add -A` in a two-writer repo
sweeps the other session's uncommitted work into your commit — that happened
once (see `git notes show b383e7a`).

## Claimed

| item | session | notes |
| --- | --- | --- |
| _(nothing claimed)_ | | |

## Unclaimed

| item | why it is open |
| --- | --- |
| `session/load` / `session/resume` | both agents advertise `loadSession: true`; the client implements neither. Real gap, bigger surface than the claimed items. |
| any stage on the OpenRouter tier live | the ACP tier ran the whole pipeline on a real lecture (STATUS); the embedded loop's attachments are oracle-tested against the fake only |
| method repo: `1-extract.md` must state the fact numbering the check parses (`\| <n> \|` rows → `fact::F<n>`) | the live run wrote `A1…` rows and the inventory cross-check could not run |
| a portable test harness: the apkg and differential suites spawn `unzip` and `python3` as a Mac ships them, so the engine is tested only on the Apple silicon CI job | Windows and Linux runners fail 2 (Linux) and ~all differential (Windows) cases on tooling, not engine behaviour; replace `unzip -l` parsing with a Node zip reader and resolve `python3`/`python` |
| picker order: subscription agents before marketplace entries; the duplicated Mode control in the chat bar | cosmetic, seen on the first website run |
| a completed `agent/login` against a signed-out account | the launch line and headless behaviour are verified; the callback completion is not |
| designed screens (Claude Design) over `app/src/{sidecar,preview,providers,chat,main}.ts` | the current layout is a placeholder by declaration (`docs/APP.md`) |
| packaging the engine into a release build | `resolve_paths` refuses without `APE_SIDECAR`; Node SEA vs. require-Node is undecided |
| Gemini writes bare non-JSON to stdout, violating §2 | needs a behavioural decision — tolerate stdout noise, or keep erroring — not just an implementation |
| a completed `authenticate` sign-in | not actionable: the Claude adapter advertises `authMethods: []`, and Gemini's tier is discontinued server-side |

## Deliberately not doing

| item | why |
| --- | --- |
| `bypassPermissions` through `setMode` | it is the one mode whose defining property is the absence of a safety property. Running it means letting an agent act with no permission gate to confirm what we already predict: low information, non-zero risk. |

## Done

| item | commit |
| --- | --- |
| ACP client — framing, transport, protocol, session, handlers | `ff5dbd1` |
| `authenticate` / `logout` / `terminalAuthLaunch` (§5) | `01c0745` |
| `sessionCapabilities` fork/subagents, `Partial<Record>`, CAPS_PRESENCE (§4.4) | `2dc9ec9` |
| `modes`, `setMode()`, `current_mode_update` (§17.1) | `06dbf46` |
| live smoke tests, mode matrix, doc corrections | `9881765` `1766573` `8cda031` `eb899d7` `7facd8b` |
| §17.2 `configOptions`, `setConfigOption()`, `config_option_update` | `234f903` |
| `!= null` read a literal `false` as supported — `isSupported()` + CAPS_LITERAL_FALSE | `9f31d8e` |
| all four independent-review findings (cwd, three regexes, explicit `null`, `authMethods`) | `d9eca7d` |
| stdio sidecar (`src/sidecar`, protocol doc, 36-case oracle written blind) | _this commit_ |
| Tauri shell `app/`: Rust-owned sidecar, typed frontend surface, review-page preview with flags, placeholder layout | `9ce375d` |
| provider registry + install (`src/agents`), embedded OpenRouter agent (`src/agent`), sidecar `agent/*` bridge, `auth.terminal` + `onExtNotification` in `src/acp`, picker + chat + keychain in `app/` | `e1f6dba` |
| bundled Node/npm/engine/method files, release path resolution | `5696513` |
| `method/*`, `course/*`, `agent/newSession`; stages, review gates, audit → verdicts → apply, deliver in `app/` | `7f8cd32` |
| whole-deck audit stage (`4-audit.md`), run live: 61 findings, 54 fixed | `5a00f04` |
| engine made platform-neutral: SQLite/deflate/media/rule-2 injected, `buildApkg` and `parseDeckNotes` split out, `sha1`+`crc32` written and pinned against `node:crypto`/`node:zlib` | `b4a78de` |
| `site/` browser tool: sql.js + fflate adapters, engine in a Worker, checks/review/`.apkg` with nothing installed; parity test vs the Node build | `e5e36df` |
| CI on push and PR; Pages builds the site instead of copying it | `a31d001` |
| sidecar core extracted (`dispatch.ts`), HTTP/SSE transport (`serve.ts`, 14 tests), `ape-bridge`, `src/pipeline` over an injected client, lazy `node:sqlite` so the bridge starts on Node 20 | `a85b01f` |
| the page as the full app over the bridge: picker, sign-in, chat, eight stages, flags, audit → adjudicate → apply; run end to end live | `6d7628a` |
| live from the published site in Chrome 152; Brave's localhost block named in the error; `SETUP.md` fetched and attached to extract; permission policy answers reads and in-folder edits (`permission-policy.ts`, 6 tests) | `80f8e2c` `6f95273` |
| PDFs read in the tab: pdf.js text + one JPEG per page under `_extracted/`, `course/write` and `course/list.extracted` (11 course tests), `describeExtracted` in the prompt (5 pipeline tests), deadlines on a dead worker; run live on a 41-page lecture | _this commit_ |
| tiering rule written into the method (no count; signal, then time) — method repo `548036d`; Muscle deck re-tiered 122 core / 53 plus | _method repo_ |

`npm test` counted wrong until `b4a78de`. Bare `node --test` matched any
file ending in `test.js` anywhere beneath the repo, including twelve from
the npm bundled into `app/src-tauri/` build artifacts; scoping it to
`test/**/*.ts` still ran thirteen helpers and child-process entry points as
tests. It now names `*.test.ts` and reports 323, which is the number of
tests. Any figure quoted from before that is inflated.

Only the `cwd` omission changed behaviour on the wire. The regex finding was
the most instructive: re-running the reviewer's mutation confirms the terminal
test now dies when the guard is deleted, where before only the zero-frame
assertion caught it — an assertion that matches the error message of the peer
you are testing against is not an assertion. `authMethods` is now validated
and frozen, and typed `readonly AuthMethod[]` so the guarantee is visible.

Recorded, not fixed: 2dc9ec9's `Partial<Record<…>>` widening is unenforceable
— reverting it passes both suite and typecheck. The type is more truthful, but
that commit message overstated it as a fix. Not counted as tested.

Both verified live against claude-agent-acp 0.75.1 as well as the mock.
`setConfigOption('mode','default')` returned the full five-option state, was
adopted wholesale, and the pinned mode took effect behaviourally (one
permission request, denied, no file written).

`setMode` adoption, closing the matrix offered earlier: `acceptEdits` adopted
(zero permission requests, file written); `plan` adopted (the request raised
was `ExitPlanMode` / "Approve Plan", which exists only in plan mode);
`default` adopted (already covered by both permission runs). So the tracked
mode is honest for every mode tested, and `setMode`/`setConfigOption` are
authoritative where host config is only advisory.

One correction, recorded because it nearly became a false finding: the first
`plan` probe reported "not adopted" on a heuristic — no permission request
means adopted — that is only valid for `acceptEdits`. In `plan` the agent
*should* ask. Re-running with the tool name captured showed `ExitPlanMode`
and reversed the verdict.
