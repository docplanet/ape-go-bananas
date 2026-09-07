# The `.apkg` file format, pinned down for a from-scratch writer

Scope: enough to **write** a `.apkg` that current desktop Anki double-click-imports
correctly, for notes of the `Custom Cloze` note type (`Text` / `Extra` / `Source`,
`{{cloze:Text}}`). Not a general-purpose importer/exporter spec.

## Sources, in order of authority

1. **Four real `.apkg` files found on this machine**, opened and queried directly
   (`unzip -l`/`-v`, `sqlite3`, and Python's `sqlite3`/`hashlib` for byte-exact checks):
   - `~/Dev/Anki/backups/pre-push-20260706-123359/apkg/ISF-Week_1-Histology.apkg`,
     `ISF-Week_1-Biochemistry.apkg`, `Research_Design_and_Methods-Week_1.apkg` — all three
     are the **legacy pair** format and the Histology one contains real `Custom Cloze`
     notes from this exact pipeline (220 notes, 390 cards). This is the primary ground
     truth for everything below; every claim marked "(verified)" was read directly out
     of its `collection.anki21`.
   - A `Math.apkg` under a different session's uploads — the **newer zstd** format
     (`meta` + `collection.anki21b` + zstd-compressed numbered media). Used only to
     confirm what the *other* variant looks like on disk; not used as a template.
2. **`ankitects/anki` on GitHub, `main` branch, fetched today (2026-09-07)** — `rslib/src/`.
   File paths are given for every claim sourced this way so they can be re-fetched and
   re-checked. This is authoritative over the two items below wherever they'd conflict,
   per the task brief; in practice nothing below conflicts.
3. **The Anki manual's file-format pages** were not usable as a technical source — they
   document the `.colpkg`/`.apkg` menu commands for end users, not the on-disk shape.
   No manual page is cited below for that reason; everything technical came from (1) and (2).
4. **This machine's live Anki collection**, `~/Library/Application Support/Anki2/User 1/collection.anki2`,
   read only via a **copy** (`cp` to scratch, then opened `readOnly: true` with
   `node:sqlite`; original never touched). Its schema is `cards, col, config, deck_config,
   decks, fields, graves, notes, notetypes, revlog, tags` — the **current, normalized**
   in-app schema, not schema 11. This confirms schema 11 (below) is specifically an
   *export downgrade format*, distinct from what a running Anki keeps on disk day to day —
   useful to know so nobody tries to copy the live schema instead of this one.
5. **`anki/custom-cloze.json`, `anki/README.md`, `tools/check_deck.py`,
   `.claude/skills/anki-cards/SKILL.md`** in the engine repo — the note type and the
   `deck.json` payload shape this exporter has to consume.
6. Verified directly on this machine, on the pinned Node (`~/.nvm/versions/node/v24.12.0/bin/node`):
   `zlib.crc32()` exists and matches Python's `zlib.crc32` bit-for-bit
   (`crc32("hello world")` → `0xd4a1185` both ways), and `node:sqlite`'s `DatabaseSync`
   round-trips a raw `0x1F` byte inside a `TEXT` column via plain string concatenation
   (`"A" + "" + "B"` comes back as a 3-byte column, `length(flds)=3`). So the two
   trickiest low-level pieces — CRC32 for the zip, and the field separator byte — need no
   special handling in the exporter beyond calling `zlib.crc32()` and joining strings on
   `""`.

---

## 1. Which package variant to emit, and why

**Emit only `collection.anki21` (schema 11, plain SQLite) + `media` (JSON manifest) +
the numbered raw media files, in a standard deflate/store ZIP. No `meta` member. No
`collection.anki2`.**

Anki's package format has three variants, controlled by one proto enum
(`proto/anki/import_export.proto`, `PackageMetadata.Version`, fetched today):

```proto
message PackageMetadata {
  enum Version {
    VERSION_UNKNOWN = 0;
    // When `meta` missing, and collection.anki2 file present.
    VERSION_LEGACY_1 = 1;
    // When `meta` missing, and collection.anki21 file present.
    VERSION_LEGACY_2 = 2;
    // Implies MediaEntry media map, and zstd compression.
    // collection.21b file
    VERSION_LATEST = 3;
  }
  Version version = 1;
}
```

and the matching Rust (`rslib/src/import_export/package/meta.rs`):

```rust
impl VersionExt for Version {
    fn collection_filename(&self) -> &'static str {
        match self {
            Version::Unknown => unreachable!(),
            Version::Legacy1 => "collection.anki2",
            Version::Legacy2 => "collection.anki21",
            Version::Latest => "collection.anki21b",
        }
    }
    fn schema_version(&self) -> SchemaVersion {
        match self {
            Version::Unknown => unreachable!(),
            Version::Legacy1 | Version::Legacy2 => SchemaVersion::V11,
            Version::Latest => SchemaVersion::V18,
        }
    }
}
```

`VERSION_LATEST` is the modern format: `collection.anki21b`, **zstd**-compressed, the
collection re-encoded as protobuf `notetypes`/`decks`/etc. rather than JSON blobs in a
`col` row, and the media list is a zstd-compressed protobuf `MediaEntries` message with
per-file SHA1s, not a plain JSON map. It needs a zstd codec and a protobuf encoder —
neither is in scope (`node:zlib` does deflate/gzip/brotli, not zstd; there is no proto
compiler here). It buys nothing for this project's stated target ("current Anki, double
click, it imports") over the legacy path.

The legacy path is exactly the old, plain-SQLite `col`-row-with-JSON-blobs schema this
document reverse-engineers below (schema 11 — same name as the file this project asked
about, `rslib/src/storage/schema11.sql`), unchanged and still fully supported by every
current Anki release for import (`schema_version()` above still maps both legacy variants
to `SchemaVersion::V11` in the code fetched today, 2026-09-07). It needs nothing but a
plain SQLite writer and `deflate`.

That leaves a choice between `Legacy1` (`collection.anki2` only) and `Legacy2`
(`collection.anki21` only) — or, as real exporters do, both at once. The decisive fact is
in `Meta::from_archive`, the code path that runs when a package has **no `meta` member at
all** (`rslib/src/import_export/package/meta.rs`, fetched today):

```rust
let meta = if let Some(bytes) = meta_bytes {
    ...
} else {
    Meta {
        version: if archive.by_name("collection.anki21").is_ok() {
            Version::Legacy2
        } else {
            Version::Legacy1
        } as i32,
    }
};
```

A package with no `meta` file is *not* an error case — it's the documented shape of an
older-style export, and the importer picks `Legacy2` the moment `collection.anki21`
exists in the zip. So a zip containing exactly `collection.anki21` + `media` + numbered
media files, nothing else, is read by every current Anki exactly like a full legacy
export. The `collection.anki2` half of the traditional pair exists purely for Anki
clients that predate the `.anki21` filename (pre-2018-ish); the three real files found on
this machine each carry one anyway, and in every one of them it's a **throwaway
single-note stub** (verified: `collection.anki2` is 151552 bytes in all three regardless
of how many real notes are in the deck; `select count(*) from notes` on it returns `1` in
every case, vs. hundreds in the matching `.anki21`). Building that stub buys nothing for
"current Anki" and is one more SQLite file, one more bespoke JSON blob, for a client this
project doesn't need to support. Skip it.

**Also skip the `meta` member itself** — writing it correctly means hand-encoding a
protobuf message (trivial here, 2 bytes: tag `0x08` for field 1/varint, value `0x02` for
`VERSION_LEGACY_2`, per the enum above — but still one more thing to get exactly right
for zero benefit) when its *absence* already produces the exact same result through the
documented fallback quoted above. If a reviewer wants explicit-over-implicit, those 2
bytes are the whole `meta` file and this paragraph is the spec for it; the recommendation
is still to omit it.

**Compression per member** (matched to what all three real legacy files do, and to what's
simplest to implement): deflate the SQLite file and the `media` JSON (`zlib.deflateRawSync`,
ZIP method 8); **store** the numbered media files uncompressed (ZIP method 0) — they're
already-compressed image/audio formats in every real sample, and the zip reader
(`zip` crate on the Anki side) accepts either method per entry regardless, so this is a
size optimization, not a correctness requirement. Member order inside the zip does not
matter — Anki looks members up `by_name`, not by position.

Not independently verified this session: whether AnkiDroid/AnkiMobile's import path is
byte-for-byte the same `rslib` code fetched above (current AnkiDroid embeds the same Rust
backend as a library, so it almost certainly is, but this was not checked directly).
If mobile-client compatibility for very old app versions specifically becomes a concern
later, adding the throwaway `collection.anki2` back costs little and removes all doubt —
see the `col` schema below, which is identical for both files; the stub just needs a
single placeholder note/card so old readers don't show an empty/broken deck.

---

## 2. ZIP container

Plain ZIP, standard local-file-header / central-directory / end-of-central-directory
layout (PKZIP APPNOTE, unrelated to Anki specifically — noted here only because "write one
with core modules" means hand-rolling this part too). All multi-byte integers
little-endian.

Per entry, written in order: a **local file header**, then the (possibly deflated) data;
after all entries, one **central directory header** per entry, then one
**end-of-central-directory record**.

Local file header (30 bytes fixed + filename):
```
4 bytes  signature        0x04034b50
2 bytes  version needed   20  (2.0 — enough for deflate)
2 bytes  gp flag          0x0000  (no encryption, no UTF-8 flag needed — see below)
2 bytes  method           0 (store) or 8 (deflate)
2 bytes  mod time (DOS)   arbitrary, e.g. 0
2 bytes  mod date (DOS)   arbitrary, e.g. 0x21 (1980-01-01), nothing reads this
4 bytes  crc32            zlib.crc32(uncompressed_bytes)
4 bytes  compressed size
4 bytes  uncompressed size
2 bytes  filename length  n
2 bytes  extra field len  0
n bytes  filename         ASCII, e.g. "collection.anki21", "media", "0", "1", ...
```

Central directory header (46 bytes fixed + filename), one per entry, written after all
entries' data:
```
4 bytes  signature            0x02014b50
2 bytes  version made by      20
2 bytes  version needed       20
2 bytes  gp flag              0x0000
2 bytes  method               same as local header
2 bytes  mod time / date      same as local header
4 bytes  crc32                same as local header
4 bytes  compressed size
4 bytes  uncompressed size
2 bytes  filename length      n
2 bytes  extra field length   0
2 bytes  comment length       0
2 bytes  disk number start    0
2 bytes  internal attrs       0
4 bytes  external attrs       0
4 bytes  local header offset  byte offset of this entry's local header from file start
n bytes  filename
```

End of central directory record (22 bytes fixed):
```
4 bytes  signature                0x06054b50
2 bytes  disk number              0
2 bytes  disk with central dir    0
2 bytes  entries on this disk     count
2 bytes  total entries            count
4 bytes  central dir size (bytes)
4 bytes  central dir offset       byte offset where the central directory started
2 bytes  comment length           0
```

All our filenames (`collection.anki21`, `media`, and the numbered media filenames `0`,
`1`, …) are plain ASCII, so the UTF-8-filename general-purpose bit (bit 11) is never
needed for the zip *entry names* — non-ASCII **media filenames** live as text inside the
`media` JSON manifest and inside `flds`/`sfld` (normal UTF-8 string content), never as a
zip member name.

---

## 3. The `media` manifest

One JSON object per legacy package, mapping the numbered zip member name (as a string
key) to the real filename Anki should use in `collection.media` on import:

```json
{"0": "isf-histology-slide-01.jpg", "1": "isf-histology-slide-02.png"}
```

(verified — this is the literal, unmodified content of `media` inside
`ISF-Week_1-Histology.apkg`, truncated to two entries here.) Deflate-compress this JSON
text as the `media` zip member.

For each entry, write the raw bytes of the real media file, unmodified, as a zip member
whose **name is just the numeral** (`"0"`, `"1"`, …) — not the real filename. Numbering:
use a plain 0-based, contiguous counter across however many distinct media files the
deck's notes reference (matches every real sample; the import code parses the JSON key
with `usize::parse()` and does not require contiguity, but 0-based-contiguous is the
tested, conventional shape). Reading logic, for reference (`rslib/src/import_export/package/media.rs`,
fetched today): `SafeMediaEntry::from_legacy` parses map keys as `usize` and fetches
`archive.by_name(&index.to_string())`; `safe_normalized_file_name` (same file) validates
the target name and NFC-normalizes it, and re-maps a small set of Windows-reserved stems
(`CON`, `PRN`, …) to `CON_` etc. — this is the **importer's** job, not the exporter's; we
just write the filename the note actually references, as-is. Worth doing anyway on this
exporter's own side, cheaply: macOS's filesystem hands back filenames NFD-normalized, so a
media filename read from disk and compared byte-for-byte against the `<img src="...">`
text in a field (itself typically typed/pasted as NFC) can mismatch on accented
characters; normalize both to NFC (`String.prototype.normalize('NFC')` in JS) before
writing the `media` map and before matching field references to files on disk.

Only include a media file if some note actually references it via `<img src="...">` (or
audio/video) in `Text` or `Extra` — a referenced-but-missing media file is exactly the
failure mode `tools/check_deck.py`'s media check exists to catch upstream of this
exporter, so `deck.json` reaching this exporter should already be clean on that front.

---

## 4. SQLite schema — verbatim, byte-identical to primary source

Fetched today from `rslib/src/storage/schema11.sql`, and it is **character-for-character**
what `sqlite3 collection.anki21 ".schema"` printed against the real Histology file (down
to the comment above `sfld`) — full cross-check, no discrepancy:

```sql
CREATE TABLE col (
  id integer PRIMARY KEY,
  crt integer NOT NULL,
  mod integer NOT NULL,
  scm integer NOT NULL,
  ver integer NOT NULL,
  dty integer NOT NULL,
  usn integer NOT NULL,
  ls integer NOT NULL,
  conf text NOT NULL,
  models text NOT NULL,
  decks text NOT NULL,
  dconf text NOT NULL,
  tags text NOT NULL
);
CREATE TABLE notes (
  id integer PRIMARY KEY,
  guid text NOT NULL,
  mid integer NOT NULL,
  mod integer NOT NULL,
  usn integer NOT NULL,
  tags text NOT NULL,
  flds text NOT NULL,
  -- The use of type integer for sfld is deliberate, because it means that integer values in this
  -- field will sort numerically.
  sfld integer NOT NULL,
  csum integer NOT NULL,
  flags integer NOT NULL,
  data text NOT NULL
);
CREATE TABLE cards (
  id integer PRIMARY KEY,
  nid integer NOT NULL,
  did integer NOT NULL,
  ord integer NOT NULL,
  mod integer NOT NULL,
  usn integer NOT NULL,
  type integer NOT NULL,
  queue integer NOT NULL,
  due integer NOT NULL,
  ivl integer NOT NULL,
  factor integer NOT NULL,
  reps integer NOT NULL,
  lapses integer NOT NULL,
  left integer NOT NULL,
  odue integer NOT NULL,
  odid integer NOT NULL,
  flags integer NOT NULL,
  data text NOT NULL
);
CREATE TABLE revlog (
  id integer PRIMARY KEY,
  cid integer NOT NULL,
  usn integer NOT NULL,
  ease integer NOT NULL,
  ivl integer NOT NULL,
  lastIvl integer NOT NULL,
  factor integer NOT NULL,
  time integer NOT NULL,
  type integer NOT NULL
);
CREATE TABLE graves (
  usn integer NOT NULL,
  oid integer NOT NULL,
  type integer NOT NULL
);
-- syncing
CREATE INDEX ix_notes_usn ON notes (usn);
CREATE INDEX ix_cards_usn ON cards (usn);
CREATE INDEX ix_revlog_usn ON revlog (usn);
-- card spacing, etc
CREATE INDEX ix_cards_nid ON cards (nid);
-- scheduling and deck limiting
CREATE INDEX ix_cards_sched ON cards (did, queue, due);
-- revlog by card
CREATE INDEX ix_revlog_cid ON revlog (cid);
-- field uniqueness
CREATE INDEX ix_notes_csum ON notes (csum);
```

`sqlite_stat1`/`sqlite_stat4` also appear in a real Anki-written file, but those are
SQLite's own `ANALYZE` output — do not create them; a fresh `CREATE TABLE` set with no
`ANALYZE` run is a normal, valid SQLite file and Anki does not require those tables to be
present (their absence is the common case for any SQLite file that hasn't been analyzed).

`sfld`'s column type is declared `integer`, but real `sfld` values are almost always text
(see §6) — this is intentional, exploiting SQLite's type-affinity rules (a `TEXT` value
inserted into an `INTEGER`-affinity column is stored as `TEXT` unchanged; only a
numeric-*looking* string gets coerced to an integer for correct numeric sort, per the
schema comment). `node:sqlite` follows normal SQLite affinity rules, so no special
handling is needed — bind `sfld` as whatever value `strip_html_preserving_media_filenames`
produces (see §6) and SQLite does the right thing.

Do not create a `notetypes` table or any other table — `collection.anki2` in this
machine's *live* profile has one (current normalized schema: `cards, col, config,
deck_config, decks, fields, graves, notes, notetypes, revlog, tags`), but that is the
**live working schema**, a completely different, newer on-disk shape that Anki downgrades
*from* when writing this legacy export format. Schema 11 folds notetypes/decks/deck
options into JSON blobs on the single `col` row, per below — the extra tables from the
live schema have no place here and would just be ignored (or possibly confuse a version
check) if present.

---

## 5. The one `col` row

Exactly one row, `id = 1` always (`INSERT INTO col VALUES (1, ...)` is literally how the
schema file's own bootstrap constant reads).

| column | value | note |
|---|---|---|
| `id` | `1` | always |
| `crt` | epoch **seconds** | collection "creation" instant; only affects day-based review-due math, which brand-new (never-reviewed) cards never touch — see §7. Any reasonable value (e.g. "now") is safe here. Real value seen: `1575111600` (2019-11-30, i.e. long before this particular export — carried over collection history, not meaningful to a from-scratch write). |
| `mod` | epoch **milliseconds** | "now" at export time |
| `scm` | epoch **milliseconds** | "schema modified" time; "now" at export time is safe (real files show it within 100ms of `mod`) |
| `ver` | `11` | the schema-11 marker (verified) |
| `dty` | `0` | legacy/unused, always 0 (verified) |
| `usn` | `0` | col-level bookkeeping counter, unrelated to per-row `usn` below; `0` for a file that has never synced (verified) |
| `ls` | `0` | last-sync time, ms; `0` — never synced (verified) |
| `conf` | JSON object, see below |
| `models` | JSON object, see below |
| `decks` | JSON object, see below |
| `dconf` | JSON object, see below |
| `tags` | `"{}"` | a legacy tag-name registry cache. **Verified it does not need to be populated**: the real Histology collection has hundreds of tagged notes and `col.tags` is still literally `"{}"` (2 bytes). Always write `"{}"`. |

**Timestamp convention, stated once for the whole schema** (`rslib/src/timestamp.rs`,
fetched today): `TimestampSecs::now()` is `SystemTime::now() - UNIX_EPOCH` truncated to
whole seconds; `TimestampMillis::now()` is the same to whole milliseconds. `col.mod`/
`col.scm` are milliseconds; `col.crt` and every `mod` column in `notes`/`cards`/`revlog`
are **seconds**. Getting a `mod` column wrong by a factor of 1000 is an easy mistake here
and worth a deliberate unit test.

### 5a. `conf`

Real, working value (Histology file, verified), reformatted:

```json
{
  "curDeck": 1,
  "schedVer": 2,
  "collapseTime": 1200,
  "estTimes": true,
  "addToCur": true,
  "creationOffset": 240,
  "dayLearnFirst": false,
  "newSpread": 0,
  "sched2021": true,
  "nextPos": 1,
  "curModel": 1782926764114,
  "activeDecks": [1],
  "dueCounts": true,
  "timeLim": 0,
  "sortBackwards": false,
  "sortType": "noteFld"
}
```

`schedVer` **must be `2`** — confirmed from source, not inference: the apkg importer
hard-rejects the whole import with `AnkiError::SchedulerUpgradeRequired` if
`target_col.scheduler_info()?.version == SchedulerVersion::V1`
(`rslib/src/import_export/package/apkg/import/cards.rs`, fetched today). That check is
against the *destination* collection the user is importing into, not this file directly —
but since v1 scheduler was retired years ago and Anki auto-upgrades on open, this is a
non-issue for any real destination collection; write `schedVer: 2` regardless, since
that's what a real collection actually has and it costs nothing.

`nextPos` is the global "next new-card position" counter — see §7's `due` discussion; for
a from-scratch file, set it once at the end to (highest `due` value you assigned) + 1, so
a live Anki that imports this file and then lets the user add one more card by hand
doesn't immediately collide with a `due` value already used by an imported card. Not
required for correctness (Anki reconciles positions fine either way) but cheap and correct
to do. `curDeck`/`curModel`/`activeDecks` are UI-state conveniences for *this file's own*
temporary in-memory collection while Anki reads it during import, not something a
destination collection inherits — safe to point at whichever deck/model this export cares
about, or leave at the "Default" deck (`1`) / omit entirely if only one notetype exists.

### 5b. `decks`

Object keyed by **deck id as a string**. A `"Default"` deck with **id `1`** must exist —
this is not just convention, it's a hardcoded assumption in Anki's own card-generation
code: `rslib/src/notetype/cardgen.rs`, fetched today, `default_deck_conf()`:
```rust
fn default_deck_conf(&mut self) -> Result<(DeckId, DeckConfigId)> {
    // currently hard-coded to 1, we could create this as needed in the future
    self.deck_conf_if_normal(DeckId(1))?.or_invalid("invalid default deck")
}
```
Every real collection (the three legacy backups and the live profile alike) carries this
deck. Always include it, verbatim:

```json
"1": {
  "id": 1, "mod": 0, "name": "Default", "usn": 0,
  "lrnToday": [0, 0], "revToday": [0, 0], "newToday": [0, 0], "timeToday": [0, 0],
  "collapsed": true, "browserCollapsed": true, "desc": "", "dyn": 0, "conf": 1,
  "extendNew": 0, "extendRev": 0,
  "reviewLimit": null, "newLimit": null, "reviewLimitToday": null, "newLimitToday": null,
  "desiredRetention": null
}
```

Plus one entry per real deck this export creates, e.g.:

```json
"1782933359405": {
  "id": 1782933359405, "mod": 1783352780, "name": "ISF::Week 1::Histology", "usn": -1,
  "lrnToday": [0, 0], "revToday": [0, 0], "newToday": [0, 0], "timeToday": [0, 0],
  "collapsed": false, "browserCollapsed": false, "desc": "", "dyn": 0, "conf": 1,
  "extendNew": 0, "extendRev": 0,
  "reviewLimit": null, "newLimit": null, "reviewLimitToday": null, "newLimitToday": null,
  "desiredRetention": null
}
```

(verified — real deck object, ids/mod left as observed). `name` is the **full
`Course::Test N::Subject::Lecture`-style hierarchical string with literal `::` between
levels** — this is schema 11's own convention (unlike the modern live schema, which uses
an internal `\x1f`-joined "native" name and converts to/from `::` at the JSON boundary;
schema 11 just stores the `::` form directly, matching `deckName` in `deck.json` and
`anki-cards/SKILL.md`'s own naming rule exactly, byte for byte). `dyn: 0` marks a normal
(non-filtered) deck — always this, never anything else, for content this exporter writes.
`usn: -1` marks "created locally, not yet synced" — matches the real user-created deck
above (the untouched built-in `Default` deck, by contrast, sits at its original `usn: 0`).
`conf: 1` points at the one `dconf` group below; reuse it for every deck this export
creates rather than minting new option groups.

**Import-time behavior worth knowing** (`rslib/src/import_export/package/apkg/import/decks.rs`,
fetched today): decks are matched to the destination collection **by name**, not by id
(`get_deck_by_name`) — if the user already has a deck with this exact `::`-joined name, the
import **merges into it** and remaps this file's `did` values via a returned
`HashMap<DeckId, DeckId>`; only a brand-new name creates a new deck. So the numeric deck
id chosen here is not load-bearing for a re-import into the same collection — get the
*name* exactly right (case matters, `::`-hierarchy matters) and the id can be anything
internally consistent.

### 5c. `dconf`

One entry, id `1`, `"Default"`. Real value (verified), reused as-is — nothing here needs
customizing for freshly-generated new cards, since none of it affects an unreviewed card's
row shape:

```json
"1": {
  "id": 1, "mod": 0, "name": "Default", "usn": 0,
  "maxTaken": 60, "autoplay": true, "timer": 0, "replayq": true,
  "new": {"bury": false, "delays": [1.0, 10.0], "initialFactor": 2500, "ints": [1, 4, 0], "order": 1, "perDay": 20},
  "rev": {"bury": false, "ease4": 1.3, "ivlFct": 1.0, "maxIvl": 36500, "perDay": 200, "hardFactor": 1.2},
  "lapse": {"delays": [10.0], "leechAction": 1, "leechFails": 8, "minInt": 1, "mult": 0.0},
  "dyn": false, "newMix": 0, "newPerDayMinimum": 0, "interdayLearningMix": 0,
  "reviewOrder": 0, "newSortOrder": 0, "newGatherPriority": 0, "buryInterdayLearning": false,
  "fsrsWeights": [], "fsrsParams5": [], "fsrsParams6": [], "desiredRetention": 0.9,
  "ignoreRevlogsBeforeDate": "", "easyDaysPercentages": [1.0,1.0,1.0,1.0,1.0,1.0,1.0],
  "stopTimerOnAnswer": false, "secondsToShowQuestion": 0.0, "secondsToShowAnswer": 0.0,
  "questionAction": 0, "answerAction": 0, "waitForAudio": true, "sm2Retention": 0.9,
  "weightSearch": ""
}
```

Not independently re-derived key-by-key from a Rust struct this session (unlike
`models`/`flds`/`tmpls` below) — this is "known-good, taken verbatim from a real,
successfully-importing file" rather than "every key individually proven required." Given
it doesn't vary per note/card, copying it verbatim carries very low risk.

### 5d. `models`

Object keyed by **notetype id as a string**. Every key and its required/optional status
below is taken from the actual (de)serialization struct, `rslib/src/notetype/schema11.rs`,
fetched today — `#[serde(default, ...)]` marks a field optional-on-read (omit it and Anki
fills in the default shown); no such attribute means the JSON key is **required** or
deserialization fails outright.

Top level (`NotetypeSchema11`):

| key | required? | for `Custom Cloze` |
|---|---|---|
| `id` | required (numeric; a JSON string is also tolerated by the reader via a lenient helper, but write a bare number — that's what real Anki itself emits) | notetype id |
| `name` | required | `"Custom Cloze"` |
| `type` | required | `1` (cloze — `0` = standard; this is the field the task asked to "verify precisely": confirmed both from the real file and from `NotetypeKind` in source, `Standard = 0, Cloze = 1`) |
| `mod` | required | seconds |
| `usn` | required | `-1` for a from-scratch file |
| `sortf` | required | `0` (sort field = field index 0 = `Text`) |
| `did` | optional (`default_on_invalid`) | omit, or `null` |
| `tmpls` | required | array, one entry — see below |
| `flds` | required | array, three entries — see below |
| `css` | optional but obviously wanted | the CSS from `anki/custom-cloze.json`, verbatim |
| `latexPre` / `latexPost` | optional (`default` → `""`) | include the standard boilerplate anyway (harmless, matches every real file) |
| `latexsvg` | optional → `false` | `false` |
| `req` | optional → `[]` | **ignored entirely for a cloze notetype** — confirmed from source: card generation branches on notetype kind (`rslib/src/notetype/cardgen.rs`, `new_cards_required_cloze` vs `_normal`) and only the *normal*-notetype path ever reads `req`. Real cloze notetypes still carry the placeholder `[[0, "any", [0]]]` (verified — present, identical, on `Basic`, `Custom Basic`, *and* `Custom Cloze`), safe to reuse verbatim or omit. |
| `originalStockKind` | optional, `skip_serializing_if=is_default` | **omit** — present only on Anki's own built-in stock notetypes (verified: absent on both real `Custom Basic` and `Custom Cloze`, present as `1` on real `Basic`) |
| `originalId` | optional, `skip_serializing_if=is_default` | **omit** — this is written *by the importer*, not the exporter: `rslib/src/import_export/package/apkg/import/notes.rs`, fetched today, unconditionally does `notetype.config.original_id.replace(notetype.id.0)` to every incoming notetype before matching it against the destination, purely so a *second* import of the same package can recognize and reuse whatever id it got renamed to the first time. A fresh export has nothing to put here. |

`flds[]` entries (`NoteFieldSchema11`) — required keys have no `default` attribute in the
struct: `name`, `ord`, `sticky`, `rtl`, `font`, `size`. Everything else
(`description`, `plainText`, `collapsed`, `excludeFromSearch`, `id`, `tag`,
`preventDeletion`) is `#[serde(default, deserialize_with="default_on_invalid")]` —
optional, safe to omit. For `Custom Cloze` (verified real values, from a
`Custom Cloze` notetype live in the wild):

```json
{"name": "Text",   "ord": 0, "sticky": false, "rtl": false, "font": "Liberation Sans", "size": 20}
{"name": "Extra",  "ord": 1, "sticky": false, "rtl": false, "font": "Liberation Sans", "size": 20}
{"name": "Source", "ord": 2, "sticky": false, "rtl": false, "font": "Liberation Sans", "size": 20}
```

`tmpls[]` entries (`CardTemplateSchema11`) — required: `name`, `qfmt`. Optional-with-default:
`afmt`, `bqfmt`, `bafmt`, `did`, `bfont`, `bsize`, `id` (all default to `""`/`0`/`null`).
Write `afmt` anyway — it's the answer side, and an omitted `afmt` renders literally
nothing on the back of every card. One entry, from `anki/custom-cloze.json`:

```json
{
  "name": "Cloze",
  "ord": 0,
  "qfmt": "{{cloze:Text}}",
  "afmt": "{{cloze:Text}}{{#Extra}}<div class=\"extra\">{{Extra}}</div>{{/Extra}}{{#Source}}<div class=\"src\">{{Source}}</div>{{/Source}}"
}
```

(Real, live `Custom Cloze` notetypes in the wild carry a fancier `afmt` with a
show/hide-extra button — that's a later edit made in Anki's own note-type editor after
this project's `anki/custom-cloze.json` was first applied via AnkiConnect; it doesn't
change any of the above, it's just evidence the note type is user-editable after the fact
and this exporter should treat `anki/custom-cloze.json` as the source of truth, not any
one deployed copy of it.)

**Import-time behavior worth knowing** (`notes.rs`, fetched today): unlike decks,
notetypes are matched to the destination collection **by exact id** first
(`get_target_notetype`). If nothing in the destination shares this file's chosen model id,
the notetype is added fresh, deduplicated **by name** (`ensure_notetype_name_unique`) —
meaning if the destination *already* has an unrelated `"Custom Cloze"` (e.g. created
earlier by hand via the `anki/custom-cloze.json` AnkiConnect call this project's own
`README.md` documents, which will have picked a different, AnkiConnect-minted id this
offline exporter has no way to know), the import will add this file's notetype as a
*second*, disambiguated-by-name notetype (something like `"Custom Cloze 2026-09-07@..."`),
and every imported note will use that new one — the user's pre-existing `Custom Cloze` is
left untouched. This is standard Anki behavior for *any* apkg with an unrecognized
notetype id, not a defect in this exporter; there is no way for an offline file writer to
guess a live AnkiConnect session's notetype id. Worth surfacing to whoever writes the
exporter as an expected (if slightly untidy) outcome, not a bug to chase.

---

## 6. `notes`

One row per note in `deck.json`. Column by column:

| column | value |
|---|---|
| `id` | unique increasing id — see §8 |
| `guid` | opaque unique string — see below |
| `mid` | the model id from §5d |
| `mod` | epoch **seconds** |
| `usn` | `-1` |
| `tags` | space-joined, **one leading and one trailing space, always**, even for zero or one tags — verified exact byte content: `" isf::histology::methods::intro key::isf-week-1-histology::chapter-1::0 src::junqueira-ch1 week::01 "`. Build it as `" " + tags.join(" ") + " "`; for zero tags this is a single space `" "`, not `""` — not independently confirmed against a real zero-tag note this session (every real note sampled had tags), but it follows directly from the same join formula and is the documented AnkiConnect/Anki convention. |
| `flds` | every field's text, in the notetype's field order, joined with **exactly one `0x1F` byte** (`""` in JS) between each pair — never inside any field's own text (see "control characters," below). Verified byte-exact via direct SQLite read with Python (not through a terminal pipe — see the aside below on why that distinction mattered). |
| `sfld` | see algorithm below |
| `csum` | see algorithm below |
| `flags` | `0` |
| `data` | `""` (empty string — verified; contrast with `cards.data`, which is `"{}"` for a fresh card, not empty — easy to transpose by accident) |

**Aside on verifying `flds` — a real trap in this research.** Piping a raw `0x1F` byte
through `sqlite3 ... | xxd` and reading the tool output back **did not show `1f`** — it
showed the two printable characters `^_` (caret-notation for the control character,
inserted somewhere in the terminal-capture pipeline, not in the file). Reading the same
column with Python's `sqlite3` module directly, then checking `ord()` on each character,
confirmed the actual byte **is** `0x1F`, singular, both in the raw column bytes and via
`node:sqlite` (see the environment checks under "Sources," above). Moral for whoever reviews the eventual
exporter's output: verify binary content by reading bytes in-process, never by eyeballing
a terminal dump of them.

### `guid`

Anki's own generator (`rslib/src/notes/mod.rs`, fetched today) is a random 64-bit integer,
base-91 encoded, most-significant digit first:

```rust
pub(crate) fn base91_u64() -> String { anki_base91(rand::random()) }
fn anki_base91(n: u64) -> String {
    to_base_n(n, b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\
0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~")
}
// to_base_n: repeatedly take n % 91 as the next char (least-significant first),
// then reverse. n == 0 would produce an empty string (never happens in practice —
// a uniform random u64 is 0 with probability 2^-64).
```

That alphabet is the 94 printable ASCII characters `!`–`~` **minus** `"`, `'`, and `\` (94
− 3 = 91) — deliberately excludes characters that are awkward inside quoted
strings/HTML attributes. Matching this exactly is **not required for correctness**: notes
are matched against a destination collection purely by **guid string equality**
(`existing_guids = target_col.storage.note_guid_map()`, keyed by the literal guid string,
in `import/notes.rs`), and if this file's guid doesn't happen to match anything already
there, the note is simply added as new — with its numeric `id` silently bumped
(`+= 999`, repeatedly) if it collides with an id already in the destination
(`uniquify_note_id`, same file). So any short, unique-within-this-file opaque string is
sufficient; replicating the algorithm above just produces a value indistinguishable from
one Anki would have generated itself, which is a reasonable bar to hold given how cheap it
is (a 64-bit random number and a base-91 encode).

### `sfld` and `csum` — the exact algorithm, verified two ways

The task asked specifically to verify this precisely; it turned out to be subtly
different from "sha1 of the sort field" in the general case, though the two coincide for
this project's own notetype. From `rslib/src/notes/mod.rs::prepare_for_update`, fetched
today:

```rust
let field1_nohtml = strip_html_preserving_media_filenames(&self.fields()[0]);
let checksum = field_checksum(field1_nohtml.as_ref());
let sort_field = if nt.config.sort_field_idx == 0 {
    field1_nohtml
} else {
    strip_html_preserving_media_filenames(self.fields[nt.config.sort_field_idx])
};
```

```rust
pub(crate) fn field_checksum(text: &str) -> u32 {
    let mut hash = Sha1::new();
    hash.update(text);
    u32::from_be_bytes(hash.finalize()[..4].try_into().unwrap())
}
```

So: **`csum` is always computed from field index 0** (whatever the notetype's *first*
field is), never from the sort field, unless the sort field *is* field 0. **`sfld` is
computed from whichever field `sortf` names.** For `Custom Cloze`, `sortf = 0` and field 0
is `Text` — the two happen to be the same field and the same computation, which is why
the task's framing ("csum = first 8 hex chars of sha1 of the sort field") holds exactly
for this notetype, and is stated here as the general rule so it's implemented correctly if
this exporter is ever pointed at a notetype where they differ.

"First 8 hex chars of the sha1 hexdigest, read as a base-16 integer" and "first 4 raw
bytes of the sha1 digest, read as a big-endian `u32`" are the same value — a byte's 2 hex
characters are exactly its position in the hex string, and hex-string-to-integer parsing
is inherently most-significant-byte-first, same as `from_be_bytes`. **Verified by direct
computation**, not just by this argument: for a real note (`nid 1783048246516`),
`int(hashlib.sha1(sfld.encode()).hexdigest()[:8], 16) == 3949927921 == csum` read
straight out of the database — exact match.

The stripping function itself, also fetched today (`rslib/src/text.rs`), is two passes:

```rust
pub fn strip_html_preserving_media_filenames(html: &str) -> Cow<'_, str> {
    HTML_MEDIA_TAGS.replace_all(html, r" ${1}${2}${3} ").map_cow(strip_html)
}
pub fn strip_html(html: &str) -> Cow<'_, str> {
    strip_html_preserving_entities(html).map_cow(decode_entities)
}
pub fn strip_html_preserving_entities(html: &str) -> Cow<'_, str> {
    HTML.replace_all(html, "")   // comments, <style>...</style>, <script>...</script>, and any other <tag> — all removed with NO replacement, not even a space
}
pub fn decode_entities(html: &str) -> Cow<'_, str> {
    if html.contains('&') {
        htmlescape::decode_html(html).map(|t| t.replace('\u{a0}', " ")).unwrap_or(html.into())
    } else { html.into() }
}
```

Concretely, in order:
1. Any `<img|audio|video|object|source ... src="X"|data="X" ...>` tag → replaced by
   **`" X "`** (a literal space, the raw attribute value, a literal space) — the filename
   is *kept*, unlike every other tag. Confirmed by the function's own doc-test:
   `strip_html_preserving_media_filenames("<img src=foo.jpg>") == " foo.jpg "`.
2. Every remaining `<...>` tag (including HTML comments and the *contents* of
   `<style>`/`<script>` blocks) → removed with **nothing**, not a space. Verified against
   a real note: raw field `"...components:<br>1. {{c1::<i>cells</i>}}..."` →
   `sfld = "...components:1. {{c1::cells}}..."` — `<br>` and `<i>`/`</i>` vanish with zero
   characters left behind, `{{`/`::`/`}}` pass through untouched (they aren't HTML tags).
3. HTML-entity-decode what's left (`&amp;` → `&`, etc. — verified: raw `"...SER has..."`
   with `H&amp;E` → sfld `H&E`), then replace any literal U+00A0 (what `&nbsp;` decodes
   to) with a plain **U+0020 space** — verified at the codepoint level, not just visually:
   the character in a real decoded `sfld` sits at `0x20`, not `0xA0`.

`node:sqlite`'s column-affinity handling (§4) means the exporter can bind this resulting
string straight into `sfld` without extra coercion.

### Control characters in field text

`rslib/src/notes/mod.rs::normalize_field`, fetched today, strips every ASCII control
character *except* `\n` and `\t` from field text before it's ever joined/stored:
```rust
fn invalid_char_for_field(c: char) -> bool { c.is_ascii_control() && c != '\n' && c != '\t' }
```
`0x1F` (the field separator) is itself an ASCII control character, so this is precisely
what guarantees a field's own content can never contain a stray separator byte and corrupt
the join. Apply the same filter to each field's text before joining on `0x1F` — cheap
insurance the live Anki client relies on, and free to replicate since this exporter also
controls the text going in (LLM/pipeline-authored HTML, not free-form user typing, but a
stray control character reaching here from upstream is exactly the kind of thing worth not
trusting).

---

## 7. `cards`

One row **per distinct cloze number found in the note**, not one row per note. Every
column, for a **freshly generated, never-reviewed** card (the only kind this exporter ever
writes):

| column | value |
|---|---|
| `id` | unique increasing id — see §8 |
| `nid` | the note's id |
| `did` | the target deck's id, from §5b |
| `ord` | `clozeNumber - 1` — see below |
| `mod` | epoch **seconds** |
| `usn` | `-1` |
| `type` | `0` (new) |
| `queue` | `0` (new) |
| `due` | a small positive integer — **shared by every card generated from the same note** — see below |
| `ivl` | `0` |
| `factor` | `0` |
| `reps` | `0` |
| `lapses` | `0` |
| `left` | `0` |
| `odue` | `0` |
| `odid` | `0` |
| `flags` | `0` |
| `data` | `"{}"` — **not** empty string; verified on real never-reviewed cards |

(`type`/`queue` beyond `0` — `1`=learning, `2`=review, `3`=day-learn for `type`; negative
`queue` values mean suspended/buried — stated here for completeness from general Anki
knowledge, not independently re-verified against source this session, and irrelevant
regardless: every card this exporter writes is brand new and unreviewed, so it is always
exactly `type=0, queue=0`.)

### How many cards, and which `ord`, per note — the load-bearing rule

Confirmed straight from the card-generation code, `rslib/src/notetype/cardgen.rs`, fetched
today — this is the entire cloze branch:

```rust
fn new_cards_required_cloze(&self, note: &Note, extracted: &ExtractedCardInfo) -> Vec<CardToGenerate> {
    let set = cloze_number_in_fields(note.fields());   // HashSet<u16>, scans ALL of the note's fields
    set.into_iter().filter_map(|cloze_ord| {
        let card_ord = cloze_ord.saturating_sub(1).min(499);
        ...
        Some(CardToGenerate { ord: card_ord as u32, ... })
    }).collect()
}
```

So, precisely:
- **`ord = N - 1`** for every distinct cloze number `N` found — direct, no renumbering,
  no compaction. A note using only `{{c2::...}}` and `{{c3::...}}` (no `{{c1::...}}` at
  all) generates exactly two cards, at `ord = 1` and `ord = 2` — **not** `ord = 0, 1`.
  Gaps in the numbering are preserved as gaps in `ord`, not compacted. This project's own
  house style caps at three cloze numbers per note and always starts from `c1`
  (`.claude/skills/anki-cards/SKILL.md`: "One to three cloze numbers. Never four"), so in
  practice this exporter will only ever emit contiguous `ord = 0, 1[, 2]` — but the rule
  above is the actual mechanism, worth stating exactly rather than "however many distinct
  numbers, starting from 0."
- Anki caps cloze numbers at effectively 500 (`.min(499)`) — irrelevant here, noted for
  completeness.
- **`cloze_number_in_fields(note.fields())` scans every field of the note**, not just the
  one field the template renders (`{{cloze:Text}}` in this notetype's case) — a stray
  `{{c5::...}}`-shaped string sitting in `Extra` or `Source` would, per this source,
  generate a genuine (if visually broken) 5th card. `tools/check_deck.py`'s own cloze
  regex, by contrast, is only ever applied to `fields["Text"]`. In practice this divergence
  shouldn't bite — nothing in this pipeline's authored `Extra`/`Source` content looks like
  `{{cN::...}}` — but for exact bit-for-bit parity with what live Anki would generate from
  the same note, the safest implementation scans all three fields' concatenation for cloze
  numbers, not `Text` alone. Recommended: scan all fields; document the choice either way
  since it's a real (if narrow) behavioral fork.
- **The cloze syntax this exporter needs to parse is deliberately the narrower dialect
  `tools/check_deck.py` already uses and this pipeline's decks are actually written in** —
  single numeric ordinal per `{{cN::...}}`, value runs to the first literal `}}`, hint is
  whatever follows the first `::` inside that span. Real Anki's own parser
  (`rslib/src/cloze.rs`, fetched today) is a strict superset: it also accepts
  comma-separated ordinals sharing one deletion (`{{c1,2::shared text}}`) and genuine
  nesting (a cloze inside a cloze). Neither appears anywhere in this pipeline's authoring
  rules or its seven canonical reference cards, so implementing only the narrower dialect
  is a deliberate, documented scope decision, not an oversight — but it does mean this
  exporter is not a general-purpose Anki cloze parser, only one for decks shaped the way
  this project's own tools already require them to be shaped.

### `due` — a per-note counter, shared by every card from that note

Confirmed both empirically and from source. Empirically: every note sampled with more
than one card has **all of its cards at the identical `due` value** — e.g. note
`1783048246667`'s `ord=1` and `ord=2` cards are both `due=1810575`; a different note's
`ord=1`/`ord=2` pair is both `due=1810580`; consecutive *notes* step the value by
(usually) 1. From source, `rslib/src/notetype/cardgen.rs`, `due_for_deck`, fetched today:

```rust
if cache.next_position.is_none() {
    cache.next_position = Some(self.get_and_update_next_card_position().unwrap_or(0));
}
let next_pos = cache.next_position.unwrap();
```

— the counter is fetched and advanced **once per note** (cached for the rest of that
note's card-generation call) and every card generated for that note reuses the same
value. This is `conf.nextPos` (§5a): one counter, shared across the whole collection
(every deck, every notetype), incremented by exactly 1 per **note** added, regardless of
how many cards that note produces.

For this exporter: keep one running counter starting at `1` (or wherever `nextPos` should
resume from, for a from-scratch file `1` is fine), assign it as `due` to **every** card
generated for a given note, then increment by 1 before moving to the next note. Because
these are all `type=0`/`queue=0` cards, `due` here is a **position**, not a date — nothing
about day-offsets or the collection's `crt` applies to it (confirmed:
`rslib/src/import_export/package/apkg/import/cards.rs::shift_collection_relative_dates`
only adjusts `due` for `queue ∈ {Review, DayLearn}` or `type == Review` — never for new
cards — so a freshly-imported new card's `due` passes through completely unmodified
regardless of any date/timezone difference between the exporting and importing machines).

### Cards import-merge behavior, briefly

Not primarily relevant since this exporter targets a first-time import into whatever
collection the user has, but worth knowing: cards are matched to a destination by
`(note_id_in_destination, ord)` (`card_ordinal_already_exists`,
`import/cards.rs`) — i.e. only ever relevant once a note has already been matched by guid
(§6). A colliding numeric card id is silently bumped by `+= 999` just like notes
(`uniquify_card_id`), so — as with note/notetype ids — internal-to-this-file uniqueness is
what actually matters; the destination reconciles the rest.

---

## 8. IDs — the "unique increasing id" rule, and why exact collision-avoidance doesn't matter here

Every `id` column in this schema (`col.id` excepted, always `1`) is, in a real Anki
collection, `TimestampMillis::now()` — milliseconds since the Unix epoch — at the moment
the row was created, confirmed both from `rslib/src/timestamp.rs` (fetched today) and
directly from the sample data (e.g. note id `1783048246516` decodes to
2026-07-03T03:10:46.516Z, matching this collection's real edit history; deck/model ids
similarly decode to sensible creation dates).

**What matters for this exporter is only that ids are unique *within the file it writes*
and internally consistent** (every `notes.mid` names a real key in `models`; every
`cards.nid` names a real `notes.id`; every `cards.did` names a real key in `decks`) — not
that they resemble real wall-clock timestamps, and not that they avoid colliding with
whatever the destination collection already has. That's confirmed directly from the
import-merge code already cited in §5d/§6/§7: colliding **note** ids are silently
renumbered (`uniquify_note_id`, `+= 999` repeatedly), colliding **card** ids likewise
(`uniquify_card_id`), **decks** are reconciled by name rather than id at all, and
**notetypes** are reconciled by id-then-name with a documented duplicate-and-rename
fallback (§5d) — every one of these paths exists specifically to make a plain numeric-id
collision between an incoming package and the destination collection a non-event.

Practical recipe: seed a counter at `Date.now()` (milliseconds) when the exporter starts,
and hand out `counter++` for every id needed across every table (notes, cards, the one or
more decks, the one notetype) — trivially unique within the file, and looks exactly like
what a real Anki client would have written, which costs nothing extra to get right.

`mod` columns (seconds, §5/§6/§7) can all simply be "now" at export time; nothing in the
schema requires them to reflect any particular real editing history for a freshly
generated card.

---

## 9. Worked example: one cloze note → three card rows

Input (one note from `deck.json`, following `Custom Cloze`'s field order and this
pipeline's own authoring conventions):

```json
{
  "deckName": "ISF::Test 1::Histology::Cell Biology",
  "modelName": "Custom Cloze",
  "fields": {
    "Text": "The {{c1::<b>Golgi apparatus</b>::which organelle?}} <u>modifies and packages</u> {{c2::<i>proteins synthesized by the rough ER</i>::what?}}, and {{c3::<i>lipids</i>::what else?}} for secretion.",
    "Extra": "",
    "Source": "Slide 9"
  },
  "tags": ["isf::histology::cell-biology", "test::1", "fact::F14"]
}
```

Distinct cloze numbers found (scanning `Text`, `Extra`, `Source` — §7): `{1, 2, 3}` → three
cards, `ord = 0, 1, 2`.

`notes` row (one), with a placeholder id `N` and model id `M`:

| column | value |
|---|---|
| `id` | `N` |
| `guid` | e.g. `"Kv3=x9Qp{"` (opaque, unique within file) |
| `mid` | `M` |
| `mod` | export time, seconds |
| `usn` | `-1` |
| `tags` | `" isf::histology::cell-biology test::1 fact::F14 "` |
| `flds` | the three field values joined on the single byte `0x1F` (shown as `␟` below only for legibility — the real byte is `0x1F`, not this glyph) |

```
The {{c1::<b>Golgi apparatus</b>::which organelle?}} <u>modifies and packages</u> {{c2::<i>proteins synthesized by the rough ER</i>::what?}}, and {{c3::<i>lipids</i>::what else?}} for secretion.␟␟Slide 9
```

| column | value |
|---|---|
| `sfld` | field 0 (`Text`) with HTML stripped, cloze braces left intact (§6): `"The {{c1::Golgi apparatus::which organelle?}} modifies and packages {{c2::proteins synthesized by the rough ER::what?}}, and {{c3::lipids::what else?}} for secretion."` |
| `csum` | `61577224` — computed and cross-checked two ways (`int(sha1(sfld).hexdigest()[:8], 16)` and `struct.unpack(">I", sha1(sfld).digest()[:4])`), both give this same value |
| `flags` | `0` |
| `data` | `""` |

`cards` rows (three), with the note's shared `due = D` and deck id `DID`:

| id | nid | did | ord | type | queue | due | ivl | factor | reps | lapses | left | odue | odid | flags | data |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `N+1` | `N` | `DID` | `0` | `0` | `0` | `D` | `0` | `0` | `0` | `0` | `0` | `0` | `0` | `0` | `"{}"` |
| `N+2` | `N` | `DID` | `1` | `0` | `0` | `D` | `0` | `0` | `0` | `0` | `0` | `0` | `0` | `0` | `"{}"` |
| `N+3` | `N` | `DID` | `2` | `0` | `0` | `D` | `0` | `0` | `0` | `0` | `0` | `0` | `0` | `0` | `"{}"` |

All three cards share `due = D` (§7); only `ord` and `id` differ. This is the shape
`tools/check_deck.py`'s own ordinal parsing already implies — a note with cloze numbers
`{1,2,3}` "has three cards" in the sense the checker's counts/summaries assume, and this
is the exact database expression of that.

---

## 10. What `deck.json` looks like going in, for reference

Confirmed by reading `tools/check_deck.py` and `.claude/skills/anki-cards/SKILL.md`
directly (this is the contract the exporter needs to consume, not something this document
invents): `deck.json` is the literal AnkiConnect `addNotes` payload — accepted as a bare
list of notes, `{"notes": [...]}`, or `{"params": {"notes": [...]}}`
(`tools/check_deck.py::load`). Each note:

```json
{
  "deckName": "<Course>::Test N::<Subject>::<Lecture>",
  "modelName": "Custom Cloze",
  "fields": {"Text": "...", "Extra": "...", "Source": "Slide 12"},
  "tags": ["<course>::<subject>::<topic>", "test::N", "slide::<slug>-NN", "fact::F12"]
}
```

Media is **not** an inline field on the note — images are referenced as ordinary
`<img src="filename.jpg">` inside `Text`/`Extra`, and `tools/check_deck.py`'s own media
check assumes those files already exist by that exact name in a `collection.media`
directory (`ANKI_MEDIA` env var, defaulting to the live Anki profile's media folder). This
exporter's natural contract is the same shape: take a media directory alongside
`deck.json` (or the same `ANKI_MEDIA` convention) and, for every `<img src="X">` found
across all notes' `Text`/`Extra`, read `X` from that directory and embed it as a numbered
media file per §3 keyed by its real filename `X`. This project's own `check_deck.py`
having already validated that every referenced image exists is the natural place to
depend on that guarantee rather than re-validating it here.

---

## 11. Explicitly unverified or lower-confidence

- AnkiDroid/AnkiMobile's exact import code path for a `meta`-less, `.anki21`-only package
  — believed identical to desktop (current AnkiDroid embeds the same Rust backend) but not
  independently fetched/checked this session.
- `dconf`'s full key set was taken verbatim from a real working file, not individually
  proven required/optional key-by-key against a Rust struct the way `models`/`flds`/`tmpls`
  were. Low risk (copied as-is, known to import successfully), but flagged since the
  bar for the rest of this document was "read from source," and this one piece wasn't.
- `col.crt`'s precise intended semantics (day-cutoff-adjusted creation instant) are stated
  from general knowledge, not re-derived from source this session — irrelevant to
  correctness here since nothing this exporter writes is a day-based due date, but flagged
  as an assertion resting on background knowledge rather than a citation.
- The exact wire bytes for an explicit `meta` file (`0x08 0x02`) are derived correctly from
  the fetched `.proto` enum values and protobuf's varint-tag encoding rule, but were not
  round-tripped through an actual protobuf decoder this session — moot, since the
  recommendation in §1 is to omit `meta` entirely, where the fallback path *was* read
  directly out of the shipped source.
- Real zero-tag and single-tag notes were not found in the sample data to directly confirm
  the `" "` (lone space) / `" tag "` boundary cases for the `tags` column; the leading/
  trailing-space rule was confirmed on notes with 3–4 tags and is applied here by the same
  join formula, consistent with AnkiConnect's documented convention.
