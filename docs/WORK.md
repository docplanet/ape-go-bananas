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
| §17.2 `configOptions` — surface it, `session/set_config_option`, `config_option_update` | ACP session | not advertising `clientCapabilities.session.configOptions.boolean`; boolean options surfaced defensively, never requested |
| `!= null` presence check reads a literal `false` as supported | ACP session | small fix + regression case |

## Unclaimed

| item | why it is open |
| --- | --- |
| `session/load` / `session/resume` | both agents advertise `loadSession: true`; the client implements neither. Real gap, bigger surface than the claimed items. |
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
