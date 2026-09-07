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

**Not implemented.** `src/acp/` contains only a `.gitkeep` placeholder — no
`.ts` file exists there. This is a plain fact confirmed by directory
listing and by `npm run build`, which produces no `dist/acp/` at all.

**What already exists for it:** `docs/research/acp-protocol.md` (a 96KB
implementer's-reference doc on the ACP v1 wire protocol) and a full
`test/acp/` scaffold — `mock-agent.ts`, `raw-agent.ts`, `scenarios.ts`, and
five `*.test.ts` files covering framing, lifecycle, cancellation,
permissions, and error handling. Every one of those test files imports from
`../../dist/acp/index.js`, i.e. they were written against an intended public
API (`connect()`, an `AcpClient` type, etc.) that has not been built yet.

**Effect on the repo as a whole, confirmed by running these exact commands:**

- `npm run build` (bare `tsc`, root `tsconfig.json`, `include: src/**/*.ts`
  only): clean. `src/acp/` has nothing in it to fail.
- `npx tsc --noEmit` (same config): clean, for the same reason.
- `npm run typecheck` (`tsc --noEmit -p tsconfig.test.json`, which adds
  `test/**/*.ts` to the include list): **not** clean — 43 error lines, every
  one of them in `test/acp/*.ts` (`Cannot find module
  '../../dist/acp/index.js'`, plus cascading `implicitly has an 'any' type`
  errors once that import fails to resolve a type). Zero errors anywhere
  else.
- `npm test` (`npm run build && node --test`): `test/acp/cancellation.test.ts`,
  `errors.test.ts`, `framing.test.ts`, `lifecycle.test.ts`, and
  `permissions.test.ts` each fail immediately with
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '.../dist/acp/index.js'`. `helpers.ts`, `mock-agent.ts`, `raw-agent.ts`,
  and `scenarios.ts` are reported as passing only because Node's test
  runner discovers them as files under `test/` and they happen to contain
  no failing `test()` calls of their own at the point where the import
  error would occur inside a real test body — they are not evidence the
  scaffold works, only that walking past the import doesn't currently
  throw at file scope in those particular files.

**This is a pre-existing gap, found and reported by this integration pass,
not one introduced or fixed by it.** Implementing an ACP client is a
substantial, separate piece of work — a JSON-RPC-over-stdio wire client
with session lifecycle, cancellation, and permission-request handling — and
is out of scope for `src/cli/`, `test/integration/`, `package.json`, and
`README.md`, the only paths this pass owns.

**Next concrete step:** implement `src/acp/index.ts` (and whatever internal
split it needs) against `docs/research/acp-protocol.md`, exporting at least
`connect()` and the `AcpClient`/`SessionUpdate`/`PermissionRequestHandler`
types `test/acp/helpers.ts` already imports, then run `npm test` again —
the five currently-failing files are that module's own regression suite
and should need no changes themselves if the implementation matches what
they were written against.

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
