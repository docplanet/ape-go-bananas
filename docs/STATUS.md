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

**Not verified: no real agent.** Every ACP claim here rests on the mock.
No live handshake against `@agentclientprotocol/claude-agent-acp` or Gemini
CLI has been performed — that needs interactive sign-in. The research doc's
own §23 flags that its adapter invocations were read from published source,
not captured from a running session.

One known gap, deliberate: `handlers.ts` implements `fs/read_text_file`,
`fs/write_text_file`, and `terminal/*`, but `session.ts` does not advertise
them — `clientCapabilities` is hardcoded all-`false`, so a spec-compliant
agent will not call them. Legal per §12/§13, and no oracle covers the wired
path.

**Next concrete step:** the live smoke test. Install the adapter, sign in,
spawn it, and confirm a real `initialize` handshake matches §4. That is the
one remaining question the mock structurally cannot answer.

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
