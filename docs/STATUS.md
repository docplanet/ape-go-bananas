# Status

Per-module state, checked by actually running the command named next to each
claim — not by reading the code and assuming. Dated to this integration
pass; re-verify before trusting it against a later commit.

## `src/checks`

**Works.** A complete, differentially-tested port of `tools/check_deck.py`'s
structural checks.

- `test/checks/differential.test.ts` runs the real `python3
  tools/check_deck.py` in the engine repo and diffs its stdout/stderr/exit
  code byte-for-byte against this port, across a generated case corpus (40+
  scenarios) plus the seven reference cards as one deck.
- `test/checks/reference-cards.test.ts`, `cloze.test.ts`,
  `magnification.test.ts`, `transcript.test.ts`, `render-review.test.ts`
  cover each rule and helper directly.
- Verified via `npm test`: every test under `test/checks/` passes.

**Nothing stubbed.** All 20 numbered rules (contract §5.1), the deck-wide
reported numbers (§7), and `render_review.py`'s HTML output are implemented
and tested.

**Next concrete step:** none identified. If the underlying Python tools
change, re-run the differential suite against the new version first.

## `src/apkg`

**Works.** Writes a real `.apkg`: schema-11 SQLite (`collection.anki21`) via
`node:sqlite`, a JSON media manifest, and numbered media members, deflate/
store zipped by a hand-rolled `zip.ts`.

- `test/apkg/schema.test.ts`, `notes.test.ts`, `cloze-ordinals.test.ts`,
  `determinism.test.ts`, `zip.test.ts` cover the schema DDL, `notes`/`cards`
  row shape, one-card-per-distinct-cloze-number generation, clock-seeded
  determinism, and the zip container.
- Every test reopens its output with tools sharing no code with the writer:
  the system `unzip` (a real, independent zip reader) and `node:sqlite` in
  `readOnly` mode.
- Verified via `npm test`: every test under `test/apkg/` passes.

**Verified against real Anki.** `test/apkg/anki-import.test.ts` exports the
seven reference cards and imports the package into a **disposable** Anki 26.5
collection (a fresh `Collection()` under `mkdtemp`, via the Rust backend
bundled in `/Applications/Anki.app`; the user's own collection is never
opened). Result: 7 notes, 14 cards, ordinals
`[[0],[0,1],[0,1],[0,1],[0,1],[0,1],[0,1,2]]`, the `Fixtures::Reference Cards`
deck and `Custom Cloze` notetype created, `slide.jpg` installed into the
profile media directory, and `fix_integrity()` clean.

That test exists because of what it caught. `docs/research/apkg-format.md`
recorded the notetype's top-level `did` as optional; the exporter omitted it;
all 167 other tests passed; and real Anki rejected **every** package with
`decoding models: missing field 'did'`. `default_on_invalid` tolerates a bad
value, not an absent key. Nothing in this repo could have caught that, because
every other apkg test reads the output back with `node:sqlite` and `unzip` —
independent of the *writer*, but not of this repo's *reading of the format*.
A consistent misreading passes all of them. The doc row is now corrected.

The test skips, loudly, when Anki is not installed. A green suite on a machine
without Anki is weaker evidence than a green suite on one with it.

**Still not verified:** AnkiConnect sync (no live tier is built), and the
NFD/NFC filename-fallback path in `media.ts` — its one media fixture,
`slide.jpg`, is plain ASCII.

**Next concrete step:** exercise the media path with a non-ASCII filename, and
decide whether the AnkiConnect live tier is in scope for this repo at all.

## `src/acp`

**Implemented and green.** A JSON-RPC-over-stdio ACP v1 client in six files
— `framing.ts`, `transport.ts`, `protocol.ts`, `session.ts`, `handlers.ts`,
`index.ts` (~1,960 lines). Public API is `connect({command, args, env,
onPermissionRequest})` → `newSession()` → `prompt()` returning an async
iterator of streamed updates.

- All five oracle suites pass: framing, lifecycle, cancellation,
  permissions, errors. `npm test` reports 191 pass, 0 fail, 0 skipped, and
  `npm run typecheck` exits 0.
- The suite and its 356-line `mock-agent.ts` were written from the spec by
  an agent that never saw an implementation, and the implementers were
  barred from editing them. That independence is the only reason a green
  ACP suite means anything.
- Permission requests route through the caller's policy callback. There is
  no auto-approve path; denial is a tested branch.

**Green against the mock was never the claim worth making.** Review found
four defects no passing suite could have surfaced, because each needs an
agent the mock is not:

1. `withinMs()` attached no rejection handler to the child's exit promise,
   so a spawn failure became an unhandled rejection that killed the host
   process — and `close()` rejected, contradicting the "never rejects"
   contract `session.ts` explicitly relies on.
2. A response whose `id` came back as a string instead of a number was
   dropped silently, hanging the request forever with no timeout and no
   diagnostic. The mock echoes ids verbatim, so it cannot produce this.
3. `session/new` results were cast, not validated: an agent answering with
   a differently-named field yielded `sessionId: undefined` and put a
   `session/prompt` frame on the wire with the required field absent.
4. Every `session/update` arriving outside a prompt turn was discarded —
   which is precisely how real agents announce their slash-command catalog
   right after session creation. The mock only ever sends updates inside a
   turn.

All four are fixed, each reproduced against a hand-built fake agent before
and after. Fixing (4) also surfaced a narrower race the finding had not
named: an update can arrive in the same stdout chunk as the `session/new`
response that mints its id, reaching the router before the session is
registered. Out-of-turn updates are now buffered and flushed rather than
dropped.

**One test was wrong, and it was the oracle.** `lifecycle.test.ts`'s
`readMockLog()` mapped the mock's entire transcript — both directions —
while its call site indexed as though it held only what the client sent, so
index 1 was the `initialize` response rather than `session/new`. The
implementer left it red and explained rather than editing it, which is the
rule working as intended. Confirmed independently by dumping a real log
(`[init-req, init-resp, session/new-req, session/new-resp]`) before changing
anything; the fix is the direction filter the `LoggedLine` type already
described.

**Verified against real agents, up to the prompt turn.** Two live smoke
tests were run with every stdio byte captured through a pass-through tee:
`@agentclientprotocol/claude-agent-acp` 0.75.1 (via `npx`, no global
install) and Gemini CLI 0.40.1 (`gemini --acp`, first-party ACP). Handshake
PASS against both; `session/new` PASS against the Claude adapter with a real
UUID. Confirmed on the wire: `initialize` matches §4 and negotiates
protocolVersion 1; all-`false` `clientCapabilities` is accepted; real
streamed `session/update` notifications flow (`available_commands_update`,
`agent_message_chunk`, `usage_update`); JSON-RPC errors surface as
rejections; an unmodelled `_auth/status_update` arriving *before* the
`session/new` response did not derail the router; `close()` reaped both
subprocesses.

**The finding that justified the whole exercise:** §4.4's presence-typed
convention was read correctly. The Claude adapter sends

    "sessionCapabilities": {"close":{}, "delete":{}, "fork":{}, "list":{},
                            "resume":{}, "subagents":{}, "additionalDirectories":{}}

— empty objects, not booleans — and Gemini omits the block entirely.
`normalizeAgentCapabilities()` flattens both correctly. Had it expected
booleans, every capability would have read falsy, the client would have
silently believed the agent supports nothing, and **every mock test would
still have passed**. This is the class of defect a mock cannot produce.

**Three findings from the live runs, none yet fixed:**

1. `fork` and `subagents` are advertised by the shipping Claude adapter and
   are silently dropped — they are absent from both the `SessionCapabilities`
   interface (`protocol.ts:77`) and the wire `Record` (`protocol.ts:104`),
   so a caller cannot see them at all. Confirmed on the wire, not inferred.
2. Gemini violates §2 by writing a bare non-JSON line to **stdout**
   (`Skipping project agents due to untrusted folder.`) with no trailing
   newline before exit. The client did not crash; it reported `stream ended
   mid-line`. Open decision: tolerate stdout noise, or keep erroring.
3. Latent: the presence check is `!= null` (`session.ts:307-311`), so a
   literal `false` on the wire would read as *supported*. Neither real agent
   does this today.

**The prompt turn is now proven live.** After a `claude` CLI re-login, a
full smoke test ran against `@agentclientprotocol/claude-agent-acp` 0.75.1:

- a prompt turn completes with `stopReason: "end_turn"`, streaming
  `agent_message_chunk` / `usage_update` / `available_commands_update`;
- real tool calls flow as `tool_call` + `tool_call_update`;
- `session.cancel()` mid-turn yields `stopReason: "cancelled"` (§14.1's
  MUST), with the turn's own iterator returning it rather than throwing;
- `close()` reaps the subprocess, zero strays.

**Permission requests work end to end, and the earlier conclusion here was
wrong.** An earlier revision of this file said "no part of the app should
present ACP permission requests as a safety guarantee." That was true of the
client as it stood; it is not true now, and the correction matters more than
the original claim.

What was actually happening: `session/new` returns a `modes` block whose
`currentModeId` is inherited from the host's own agent configuration. When
that is `auto`, the agent decides permissions itself and never asks — which
is why an early smoke test saw a file written unprompted with zero
`session/request_permission` calls. The client was behaving correctly; it had
nothing to route. The mode was the variable, and the client neither read it
nor could change it.

Both are now implemented. `session/set_mode` (§17.1) pins the mode, and
`modes`/`currentModeId`/`availableModes` are surfaced off the session so a
caller can see which mode it is in and observe `current_mode_update` if an
agent switches unilaterally.

Verified live against `claude-agent-acp` 0.75.1, twice, by two contexts —
once by the implementer, then independently re-run with a separate harness:

| step | observed |
| --- | --- |
| session opens | `currentModeId: "auto"` |
| `setMode('default')` | mode becomes `default` ("Manual: always ask before making changes") |
| prompt requesting a file write | real `session/request_permission` — `kind: "edit"`, options `allow-once` / `allow-with-updates` / `reject` |
| callback **denies** | file **not** created, directory empty, turn still ends `end_turn` |
| callback **approves** | file created, turn ends `end_turn` |

So APP.md's flag-and-approve model is viable — conditional on pinning the
mode, which A.P.E. can now do. Anything built on it must call `setMode`
explicitly and must not assume a default.

**Two things only the live run could settle:**

1. **No `current_mode_update` follows `set_mode`.** Zero, in every capture.
   The empty result *is* the entire acknowledgement, so `setMode()` updates
   the tracked mode on that result. Awaiting a notification — the obvious
   implementation — would have left the client silently believing it was
   still in `auto` while actually in Manual. A mock would have happily sent
   whatever notification its author expected.
2. **`currentModeId` comes from host config, and the mapping is not 1:1.**
   An earlier revision of this file called it "environment-dependent," which
   was wrong. A deliberate experiment, writing a project-level
   `.claude/settings.json` into the session cwd rather than touching any
   global config:

   | host config | `currentModeId` returned |
   | --- | --- |
   | global `auto`, no project setting | `auto` |
   | project `defaultMode: "plan"` | `plan` |
   | project `defaultMode: "acceptEdits"` | **`default`** |

   So project settings override global and the value is config-driven, not
   environmental — but `acceptEdits` does **not** map through, landing on
   `default` even though the adapter advertises `acceptEdits` in its own
   `availableModes`. Two consequences: never infer the mode from the host's
   configuration, because the agent may not have adopted the value you set;
   and never assume a default. Read `currentModeId`, and call `setMode` if
   you need a specific one.

   (An early capture of `default` was taken against an *unauthenticated*
   adapter, which is consistent with config being applied only once auth
   loads. That specific mechanism is plausible but was not separately
   tested here, and is not the basis for anything above.)

   **Config is advisory; `set_mode` is authoritative.** The obvious next
   inference from the table above — that the whole mode surface is
   unreliable — is false, and the distinction is the useful part. A mode
   that will not survive the trip through host config *is* adopted when set
   at runtime. Confirmed behaviourally, since the agent never announces its
   mode, by observing whether it asks and whether it writes:

   | mode via `setMode()` | reports | what it asked for | file written |
   | --- | --- | --- | --- |
   | `acceptEdits` | `acceptEdits` | nothing | **yes** |
   | `plan` | `plan` | `Approve Plan` (`kind: switch_mode`) | no |
   | `default` | `default` | `Write <path>` (`kind: edit`) | only when approved |

   The middle column is the correction. An earlier revision recorded `plan`
   as "asked once, wrote nothing" — which is *identical* to `default` with a
   denial, so it did not distinguish the two modes at all and the adoption
   claim rested on nothing. Capturing the tool name separates them: only
   plan mode raises `ExitPlanMode`/"Approve Plan". The verdict was right and
   the evidence was not.

   Three modes, three distinguishable behaviours, each matching what the
   mode means. `acceptEdits` is the direct contrast: unusable through
   config, adopted through `setMode`. So `setMode()` committing
   `currentModeId` on set_mode's empty result is honest rather than
   optimistic — the client reports a mode the agent is genuinely in. Scope:
   one adapter, one run per mode; `bypassPermissions` untested, deliberately.


**§17.1's field-name contradiction remains unresolved, deliberately.** §8
says `currentModeId`, §17.1's own example says `modeId`. No real agent has
been observed emitting the notification at all, so there is still no
evidence either way. Both spellings are optional on `CurrentModeUpdate` and
the handler reads whichever is present. Narrow it when an agent is actually
seen sending one — not before.

**§17.2 `configOptions` is implemented, and it pins the mode too.**
`session/new` also returns `configOptions` — the mechanism §17.2 calls
current and says will replace Session Modes. It is now surfaced, with
`setConfigOption()` and the `config_option_update` notification. Live, the
adapter reports five `select` options (`mode`, `model`, `effort`, `fast`,
`agent`); `setConfigOption('mode', 'default')` returns the **full five-option
state** rather than the one field set, is adopted wholesale, and the pinned
mode takes effect behaviourally — one permission request, denied, no file
written. So the same adapter exposes both §17.1 and §17.2 and honours either.

The client does not advertise `clientCapabilities.session.configOptions.boolean`,
deliberately: §17.2 forbids an agent sending boolean options unless the client
asks for them, so staying silent keeps us to `select`, which is what a mode
selector is. Boolean options are surfaced defensively if a non-compliant agent
sends them, never requested. Same reasoning as `auth.terminal`.

**A parked finding turned out to be the most dangerous thing in the module,
and parking it was the wrong call.** The `!= null` presence check was logged
here as a latent nobody could trigger. It was not latent in scope: it
inverted **all eight** capability fields at once, and both `logout()` and
`newSession({additionalDirectories})` are gated on those fields — so the
client would have sent an agent methods it had just been told were
unsupported. "No real agent triggers it today" was the reason it would rot,
not a reason to leave it. Fixed in `9f31d8e` with an explicit `isSupported()`
(present, non-null, not literal `false`) and pinned by a CAPS_LITERAL_FALSE
scenario.

**Provenance of the verification — read this before trusting any green
number above.** Not all of `src/acp/` is evidenced equally, and the
difference is structural rather than a matter of care:

| commit | what it added | who wrote the oracle | external check |
| --- | --- | --- | --- |
| (original five suites) | framing, lifecycle, cancellation, permissions, errors | an agent that never saw an implementation | strong: implementer could not edit the tests |
| `01c0745` | `authenticate` / `logout` / `terminalAuthLaunch` (§5) | the implementer | independent review, incl. 9 mutations — passed |
| `2dc9ec9` | `sessionCapabilities` fork/subagents, `Partial<Record>`, CAPS_PRESENCE (§4.4) | the implementer | independent review, incl. 9 mutations — passed |
| `234f903` | §17.2 `configOptions`, `setConfigOption()` | the implementer | live behavioural verification only |
| `9f31d8e` | `isSupported()` replacing `!= null` | the implementer | live behavioural verification only |
| `06dbf46` | `modes`, `setMode()`, `current_mode_update` (§17.1) | the implementer | independent live re-run from a second context, covering the approve branch the first run did not |

Three consecutive commits had oracle and implementation authored by one
context. Ordering was the mitigation — every assertion written from the spec
and watched fail for the right reason before any `src/` existed — but that is
weaker than an author who cannot see the implementation, and one assertion in
`01c0745` was admittedly edited afterwards (a regex that guessed the wrong
wording; it is commented as such at the site). The context in question
flagged this unprompted every time, which is the only reason it is visible
here at all. Do not read "209 pass" as uniform evidence.

**Still untested against a real agent:** `session/load` and `session/resume`
— both agents advertise `loadSession: true` and the client implements
neither — and a completed `authenticate` sign-in, which is not actionable:
the Claude adapter advertises `authMethods: []`, so there is nothing to
authenticate against, and Gemini's individual tier is discontinued
server-side. (`configOptions` was on this list; it is implemented and live-
verified as of `234f903`.)

**Auth is out-of-band for Claude Code.** The adapter returns
`authMethods: []` and reports state via an `_auth/status_update`
notification (`authStatus {kind:"none"}`) — sign-in belongs to the
underlying CLI, not to ACP. So implementing ACP `authenticate` will not
unblock Claude Code. Gemini CLI 0.40.1 *does* advertise four methods
(`oauth-personal`, `gemini-api-key`, `vertex-ai`, `gateway`), which is where
`authenticate` earns its place.

One known gap, deliberate: `handlers.ts` implements `fs/read_text_file`,
`fs/write_text_file`, and `terminal/*`, but `session.ts` does not advertise
them — `clientCapabilities` is hardcoded all-`false`, so a spec-compliant
agent will not call them. Legal per §12/§13, and no oracle covers the wired
path.

**Next concrete step:** `session/load` / `session/resume`. Both agents
advertise `loadSession: true` and the client implements neither, so a host
cannot reopen a session it created — which the app's resumable-run design
needs. Everything else in this module is either done, live-verified, or
blocked on something no agent can do.


## `src/cli`

**Works, end-to-end, against the reference fixture.** Three subcommands
(`check`, `review`, `export`) wired onto `src/checks` and `src/apkg`.

- `test/integration/pipeline.test.ts` spawns the real, built
  `dist/cli/index.js` as a child process (never the underlying functions
  directly) through `check` (must pass clean) → `review` (writes real HTML)
  → `export` (writes a real `.apkg`) on the seven reference cards, then
  reopens that `.apkg` with the system `unzip` and `node:sqlite` and checks
  note count (7), card count (14 — one per distinct cloze number, hand-
  counted from the documented per-card shapes, not computed by anything
  this repo ships), deck name, notetype, and every note's round-tripped
  field content.
- `test/integration/cli-errors.test.ts` covers argv/exit-code behavior the
  golden path doesn't exercise: no arguments, an unknown command, a missing
  positional, a missing file, malformed JSON, a note missing
  `fields.Text`, a deck naming zero notes (the contract's own distinct
  exit-2 case), a genuinely dirty note (`PROBLEMS:`, exit 1), the
  `--no-media`/missing-media-dir-note interaction, `--deck-name`
  default-and-mismatch behavior for `export`, and `--inventory` wiring
  (both a qualifying-rows file and an empty one).
- Also exercised by hand beyond what's automated: every flag combination
  above run directly against a shell, output inspected manually, before any
  of it was written down as an assertion.
- Verified via `npm test`: every test under `test/integration/` passes (15
  `test()` cases: 1 in `pipeline.test.ts`, 14 in `cli-errors.test.ts`).

**Deliberately not a byte-for-byte port of either Python CLI**, though
`check`'s argument handling and exit-code contract are: confirmed directly
against `tools/check_deck.py` in the engine repo (not just the doc) for the
exact ordering of flag parsing → media-dir note → `--transcript` loading →
`--inventory` loading → deck loading → the empty-notes check. `review`'s `-o`
flag and `export` (which has no Python original at all) are this task's own
design, documented in the README's CLI section and in each subcommand's own
file header.

**Not verified:** nothing beyond what `src/checks`/`src/apkg` themselves
leave unverified (see above) — the CLI layer adds no new unverified claim of
its own, since it does no work `writeApkg`/`checkDeck`/`renderReview` don't
already do.

**Next concrete step:** none identified for the three subcommands as
specified. If `src/acp` is implemented, an `ape agent`-style subcommand (or
similar) would be the natural next piece of CLI surface, but nothing in the
current task called for it and no such subcommand exists.

## `src/sidecar`

**Works, oracle-tested.** The engine as a stdio child process for the app:
newline-delimited JSON-RPC 2.0 per `docs/research/sidecar-protocol.md`,
framed by `src/acp/framing.ts` unchanged. Ten methods: `sidecar/ping`,
`sidecar/shutdown`, `media/dir`, `deck/load`, `deck/check`, `deck/review`,
`deck/export`, `flags/read`, `flags/write`. Each is a thin adapter over the
same calls `src/cli` makes; none decides anything about a card.

- `test/sidecar/` (36 cases: lifecycle 11, framing 11, methods 14) was
  written from the spec by a context barred from reading `src/sidecar/` or
  `dist/sidecar/`, before the implementation was run against it. First run
  against the implementation: 36 pass, 0 fail. Two strict readings the
  oracle took are now pinned by it: `deck/review` writes nothing without
  `outPath`, and a rejected `flags/write` stores nothing.
- Each error code in §3 is exercised, and the process is shown to survive
  every one. `deck/export` is reopened with `unzip` + `node:sqlite` (7 notes,
  14 cards), the same independent-reader technique as `test/integration`.
- One defect found by hand before the oracle existed: `sidecar/shutdown`'s
  `{}` was never written, because the exit was scheduled against the
  outbound queue *before* the handler's own response joined it. Fixed by
  deferring the exit one tick; `lifecycle.test.ts` now pins the order.
- Verified via `npm test`: 256 pass (219 prior + 36 + the helper file), 0
  fail, 0 skipped; `npm run typecheck` exits 0.

**Not verified:** nothing beyond what `src/checks`/`src/apkg`/`src/cli`
leave unverified; the sidecar adds no engine behaviour of its own.
`agent/*` (§5) is reserved and unimplemented.

**Next concrete step:** the `agent/*` bridge over `src/acp`, including the
reverse-direction `agent/requestPermission` request, which `app/src-tauri/
src/sidecar.rs` already routes to a `sidecar://request` event but does not
answer.

## `app/`

**Launches, drives the engine end to end, placeholder UI.** Tauri 2.11 shell
with a Rust-owned Node sidecar (`src-tauri/src/sidecar.rs`), a typed
frontend surface (`src/sidecar.ts`), and the engine's own review page
framed as the card preview with a Flag button per card (`src/preview.ts`).
Decisions and their reasons: `docs/APP.md`.

Verified by running `npm run app:dev` with `APE_OPEN=<fixture deck>` and
`ANKI_MEDIA=<temp media dir>`, reading the app's stderr:

| step | observed |
| --- | --- |
| `cargo build` (debug) | clean, 49 s cold |
| window up | `node …/v24.12.0/bin/node …/dist/sidecar/index.js` running as a child of `target/debug/ape-app` |
| frontend start | `sidecar/ping` then, for the opened deck, `deck/load`, `deck/check`, `deck/review`, `flags/read` — the full preview path, driven from the webview through `sidecar_call` |
| window closed | no sidecar process remains |

Two defects found by launching, neither reachable by any test here:

1. tokio's `Command::spawn` panicked (`there is no reactor running`) because
   Tauri's `setup` hook runs outside the async runtime. Fixed with
   `tauri::async_runtime::block_on` around the spawn.
2. The default shell `node` here is 20; the sidecar died on
   `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`. `resolve_paths` now runs
   `--version` and refuses below 24 with a message naming `APE_NODE`;
   `app:dev` sets `APE_NODE` to npm's own Node.

**Not verified:** the rendered window itself (screen capture is not
permitted from this session — the layout was checked only through the Vite
dev server in a browser, where the engine bridge is absent by design); the
Flag button's click path (the message bridge in `preview.ts` and
`flags/write` are each verified separately, the click between them is not);
drag-and-drop of a folder; asset-protocol image loading inside the preview
iframe; a release build (`resolve_paths` refuses without `APE_SIDECAR` —
packaging is an open decision in `docs/APP.md`).

**Next concrete step:** Claude Design screens over the same three seams
(`sidecar.ts`, `preview.ts`, `main.ts`), then the `agent/*` bridge so the
chat pane and the flag → adjudicator route exist.

## `src/agents`, `src/agent`, and the sidecar's `agent/*`

**Works, oracle-tested, and verified live against the real registry and a
real Claude session.** Three modules, one method surface
(`docs/research/agent-protocol.md`):

- `src/agents` — the public ACP registry (Zed's mechanism, copied: `docs/
  research/agent-install-and-auth.md`), cached per data directory, and
  `npm install` of an entry into `<dataDir>/npx/<id>` with the sidecar's own
  Node. `test/sidecar/agents-install.test.ts` (11 cases, written blind
  against a local fake registry and a local fake npm registry with a real
  tarball): 11 pass. One defect it caught before the code was run by hand:
  `agents/install` carries no registry URL, and the cache was keyed on the
  default CDN, so an install after a list against any other registry could
  not find its entry. The cache now remembers its own source.
- `src/agent` — the embedded OpenRouter loop (`docs/research/openrouter-api.md`),
  implemented by one context and tested by another from the same page, with
  neither reading the other. `test/sidecar/agent-openrouter*.test.ts` (26
  cases over a local fake OpenRouter serving SSE, tool-call deltas, the
  mid-stream error chunk, 402/429): **26 pass on the first run**. The oracle's
  strict readings (tool `kind` mapping, `failed` on refused paths, exactly
  one `current_mode_update` on allow-always) all held.
- `src/sidecar/agent.ts` — the bridge. `test/sidecar/agent-acp.test.ts` and
  `agent-login.test.ts` (14 cases over `test/acp/mock-agent.ts`, three
  scenarios added): 14 pass, after three findings the oracle made against the
  first build: in-turn updates were drained but never forwarded (the ACP
  client hands them only to the prompt iterator); `modes.currentModeId` was
  the session/new snapshot, not the pinned value; and session ids were the
  agent's own, so two connections to one agent collided. Fixed, all three.
- `src/acp` grew `ConnectOptions.clientCapabilities.auth.terminal` and
  `onExtNotification` (for `_auth/status_update`). `test/acp/auth-terminal.test.ts`
  (9 cases, blind, plus a mutation run against a build with the option
  removed: 5 of 9 fail there, as they should): 9 pass. `onExtNotification`
  has no unit oracle of its own — it is exercised only through
  `agent-login.test.ts`'s `agent/authStatus` case. Self-authored, noted.

**Live, through the sidecar** (`agents/list` → `agents/install` →
`agent/connect` → `agent/prompt`, real network, the operator's real login):

| step | observed |
| --- | --- |
| `agents/list` | 40 entries from `cdn.agentclientprotocol.com`, 22 `npx`-installable (claude-acp, gemini, codex-acp, github-copilot-cli, qwen-code, …) |
| `agents/install claude-acp` | `@agentclientprotocol/claude-agent-acp` 0.75.1, 105 packages, 243 MB including the `claude` binary, 3 s (warm cache) |
| `agent/connect` | `authStatus: account / Claude Max`; modes pinned to `default`; five config options (`mode`, `model` ×5, `effort` ×6, `fast`, `agent`); 53 commands |
| `agent/prompt` "reply ready" | `end_turn` in 2.4 s; `agent_message_chunk` text `"ready"`; `usage_update` |
| `agent/prompt` "create hello.txt" | reverse `agent/requestPermission` "Write hello.txt" relayed to the app, answered allow, file present |

Sign-in was verified separately with an isolated `CLAUDE_CONFIG_DIR`
(`docs/research/claude-adapter-auth.md`): the adapter advertises the
Subscription and Console methods once `auth.terminal` is on, and its login
command runs headless, opening the browser and waiting on a localhost
callback. **Not exercised: a completed sign-in through `agent/login`** — that
needs a real account to log in, and the operator's was already logged in.

**One implementer edit to a blind test:** `test/sidecar/framing.test.ts`'s
unknown-method case probed `agent/prompt`, which the first spec reserved and
the second defines. The probe name moved; nothing else in that file changed.

**Next concrete step:** the pipeline stages — build each stage's
`ape://system` block from the bundled method file and turn the review gates
into screens — and a completed `agent/login` against a signed-out account.

## `app/` — slice 2

The provider picker (`src/providers.ts`), chat pane (`src/chat.ts`), OS
keychain for API keys (`secret_*` commands, `keyring` crate), and the reverse
channel (`sidecar://request` event → `sidecar_answer` command). Verified by
launching: the webview reached `agents/list` and the real registry was cached
under `~/Library/Application Support/dev.docplanet.ape/`. Clicks through the
picker, sign-in, and chat in the running window are **not** verified from
this session (no screen capture); every call they make is verified at the
sidecar level above.

## The pipeline as screens (`app/src/pipeline.ts`, sidecar `method/*`, `course/*`)

**Works, oracle-tested for the file methods, verified live for stage 1.**
`docs/research/course-protocol.md` adds four read-only methods so the
webview never touches the filesystem: `method/list`, `method/read` (the
bundled method files, from `APE_METHOD_DIR` which the app sets to the
`method/` resource, or the method repo in dev), `course/list` and
`course/read`. `test/sidecar/course.test.ts` (9 cases, blind): 9 pass on
the first run. `agent/newSession` (the adjudicator's seat) has no blind
oracle — self-authored wiring over the tested `openAcpSession`/
`openApiSession` paths; noted.

A stage's prompt is: the method file as the `ape://system` block, one
app-side sentence naming the folder, the deck name and the artifact to
write, the materials listing, and every PDF/image/text file as a
`resource_link`. The review gates read the artifact back and show it. Audit
sends the flags, the deck and method 3 to a **fresh session**, asks for one
verdict per flag written to `verdicts.md`, and the writer session then
applies them verbatim — the standing rule, as wiring.

Live, `extract` on a two-file synthetic course (a one-page text PDF and a
short transcript) through the installed Claude agent, using exactly the
blocks `stageBlocks` builds: `end_turn` in 118 s; five tool calls (two
Terminal, two Read File, one Write) with two permission requests relayed and
answered; `inventory.md` written (8.5 KB) in the method's own shape — files
read back, `## Facts` with entity/source/quote/signal per fact, a
`## Carried to handover` section. The run also found a gap in the app's
ask: the method refuses to infer the deck name, and the app had not asked
for one. It now does.

**Not verified:** organize, cards, audit and apply-verdicts live (the same
mechanism, untested end to end); any stage through the OpenRouter tier live
(the embedded loop's attachments are oracle-tested against the fake only);
every click in the window.

## Releases and the updater

**v0.1.0 is published**, with `latest.json` naming every platform.
`.github/workflows/release.yml` run 34158334590: four jobs, all green —
Apple silicon (which also runs the engine suite: 342 pass), Intel Mac
(cross-compiled on the same runner), Windows (NSIS), Linux (AppImage + deb).
Each job's log shows the target's official Node fetched from nodejs.org,
its SHA-256 verified against `SHASUMS256.txt`, and node + npm + engine +
method files staged before `tauri build`. Every URL in the published
`latest.json` answers 200. The macOS arm64 build was additionally unzipped
into a fresh folder and launched with an empty PATH: the bundled node ran
the bundled sidecar.

**Not verified:** the Windows installer and the Linux packages were never
launched — no runner here can. Their layout follows Tauri's documented
paths (`resource_dir` = the exe's directory on Windows,
`/usr/lib/ape-app` or `$APPDIR/usr/lib/ape-app` on Linux), which
`resolve_paths` reads through Tauri, with a derived-from-exe fallback that
is correct on Windows and macOS only. The first Windows or Linux user is the
first test. The in-app update path (check → download → verify → relaunch)
is wired and typechecked but has had no second release to update to.

**Harness debt the runners exposed:** the apkg and differential suites
spawn `unzip` and `python3` as a Mac ships them; on Linux two zip cases
fail and on Windows most differential cases do, on tooling rather than
engine behaviour. The engine is therefore tested on one platform. Recorded
in `docs/WORK.md`.
