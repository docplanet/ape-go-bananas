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
once (see `git notes show 2d5d0f4`).

## Claimed

| item | session | notes |
| --- | --- | --- |
| _(nothing claimed)_ | | |

## Unclaimed

| item | why it is open |
| --- | --- |
| `session/load` / `session/resume` | both agents advertise `loadSession: true`; the client implements neither. Real gap, bigger surface than the claimed items. |
| `agent/*` sidecar bridge (protocol §5) | the chat pane and the flag → adjudicator route both wait on it; the reverse `agent/requestPermission` needs an answer path in `sidecar.rs` |
| designed screens (Claude Design) over `app/src/{sidecar,preview,main}.ts` | the current layout is a placeholder by declaration (`docs/APP.md`) |
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
| ACP client — framing, transport, protocol, session, handlers | `9ae6874` |
| `authenticate` / `logout` / `terminalAuthLaunch` (§5) | `5771058` |
| `sessionCapabilities` fork/subagents, `Partial<Record>`, CAPS_PRESENCE (§4.4) | `160eabc` |
| `modes`, `setMode()`, `current_mode_update` (§17.1) | `f870fe6` |
| live smoke tests, mode matrix, doc corrections | `eafff8f` `9d38739` `4be0f7b` `da9f677` `be04242` |
| §17.2 `configOptions`, `setConfigOption()`, `config_option_update` | `21f7f87` |
| `!= null` read a literal `false` as supported — `isSupported()` + CAPS_LITERAL_FALSE | `25aa8aa` |
| all four independent-review findings (cwd, three regexes, explicit `null`, `authMethods`) | `7236a4e` |
| stdio sidecar (`src/sidecar`, protocol doc, 36-case oracle written blind) | _this commit_ |
| Tauri shell `app/`: Rust-owned sidecar, typed frontend surface, review-page preview with flags, placeholder layout | _this commit_ |

Only the `cwd` omission changed behaviour on the wire. The regex finding was
the most instructive: re-running the reviewer's mutation confirms the terminal
test now dies when the guard is deleted, where before only the zero-frame
assertion caught it — an assertion that matches the error message of the peer
you are testing against is not an assertion. `authMethods` is now validated
and frozen, and typed `readonly AuthMethod[]` so the guarantee is visible.

Recorded, not fixed: 160eabc's `Partial<Record<…>>` widening is unenforceable
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
