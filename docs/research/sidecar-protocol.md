# Sidecar protocol

The app's webview cannot run `node:sqlite` or spawn an agent. So the engine runs
as a Node child process — *the sidecar* — and the app talks to it over stdio.
This document is the contract. Tests under `test/sidecar/` are written from it,
by a context that has not seen `src/sidecar/`; implementers may not edit them.

## 1. Framing

JSON-RPC 2.0, newline-delimited UTF-8, one message per line — the same rules as
ACP §2 (`acp-protocol.md` #2 "Framing checklist"), and the sidecar reuses
`src/acp/framing.ts` rather than growing a second line reader.

- **stdin** carries app → sidecar messages. **stdout** carries sidecar → app
  messages and *nothing else*: every line on stdout is one complete JSON-RPC
  message. Diagnostics go to **stderr**, free-form.
- Two messages in one write, or one message split across writes, must both
  decode correctly (the decoder is byte-level, splitting on `0x0A` only).
- Request ids are echoed verbatim — a string id comes back as the same string,
  a number as the same number.

## 2. Lifecycle

Spawned as `node dist/sidecar/index.js` (also `package.json`'s
`ape-sidecar` bin). No argv, no env contract; `ANKI_MEDIA` is honoured the same
way the CLI honours it (`src/cli/media-dir.ts`).

1. The **first line on stdout** is the notification
   `sidecar/ready` with params `{ "engine": "ape", "version": <package.json
   version>, "node": process.versions.node, "pid": <number> }`. The app waits
   for it before sending anything.
2. Requests are handled **sequentially in arrival order**, and responses go
   out in that same order (every engine call is synchronous).
3. **EOF on stdin** → flush pending responses, exit `0`.
4. `sidecar/shutdown` request → respond `{}` → exit `0`.
5. A malformed line, an unknown method, or an engine error **never exits** the
   process; the next request is still answered.

## 3. Errors

Standard JSON-RPC codes, `message` always human-readable:

| code | when | id in the response |
| --- | --- | --- |
| `-32700` | line is not JSON, or JSON that is not a JSON-RPC message shape | `null` |
| `-32601` | unknown method (request) | the request's id |
| `-32602` | params missing, wrong type, or a required field absent — `message` names the field | the request's id |
| `-32000` | the engine threw: `message` is the thrown `Error`'s message verbatim (the same text the CLI prints on stderr for that failure), `data: { "name": <error class name> }` | the request's id |

Notifications with unknown methods are ignored silently. A notification whose
handling throws is also ignored (nothing to respond to).

## 4. Methods

Method names are namespaced with `/`, like ACP. `path` params are absolute or
cwd-relative filesystem paths, used as given (no `~` expansion).

### `sidecar/ping`
params: none or `{}` →
`{ "engine": "ape", "version": string, "node": string }`

### `media/dir`
params: none or `{}` →
`{ "mediaDir": string, "exists": boolean }` — `resolveMediaDir()` and whether it
is an existing directory.

### `deck/load`
params `{ "path": string }` →
`{ "notes": DeckNote[], "count": number }` via `loadDeckNotes` (contract §2's
three accepted shapes). Load failures are `-32000` with the loader's message.

### `deck/check`
params `{ "path": string, "transcriptPaths"?: string[], "inventoryPath"?:
string, "checkMedia"?: boolean, "mediaDir"?: string }` →
```
{ "result": CheckDeckResult, "report": string, "clean": boolean,
  "count": number, "mediaNote": string | null }
```
Semantics mirror `ape check` exactly (`src/cli/check.ts`):
- `mediaDir` defaults to `resolveMediaDir()`; `checkMedia` defaults to `true`;
  the effective media check is `checkMedia && <mediaDir exists>`.
- `mediaNote` is the CLI's stderr note text (`"note: <dir> not found - skipping
  the media check"`) when the check was wanted but the directory is absent,
  else `null`.
- transcripts are loaded one file at a time and concatenated in order.
- an `inventoryPath` whose file has no numbered rows → `-32000`
  `"<path>: no numbered fact rows found"`.
- a deck that parses but has zero notes → `-32000` `"<path> contains no notes"`.
- `report` is `formatCheckReport(result)` byte-for-byte; `clean` is
  `result.findings.length === 0`.

### `deck/review`
params `{ "path": string, "mediaDir"?: string, "outPath"?: string }` →
`{ "html": string, "count": number, "outPath": string | null }`
`renderReview(notes, { mediaDir })`. **Unlike the CLI, nothing is written unless
`outPath` is given** — the app owns display. When given, the file is written
(parent directories created) and echoed back.

### `deck/export`
params `{ "path": string, "outPath"?: string, "deckName"?: string,
"mediaDir"?: string }` →
`{ "outPath": string, "count": number, "unresolvedMedia": string[] }`
Defaults as `ape export`: `outPath` → `<stem>.apkg` beside `deck.json`;
`deckName` → `notes[0].deckName`; `mediaDir` → `resolveMediaDir()`. The apkg
module's own deck-name mismatch guard surfaces as `-32000`.

### `flags/read`
params `{ "path": string }` (the deck.json path) →
`{ "flags": Flag[], "flagsPath": string }` where `flagsPath` is `flags.json`
beside the deck and a missing file reads as `[]`.

### `flags/write`
params `{ "path": string, "flags": Flag[] }` → `{ "flagsPath": string, "count":
number }`. Replaces the file wholesale, pretty-printed JSON, trailing newline.

`Flag` is `{ "noteIndex": number, "note": string, "at": string }` — a
zero-based index into the deck's notes, the reviewer's free text, and an ISO
timestamp. The sidecar validates the shape (`-32602`) and stores it; it does
**not** interpret a flag. Routing a flag to an adjudicator is agent work.

### `sidecar/shutdown`
params: none → `{}`, then exit `0`.

## 5. Agents

`agents/*` and `agent/*` — provider install, sessions, streamed updates and
the reverse-direction `agent/requestPermission` request — are specified in
`agent-protocol.md`, which extends this document. Two rules here change for
those methods, and only those: handlers are asynchronous (a response leaves
when the work is done, so `agent/cancel` can land mid-turn), and the sidecar
may send requests of its own, answered by the app on stdin.

## 6. What the oracle must prove

For whoever writes `test/sidecar/` from this page without reading the code:

- ready line is the first stdout line, with the four fields, `version`
  matching `package.json`;
- every method's golden path against `test/fixtures/reference-cards.json`
  (7 notes; `deck/check` clean; `deck/export` reopened with `unzip` +
  `node:sqlite` shows 7 notes / 14 cards, the way `test/integration/
  pipeline.test.ts` already does);
- every error code in §3, and that the process survives each;
- string and number ids echoed; two requests in one write; one request split
  across two writes; a stray blank line ignored;
- stdout contains only JSON-RPC lines across a whole session;
- EOF → exit 0; `sidecar/shutdown` → `{}` then exit 0;
- `deck/review` writes nothing without `outPath` and writes exactly the
  returned html with it;
- `flags/write` then `flags/read` round-trips, and `flags/read` on a deck
  with no flags file returns `[]`.
