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
2. **The mode is environment-dependent, not "auto by default."** One capture
   from the same adapter reported `currentModeId: "default"` where others
   reported `"auto"`. Do not read any single capture as the default; read
   the value.

**§17.1's field-name contradiction remains unresolved, deliberately.** §8
says `currentModeId`, §17.1's own example says `modeId`. No real agent has
been observed emitting the notification at all, so there is still no
evidence either way. Both spellings are optional on `CurrentModeUpdate` and
the handler reads whichever is present. Narrow it when an agent is actually
seen sending one — not before.

**Still untested against a real agent:** `session/load` and `session/resume`;
a completed `authenticate` sign-in (the adapter advertises `authMethods: []`,
so there is nothing to authenticate against); and `configOptions`, which
`session/new` also returns and this client still discards — §17.2 is the
mechanism the spec calls current and says will replace modes, and adopting it
needs its own scoping decision including the
`clientCapabilities.session.configOptions.boolean` question.

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

**Next concrete step:** re-login the `claude` CLI, then re-run the smoke
test to close the prompt turn, tool calls, permissions and cancellation.
That is the only remaining question a human unblocks; everything beneath it
is now proven against real agents.


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
