# Handoff: building the app on top of this engine

Read this first, then `docs/STATUS.md`. Everything below is either a fact
established by running something, or a constraint with a reason attached.

## Where you are

- **This repo (`~/Dev/APE`)** is the engine: deck checks, an `.apkg` writer,
  an ACP client, and a CLI over them. It is finished and verified. You are
  building *on* it.
- **The method repo (`~/Dev/Anki`)** is a separate checkout. It holds the
  card-writing method as prose (`method/1-extract.md`, `2-organize.md`,
  `3-cards.md`, which are symlinks into `.claude/skills/`), the Python tools
  this repo ported, and **`APP.md` — the design document for what you are
  building.** Read `APP.md` before anything else. It is design-only and
  settled in discussion; it is not a wishlist.

Do not `cd` between them and rely on it sticking. Use absolute paths.

## Non-negotiables inherited from the method repo

1. **No code decides what a card says.** The method files stay prose and are
   the single source of truth. The app bundles them unmodified and reads
   them; improving the method must never mean rebuilding the app, and the
   app must never edit the method.
2. **The writer ratifies nothing.** A flagged card goes to a *fresh*
   adjudicator context that returns fix-or-approve; the writing context
   applies the verdict verbatim. In the harness this is discipline. In the
   app it has to be wiring.
3. **The seven reference cards are the fixture set.** `test/fixtures/
   reference-cards.json`. Any check the app grows must pass all seven before
   it is allowed to fail anything else.

## What already works, and its API

Build the UI against these. Do not reimplement or refactor them — all three
are verified against the real external system, not just against tests.

```ts
// checks — a faithful port of the Python, proven by differential test
checkDeck(notes, opts) -> findings + summary   // src/checks
renderReview(notes) -> HTML

// apkg — verified importing into a real Anki 26.5 collection
writeApkg(notes, { deckName, outPath, mediaDir, clock }) // src/apkg

// acp — verified against claude-agent-acp 0.75.1 and Gemini CLI 0.40.1
connect({ command, args, env, cwd, onPermissionRequest }) // src/acp
  -> client.newSession({ cwd }) -> session.prompt(input)  // async iterator
     session.setMode(id) / client.setConfigOption(k, v)
```

CLI: `ape check|review|export`. See the README.

## The one thing that will bite you

**An agent will not ask permission unless you pin the mode.** `session/new`
returns `modes.currentModeId` inherited from the host's own agent config. In
`auto` the agent decides for itself: it will write files without ever calling
your permission handler. Observed, not theorised — an early smoke test had a
file created unprompted with zero requests.

`setMode('default')` pins Manual and a real `session/request_permission` then
routes to your callback. Verified both ways: denial left the directory empty,
approval created the file.

So **APP.md's flag-and-approve model is viable only if the app pins the mode
explicitly.** Never assume a default, and never infer the mode from host
config — `acceptEdits` set through config comes back as `default`, while the
same value set through `setMode` is adopted. Config is advisory; `setMode` and
`setConfigOption` are authoritative. Read `currentModeId`; do not deduce it.

## Environment

- **Node 24 only** (`.nvmrc`). On Node 20 the test runner does not discover
  `.ts` files, so the suite reports `0 tests` and exits `0` — a false green. A
  `pretest` guard now refuses below 24. If it fires, fix your PATH, never the
  guard.
- **Zero runtime dependencies.** `node:sqlite`, `node:zlib`, `node:child_process`.
  Keep it that way in the engine. A UI layer will need a framework; that is a
  deliberate decision to make and record, not a default to drift into.
- Tests: `npm test`. Typecheck: `npm run typecheck`. Both must be clean.

## What is left in the engine

Small, and none of it blocks UI work:

- `session/load` / `session/resume` — the only real code gap. Both agents
  advertise `loadSession: true` and the client implements neither, so a host
  cannot reopen a session it created. APP.md's resumable runs need this.
- Gemini writes a bare non-JSON line to stdout, violating §2. Needs a
  behavioural decision — tolerate, or keep erroring.
- `.apkg` non-ASCII filename path is untested (the one media fixture is ASCII).
- Whether an AnkiConnect live tier belongs here at all — APP.md wants it as a
  detected upgrade over `.apkg`; nothing is built.

## How this repo was built, and why you should keep it that way

Tests are written **before** the implementation, by a different context than
the one that implements them, and implementers may not edit them. That is not
ceremony. Every serious bug here survived a green suite:

- The `.apkg` writer shipped rejected by Anki while 167 tests passed. Every
  test read the output back with `node:sqlite` and `unzip` — independent of
  the writer, but not of this repo's *reading of the format*. One consistent
  misreading satisfied all of them.
- `npm test` reported success while running zero tests.
- A presence check inverted all eight capability fields; no real agent
  triggered it, which is why it would have rotted.
- Deleting a spec-mandated guard left its `assert.rejects(/terminal/i)`
  **passing**, because the regex matched the mock's own error. Only the
  assertion counting frames on the wire caught it.

The lesson each time: an oracle that shares an author with the code, or
shares its assumptions, proves nothing. Where you can, verify against the
real external system — Anki's own deserializer, a real agent — not a mock.
`docs/STATUS.md` records which parts have an independent oracle and which
only have a self-authored one. Keep that table honest as you add to it.

## If more than one session works here at once

`docs/WORK.md` is the claims ledger. Claim by committing a row, never by
sending a message — messages are delivered between turns and are stale on
arrival. Stage explicit paths; `git add -A` in a two-writer repo sweeps the
other session's uncommitted work into your commit (it happened once — see
`git notes show 2d5d0f4`).

With a single session, ignore all of that.

## What to build

Per APP.md: a Tauri shell — one window, chat pane, file drop, stage rail,
preview pane. The pipeline as screens: extract → inventory review → organize
→ plan review → cards → deck preview → audit → deliver, with each artifact
written beside the user's course folder so a run resumes and a power user can
inspect.

**The card preview is the feature.** APP.md is explicit that the app's reason
to exist over "clone the repo and point an agent at it" is that every deck
this method produced was improved by an owner looking at rendered cards and
flagging what the pipeline missed. Build that loop first; it is the product.
