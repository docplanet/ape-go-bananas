# `check_deck.py` — exhaustive behavioral contract for the TypeScript port

Source: `tools/check_deck.py` (590 lines) in the Anki engine repo, as of the commit checked out at
`~/Dev/Anki/.claude/worktrees/codegraph-review-3c12f3`. Every line number below
refers to that file. This document is the differential-testing spec: a port is correct when it
produces byte-identical stdout/stderr and the same exit code as the Python original, for every
input the original can be run against, including the failure paths.

Companion source for the reference cards: `method/3-cards.md` in the Anki repo (the skill file
is a symlink to it).

**Amended 2026-09-11:** rule 10b (a hint that is a sentence, not a slot) was added to the original
and the port together, and ref-01's second hint changed from `what is it?` to `what?` in the
method — the old hint fails the method's own fluency test and was copied into thirty-two live
cards. Line numbers below still refer to the original as first contracted; the added rule is
marked where it lands.

Where the original's behavior is itself ambiguous, unspecified, or non-deterministic, that is
called out explicitly in **§11 Porting hazards** rather than papered over — a silent "reasonable"
choice there is exactly the kind of gap that passes every test until the one input that hits it.

---

## Table of contents

1. CLI surface
2. Input shapes accepted
3. Every regex, verbatim
4. Shape detection (prose / ref-06 / ref-07)
5. Every check — numbered rule table
6. The two claim-level checks, in full
7. Deck-wide reported numbers (never fail the run)
8. Media checking
9. Output ordering — the full stdout script, in order
10. The seven reference cards, verbatim
11. Porting hazards — exact cross-language semantics that must be replicated on purpose
12. Appendix: per-note check order inside `check()`

---

## 1. CLI surface

### 1.1 Invocation

```
python3 tools/check_deck.py [--no-media] [--transcript lecture.txt]... [--inventory inventory.md] deck.json
```

`argv[0]` is the interpreter's script name and is never inspected; parsing works on `argv[1:]`.

### 1.2 Flag parsing, in the exact order the original does it (lines 438–456)

1. **`--transcript PATH`** — repeatable. A `while "--transcript" in argv:` loop finds the flag's
   position with `argv.index(...)` (first remaining occurrence), appends the following token to
   `source_paths`, and removes **both** tokens from `argv`, then loops again. So `--transcript a.txt
   --transcript b.txt deck.json` collects `source_paths = ["a.txt", "b.txt"]`. There is no limit on
   repetitions. If `--transcript` is the last token (no following path), Python raises an
   uncaught `IndexError` (crash, not a clean usage error) — the original does not guard this.

2. **`--inventory PATH`** — **not** repeatable. A single `if "--inventory" in argv:` (not a `while`)
   takes only the **first** occurrence's position and removes that one `--inventory` + its argument.
   A second `--inventory` on the command line is *not* removed; it survives into the flag/positional
   split below, where it will be classified as an unrecognized flag and produce the usage error
   (exit 2), and its following path token will be counted as an extra positional argument (also
   pushing towards the usage error). Net effect: passing `--inventory` twice always fails with the
   usage message, never silently keeps the first or the second value. Same trailing-token crash
   risk as `--transcript` if `--inventory` is the last token.

3. After the above two flags (and their arguments) are stripped from `argv`, what remains is split:
   - `args = [a for a in argv[1:] if not a.startswith("-")]` — positional arguments: any token not
     starting with `-`.
   - `flags = {a for a in argv[1:] if a.startswith("-")}` — a **set** of every token starting with
     `-`.
   - Validation: `if len(args) != 1 or flags - {"--no-media"}:` — fails (usage error, see below)
     unless there is **exactly one** positional argument **and** the flags set contains nothing
     other than `--no-media`. `--no-media` itself is optional (its absence is fine); its presence
     alongside any other stray `-`-prefixed token still fails. **`--no-media` is the only
     zero-argument boolean flag.**
   - A deck path that itself starts with `-` (e.g. `-weird.json`) is misclassified as a flag and
     trips the usage error — an original-behavior quirk, not something to "fix" in the port.

4. **Usage error** (both conditions in §1.2.3 combined): print to **stderr**, exactly:

   ```
   usage: check_deck.py [--no-media] [--transcript lecture.txt] [--inventory inventory.md] deck.json
   ```

   (This is built from two adjacent Python string literals with no space lost or added at the
   join — the text above is the exact single-line result.) Then **return exit code 2**.

### 1.3 `ANKI_MEDIA` and the media-directory default (module level, lines 34–37 — evaluated once, at import time, *before* argv is parsed at all)

```python
DEFAULT_MEDIA = os.path.expanduser("~/Library/Application Support/Anki2/User 1/collection.media")
if not os.path.isdir(DEFAULT_MEDIA):                       # Linux / non-default profile
    DEFAULT_MEDIA = os.path.expanduser("~/.local/share/Anki2/User 1/collection.media")
MEDIA_DIR = os.environ.get("ANKI_MEDIA", DEFAULT_MEDIA)
```

- The macOS-style path is tried **first regardless of the actual host OS** — this is a filesystem
  existence check, not a platform check. If it exists as a directory, it is used even on Linux; if
  it does not exist (e.g. no "User 1" profile), the Linux-style path is substituted, even on macOS.
- `ANKI_MEDIA`, if set in the environment, **completely overrides** this default logic. Its value is
  used **verbatim** — it is *not* passed through `expanduser`, so a literal `~` in `ANKI_MEDIA` is
  never expanded, and its existence is never checked at this point (unlike the two hard-coded
  defaults, which are existence-tested against each other).
- `MEDIA_DIR` is a single module-level constant used unchanged for the rest of the run.

### 1.4 Media-check enablement and its own stderr note (lines 458–460)

```python
check_media = "--no-media" not in flags and os.path.isdir(MEDIA_DIR)
if not check_media and "--no-media" not in flags:
    print(f"note: {MEDIA_DIR} not found - skipping the media check", file=sys.stderr)
```

- `check_media` is computed **once** for the whole run and passed unchanged into every per-note
  `check()` call.
- The stderr note fires only when media checking is off **because the directory is missing**, never
  when it is off because `--no-media` was explicitly passed (in that case, no note — silence).
- Note the literal " - " (space-hyphen-space) rather than an em dash in this message.

### 1.5 Exit codes — complete enumeration

| Code | When | Where the message goes |
|---|---|---|
| 2 | Usage error: wrong positional-arg count, or an unrecognized `-`-flag present | stderr, `usage: check_deck.py ...` (§1.2.4) |
| 2 | `load(args[0])` returned an empty list (valid JSON, valid shape, just zero notes) | stderr, `f"{args[0]} contains no notes"` |
| 1 | Any `raise SystemExit(f"...")` fires (see §1.6) — file I/O errors, malformed JSON, malformed deck shape, missing inventory rows | stderr, the exact message string (see §1.6), **no traceback** — Python's runtime prints a `SystemExit` string argument to stderr with no "Traceback" header and exits 1 |
| 1 | The run completed normally and `findings` (the per-note problem list) is non-empty | stdout, the full report (§9) ending with `PROBLEMS:` and each finding |
| 0 | The run completed normally and `findings` is empty | stdout, the full report (§9) ending with `clean` |

**Exit code 1 is overloaded**: it means both "a fatal load/parse error occurred" (message on
stderr, nothing else printed) and "the deck has findings" (full report on stdout, `PROBLEMS:` at
the end). These are distinguished only by which stream carries output and by the message shape —
never by the exit code alone. A differential harness must compare stdout and stderr separately.

### 1.6 Every `SystemExit` message, verbatim (all exit code 1)

From `load()` (lines 417–432):

| Trigger | Message |
|---|---|
| `open(path)` raises `OSError` (file missing, unreadable, etc.) | `f"cannot read {path}: {error}"` |
| `json.load(handle)` raises `json.JSONDecodeError` | `f"{path} is not valid JSON: {error}"` |
| After dict-unwrapping (§2), the result is not a `list` | `f"{path}: expected a list of notes"` |
| Some element (1-indexed `position`) is not a `dict`, or has no `"Text"` key inside its `fields` | `f"{path}: note {position} has no fields.Text"` |

From `main()` directly (lines 462–478):

| Trigger | Message |
|---|---|
| `load_transcript(path)` raises `OSError` for a `--transcript` path | `f"cannot read {path}: {error}"` |
| `load_inventory(inventory_path)` raises `OSError` | `f"cannot read {inventory_path}: {error}"` |
| `load_inventory` succeeded but returned an empty dict (no qualifying rows) | `f"{inventory_path}: no numbered fact rows found"` |

`{error}` is Python's/the OS's own exception text (e.g. `[Errno 2] No such file or directory:
'deck.json'`, or a `json.JSONDecodeError`'s own message with line/column). **This text is
implementation-specific and cannot be byte-reproduced by a different language's runtime.** The
contract for these four rows is the *template*, the *trigger*, and *exit 1 / stderr* — not the
embedded system message. See §11 for the recommended treatment in differential tests.

### 1.7 stdout vs stderr — summary

**Only stderr ever receives:** the usage message, the "media dir not found" note, the "contains no
notes" message, and any `SystemExit` message. **Everything else — the entire report described in
§9 — goes to stdout**, including on a run that ends with exit code 1 because `findings` is
non-empty (that is a normal, non-error completion from the process's point of view; only stream
routing and the presence of `PROBLEMS:` mark it).

---

## 2. Input shapes accepted

`load(path)` (lines 417–432) accepts exactly three JSON top-level shapes:

1. **A bare list** of note objects: `[ {...}, {...} ]`.
2. **`{"notes": [...]}`** — a dict whose `"notes"` key holds the list.
3. **An AnkiConnect payload**: `{"action": "...", "version": 6, "params": {"notes": [...]}}` — a
   dict whose `"params"` key holds a dict which itself has the `"notes"` key.

The unwrapping is exactly:

```python
if isinstance(data, dict):
    data = data.get("params", data).get("notes", [])
```

- If the top-level value is a dict **without** a `"params"` key, `.get("params", data)` falls back
  to `data` itself, then `.get("notes", [])` reads `"notes"` off the **original** top-level dict —
  this is shape 2. Absence of a `"notes"` key here yields `[]` (which will then be reported as "no
  notes", not a shape error).
- If the top-level value is a dict **with** a `"params"` key, that key's value is used, then
  `.get("notes", [])` is read from *it* — shape 3. If `data["params"]` is present but is **not**
  itself a dict (e.g. a string or list), this line raises an **uncaught `AttributeError`** — a
  crash with a Python traceback, not a controlled `SystemExit`. The original does not guard this.
- If the top-level JSON value is a bare list, `isinstance(data, dict)` is false and it is used
  unchanged — shape 1.
- If the top-level value is neither a dict nor (after unwrapping) a list — e.g. top-level JSON is a
  number, string, bool, or null, or `params`/`notes` unwrapped to a non-list — the final
  `isinstance(data, list)` check fails and raises `SystemExit(f"{path}: expected a list of notes")`.

After unwrapping to a list, **every** element (1-indexed) must be a `dict` with a `"Text"` key
present inside `note.get("fields", {})`, else `SystemExit(f"{path}: note {position} has no
fields.Text")`. This check only verifies **key presence**, not that the value is a non-null
string — see §11 for the crash this permits later.

No other field is validated at load time. `Extra`, `Source`, `tags` are all optional and are
defaulted individually by the functions that read them (see §5, §6, §11).

`open(path)` in `load()` uses **no explicit encoding** (unlike `load_transcript`/`load_inventory`,
which both pass `encoding="utf-8", errors="replace"`) — it relies on the Python process's locale
default. A port should simply always read `deck.json` as UTF-8; every real invocation already
depends on that being true.

---

## 3. Every regex, verbatim

All patterns below are given as their exact Python `re` source string. Flags are noted explicitly;
absence of a note means no flags. `re.search`/`re.match`/`re.finditer`/`re.findall`/`re.sub`
distinctions matter and are called out per use — they are not interchangeable.

### 3.1 Module-level compiled patterns

**`CLAUSE_HINT`** (added 2026-09-11, directly after `CLOZE`)
```
^(?:what|which|who|where|when|why|how)\b[\s\S]*\b(?:is|are|was|were|do|does|did|happen|happens|happened)\b
```
Compiled with `re.I`. A hint that opens with a question word and carries its own verb anywhere
after it: `what is it?`, `what happens?`, `which is it?`, `where does it go?`. Slot-shaped hints
never match: `what?`, `does what?` (opens with the verb, not a question word), `which two?`,
`raise or lower?`, `why?`, `what joins what?` (no listed verb). Used once, via `.search(hint)` on
the raw hint (trailing `?` included). Hints are ASCII English, so Python's Unicode `\b`/`\w` and
JS's ASCII ones agree; the port uses the same pattern with the `i` flag.

**`CLOZE`** (line 40)
```
\{\{c(\d+)::((?:(?!\}\})[\s\S])*)\}\}
```
Matches `{{cN::BODY}}`. Group 1 = the digit string `N` (leading zeros preserved verbatim if
present in the source text — see §11). Group 2 = `BODY`, built one character at a time via a
negative lookahead that forbids the upcoming two characters from being `}}` — so the match
**stops at the very first `}}`** it encounters. This is deliberate: it is what makes it impossible
for one cloze's body to swallow a neighboring cloze's closing braces ("a cloze can never straddle
into the next one" — source comment, line 39). `[\s\S]` is the standard Python idiom for "any
character including newline" (since bare `.` excludes newline without `re.S`). Used exclusively
via `.finditer()` (never `.search`/`.match`), so every non-overlapping occurrence in a field is
found, left to right.

**`IMAGE_TAG`** (line 41)
```
<img\b[^>]*>
```
Matches one `<img ...>` opening tag: literal `<img`, a word boundary (so `<imgx>` would not
qualify as this tag name), then any run of non-`>` characters, then a literal `>`. It does not
distinguish self-closing (`/>`) from bare (`>`) tags — both end the match at the first `>`. Used
via `.findall()` (collect every occurrence in a field) and `.search()` (does this one value/tag
string contain an image at all).

**`IMAGE_SRC`** (line 42)
```
<img\b[^>]*\bsrc=["']([^"']+)["']
```
Same tag opening, but additionally requires a `src="..."` or `src='...'` attribute and captures its
value (group 1). Note precisely: `\b` before `src` only requires a transition between a "word" and
"non-word" character — a hyphenated attribute like `data-src="x"` **also** satisfies `\bsrc=`
(the `-`→`s` transition is itself a word boundary), so in principle a `data-src` attribute
appearing before a real `src` in the same tag could be matched instead, depending on how the
greedy `[^>]*` backtracks. This never arises in practice (Anki `<img>` tags do not carry a
`data-src`), but is worth knowing exactly if a future card format introduces one. Used via
`.search()` on one already-extracted `<img ...>` tag string at a time (not on the whole field).

**`LINK_ZOOM`** (line 44)
```
[?&]z=([\d.]+)
```
A `z=` query parameter preceded by `?` or `&`, capturing digits and/or literal dots — it does not
validate that the captured text is a well-formed single-decimal number (`1.2.3` would be captured
whole). Used via `.search()` on the **raw** (non-normalized) `Extra` field — the **first**
occurrence only.

**`MAGNIFICATION`** (line 45)
```
\b(\d+)x\b
```
A run of digits immediately followed by a lowercase `x`, both sides word-bounded — matches `50x`,
not `50X` (case-sensitive: no `re.I`), not `450xa`. Used via `.findall()` on the raw `Extra` field,
returning every occurrence (as digit-string captures).

**`SOURCE_LABEL`** (line 53), flags `re.S`
```
source:\s*(.*)
```
Literal lowercase `source:` (the text it runs against has already been lowercased by `normalize()`
— see §3.2), then optional whitespace, then **everything remaining in the string**, captured
greedily to the end (`re.S`/DOTALL makes `.` also match newline, though by this point
`normalize()` has already collapsed all whitespace runs to single spaces, so this is mostly
defensive). Used via `.search()` — finds the **first** `source:` occurrence anywhere in the
normalized text; if the word "source:" recurs later in the same field, it becomes part of the
captured group, not a second match.

**`QUOTE_GAP`** (line 57)
```
\.\.\.|…|\[[^\]]*\]
```
Three literal periods, **or** the single Unicode ellipsis character U+2026, **or** a
square-bracketed span (non-greedy is unnecessary — `[^\]]*` already stops at the first `]`). Used
via `.split()` to break a quote into the pieces on either side of an omission/insertion.

**`TIMESTAMP`** (line 92)
```
^\d{1,2}:\d{2}(:\d{2})?[.,]?\d*\s*-->
```
Anchored at the start of a (per-line, already-stripped) string. 1–2 digits, `:`, 2 digits, an
*optional* `:SS` group, an *optional* single `.`/`,`, then **zero or more** digits, optional
whitespace, then literal `-->`. Because both the fractional-second separator and its digits are
optional, even a bare `MM:SS -->` (no fraction at all) matches. This single pattern is written to
match **both** WebVTT cue lines (`00:00:03.580 --> 00:00:04.340`) and SRT-with-milliseconds-dropped
lines from a plain-text Zoom export — "matching only one of those shapes leaves the other's
scaffolding in the word stream" (lines 89–91). Used via `.match()` (prefix match; text after `-->`
is irrelevant and unchecked).

**`CUE_INDEX`** (line 93)
```
^\d+$
```
The **entire** (stripped) line is nothing but digits — a WebVTT/SRT numeric cue-index line.

**`SPEAKER`** (line 94)
```
^[^:]{1,40}:\s
```
From the start of a line: 1–40 non-colon characters, a literal colon, one whitespace character.
The 40-character cap is deliberate: it lets a short "Speaker Name: " prefix match while refusing to
treat a colon that appears deep inside a sentence as a speaker label. It is applied only to lines
from a file that has already been confirmed to be an actual transcript (see §6.2) — "the same
pattern run over a handout eats any 'Note: ...' or 'Answer: ...' label" (lines 122–124).

### 3.2 Inline (not pre-compiled) patterns, by function

**`words(text)`** (line 98)
```
[a-z0-9&]+
```
via `.findall()`. Extracts maximal runs of lowercase ASCII letters, digits, and `&`. **Assumes the
input is already lowercased** — it is only ever called on text that has already passed through
`normalize()` (or is itself the output of `normalize()`-derived splitting), so this assumption
always holds at every call site in the original.

**`normalize(text)`** (lines 101–106) — the single shared text-cleaning pipeline, used by every
claim-level and inventory check:
```python
text = html.unescape(re.sub(r"<[^>]+>", " ", text)).lower()
for fancy, plain in (("’", "'"), ("‘", "'"), ("“", '"'),
                     ("”", '"'), ("—", "-"), ("–", "-")):
    text = text.replace(fancy, plain)
return re.sub(r"\s+", " ", text)
```
In exact order:
1. `<[^>]+>` → a single space (`" "`), for **every** tag occurrence — this is a tag-strip that
   inserts a separator, preventing `<i>foo</i><i>bar</i>` from becoming `foobar`.
2. `html.unescape(...)` on the **whole** tag-stripped string — decodes named entities (`&amp;`,
   `&ldquo;`, `&rdquo;`, `&mdash;`, …) and numeric entities (`&#8217;`, `&#x2019;`, …) to their
   Unicode characters.
3. `.lower()` — full-string lowercase.
4. Six literal, ordered character replacements folding "fancy" Unicode punctuation to ASCII:
   `’`→`'`, `‘`→`'`, `“`→`"`, `”`→`"`, `—`→`-`, `–`→`-` (right/left single quote, right/left double
   quote, em dash, en dash). Order is immaterial since the six source characters are disjoint.
5. `\s+` → a single space, collapsing **every** run of whitespace anywhere in the string —
   including a leading or trailing run, which becomes a single leading/trailing space rather than
   being trimmed away. `normalize()` does **not** call `.strip()`.

**`load_transcript` timestamp/cue filtering** — already covered under `TIMESTAMP`/`CUE_INDEX`/
`SPEAKER` above; see §6.2 for the full function.

**In `unbacked()` and elsewhere, the cloze-flattening idiom** (lines 242–243, reused at 368 and
492):
```python
CLOZE.sub(lambda m: m.group(2).partition("::")[0], text)
```
Replaces every `{{cN::BODY}}` with just the **value** portion of `BODY` (splitting on the first
`::` inside the body and keeping only what precedes it — i.e. dropping the hint, keeping the role
tags). This is how "the rendered face with hints removed" is computed for word-extraction and for
the two-bold-run check.

**In `check()`, the possessive check** (lines 357–359):
```python
bare = re.sub(r"<b>[\s\S]*?</b>", " ", text)         # non-greedy — each <b>…</b> span individually
bare = html.unescape(bare).replace("’", "'")          # only the right single quote is folded here
if re.search(r"\w's\s", bare):
```
`<b>[\s\S]*?</b>` is **non-greedy**, so multiple `<b>...</b>` spans are each removed individually
(never from the first `<b>` to the last `</b>` across the whole string). The quote-folding here is
narrower than `normalize()`'s: **only** `’` (U+2019) is replaced, not `‘` (U+2018) — because a
possessive apostrophe is conventionally the right-single-quote glyph. `\w's\s` requires a **word
character**, then a literal apostrophe, then `s`, then a **trailing whitespace character** — a
possessive at the very end of the field (immediately followed by `.` or nothing, not a space) is
**not** matched by this pattern. This check runs only when `shape == "prose"`, and only on `bare`
— i.e. text with every `<b>...</b>` span already blanked to a space, so a bolded eponym like
`<b>Wharton's</b>` never trips it (the rule text explicitly calls this out: "Eponyms (Wharton's
jelly) live inside `<b>`").

**The role-tag-wraps-cloze check** (line 351):
```
<[biu]>[^<]*\{\{c\d
```
A role-tag open (`<b>`, `<i>`, or `<u>` — exactly these three single-letter tags, nothing else)
immediately followed, across only non-`<` characters (i.e. no other tag boundary in between), by a
cloze opening `{{c` + a digit. This is how "a role tag wraps a cloze" is detected — the forbidden
`<b>{{c1::...` nesting, as opposed to the required `{{c1::<b>...` nesting.

**The two-bold-runs (single-subject) check** (lines 368–374):
```python
flat = CLOZE.sub(lambda m: m.group(2).partition("::")[0], text)
bolds = list(re.finditer(r"<b>(?:(?!</b>)[\s\S])*</b>", flat))
for left, right in zip(bolds, bolds[1:]):
    gap = flat[left.end():right.start()]
    if re.sub(r"&nbsp;|\s", "", gap):
        problems.append(...)
        break
```
`<b>(?:(?!</b>)[\s\S])*</b>` is the same "stop at the first closing delimiter" technique as
`CLOZE`, applied to bold runs on the **flattened** (hint-stripped) text. Every **consecutive pair**
of bold runs is checked (`zip(bolds, bolds[1:])` — pairs (0,1), (1,2), (2,3), …, not just the first
two), and the text strictly between them (`gap`) is stripped of the literal, **still-HTML-encoded**
substring `&nbsp;` and of any whitespace; if anything is left, that gap is real prose separating two
different subjects, and the check fires and **stops at the first offending pair** (`break` — later
pairs are never reported even if also bad). Two bold runs separated by *only* whitespace/`&nbsp;`
(the legal ref-05-style split-subject case, once the cloze braces around one half have been
flattened away) never fire this check.

**The inline-series check's guard and per-item count** (lines 381, 385):
```
(?m)^\s*\d\.                                   — guard, searched against the FULLY tag-stripped Text
<[^>]+>  → ""  (empty string, not a space) then .count(",")   — per cloze value
```
The guard is evaluated against `re.sub(r"<[^>]+>", "", text)` — tags removed to the **empty**
string (not a space, unlike `normalize()`), and the `(?m)` flag makes `^` match at the start of the
string and immediately after any literal `\n`. Because `<br>` is one of the tags stripped to
nothing, it does **not** introduce a line break for this purpose — a card written with
`<br>1. item one<br>2. item two` contains no literal `\n` anywhere, so the multiline anchor here
only ever matches at the true start of the (tag-stripped) string. In practice this guard only
exempts a card whose text, once every tag is deleted, **begins** with an optional run of whitespace
then a digit and a period. It is not the mechanism that exempts ref-05 itself from the series
check — ref-05 is exempt because no single cloze *value* in it contains four commas (see next
paragraph and §5, rule 15) — but it is written to guard against a numbered list being
misidentified as an inline series in general, and a port must reproduce the empty-string
tag-strip exactly (not a space) since that changes what counts as "line start."

Per-cloze: `re.sub(r"<[^>]+>", "", value).count(",")` — tags stripped to empty string, then a plain
comma count on **one cloze's value at a time** (not across multiple same-numbered spans). Four or
more commas (five or more items) fails; this only ever inspects a single `{{cN::...}}` occurrence's
own text.

**The ref-07 front/answer construction** (lines 407–412):
```python
trailing = text[text.rfind("}}") + 2:]
front = IMAGE_TAG.sub(" ", text[:text.find("{{")]) + " " + trailing
front = re.sub(r"<[^>]+>", " ", front).lower()                 # space-replace here
for word in re.sub(r"<[^>]+>", "", answer).lower().split():    # EMPTY-replace here — asymmetric
```
`front`'s tag-strip replaces with a **space** (preventing adjacent tags from fusing two words);
`answer`'s tag-strip replaces with the **empty string**. This asymmetry is intentional-by-omission
in the original (not documented, just how it's written) and must be reproduced exactly — see §5
rule 20 and §11.

### 3.3 Fact/inventory-related patterns

**`FACT_TAG`** (line 201)
```
^fact::(F\d+)$
```
Full-string match (anchored both ends) against one tag at a time: literal `fact::`, then a
**capital** `F` (case-sensitive — `fact::f12` does not match), then one or more digits.

**`INVENTORY_ROW`** (line 209), flags `re.M`
```
^\|\s*(\d+)\s*\|(.*)$
```
One markdown-table row per line: `|`, optional whitespace, a number (captured), optional
whitespace, `|`, then the **rest of that line** captured to end-of-line (`.` does not match
newline here — no `re.S`). Used via `.findall()`, returning every matching line in the file as
`(number_string, rest_of_line_string)`.

**The slide-tag pattern** (defined locally inside `main()`, line 575)
```
slide::.+-(\d+)$
```
Used via `.match()` (implicitly anchored at position 0; the trailing `$` anchors the end too, so
this must match the **entire** tag string). `.+` is greedy, so with ordinary backtracking it
captures the digits after the **last** hyphen in the tag (e.g. `slide::ct-14-03` → captured group
`"03"`, converted with `int(...)` → `3`; a hypothetical `slide::ct-14-3-07` → `"07"` → `7`). Leading
zeros in the captured digits are **not** preserved in the printed report — see §7.

---

## 4. Shape detection

`shape_of(text)` (lines 275–281) — the **entire** algorithm:

```python
def shape_of(text):
    stripped = text.lstrip()
    if stripped.startswith("{{c1::<img"):
        return "ref-06"
    if stripped.startswith("<img"):
        return "ref-07"
    return "prose"
```

- `text.lstrip()` strips **leading** whitespace only (Python's default whitespace set, which is
  broader than ASCII space/tab/newline — see §11). The text is **not** right-stripped and **not**
  otherwise normalized: this check is case-sensitive and markup-literal.
- **ref-06**: the left-stripped text starts with the exact 10-character literal `{{c1::<img`. This
  is hard-coded to cloze number **1** specifically — a card whose image cloze is numbered `c2` (or
  any number other than `1`) is **not** detected as ref-06 by this test, and falls through. This is
  an exact, load-bearing detail: shape detection does not generalize the "c1" to "any digit."
- **ref-07**: else, if the left-stripped text starts with the exact 4-character literal `<img`
  (there is no follow-up boundary check — this is a plain prefix test, not a tag-shaped regex).
- **prose**: else (includes ref-01 through ref-05, and any note that starts with neither pattern,
  including the never-detected "c2-numbered image at the front" case above, and any note whose
  image is not at the very front of the field at all).

This one function is the sole determinant of shape for every shape-dependent check in §5.

---

## 5. Every check — numbered rule table

### 5.0 Shared per-note computation, before any check runs (lines 286–295)

```python
fields = note["fields"]
text = fields["Text"]
extra = fields.get("Extra", "") or ""              # None and missing both fold to ""
shape = shape_of(text)
spans = clozes(text)                                # [(number_str, value_str, hint_str_or_None), ...]
numbers = sorted({n for n, _, _ in spans}, key=int)  # UNIQUE cloze-number strings, numeric sort,
                                                      # original string form preserved (leading
                                                      # zeros, if any, survive)
if not spans:
    return ["no cloze at all"]
```

`clozes(text)` (lines 61–68): for every `CLOZE` match, `match.group(2).partition("::")` splits the
captured body on its **first** `::` — everything before is `value`, everything after (if a `::`
was found at all) is `hint`; if no `::` is present in the body, `hint` is `None` (not `""`). A
value that legitimately contains a literal `::` (e.g. a ratio written `3::1`) is **silently
truncated** at that point by this same partition — this is the original's behavior, not a bug to
route around in the port.

`numbers` is the **set of distinct cloze numbers**, not a count of cloze *occurrences* — a ref-05
list with five same-numbered `{{c2::...}}` items and one `{{c1::...}}` subject yields
`numbers == ["1", "2"]` (length 2), not 6.

**Rule 0 — no cloze at all.** Trigger: `spans` is empty (no `CLOZE` match anywhere in `Text`).
Message: exactly `"no cloze at all"`. Shapes: all (this check runs before shape is even
consulted for any decision, though `shape_of` has already been *computed*, just unused on this
path). This is a **short-circuiting return** — when it fires, it is the *only* entry in the
returned problem list; none of the other 22 checks below run for that note.

### 5.1 The numbered rule table

Every row after rule 0 is an `problems.append(...)` (or, for rules 21–22, a value folded in via
`problems += broken` from `unbacked()`). Rows are listed in the **exact order the original code
executes them** — this order is what a differential test's per-note message ordering must match
(see §9 and the Appendix for how this interacts with note-level ordering).

| # | Name | Trigger (exact condition) | Message (exact, with placeholders) | Shapes | Loop/emit behavior |
|---|------|---------------------------|-------------------------------------|--------|---------------------|
| 1 | No `src` on an `<img>` | For `field` in `("Text", "Extra")`, for every `<img...>` tag found by `IMAGE_TAG.findall`, `IMAGE_SRC.search(tag)` finds no match | `f"an <img> with no src in {field}"` | all | One message per offending tag; not gated by `--no-media` |
| 2 | Media file missing | Same loop; `source` matched, and `check_media` is true, and `os.path.exists(os.path.join(MEDIA_DIR, source.group(1)))` is false | `f"media missing from the collection: {source.group(1)} (in {field})"` | all | One message per offending `<img>`; entirely suppressed when `check_media` is false (§8) |
| 3 | Magnification worn as zoom | `zoom_worn_as_magnification(extra)` yields ≥1 claim (see §6.1) | `f"states {claim}: a slideview z is a zoom percentage, not an objective"` where `claim` is itself the pre-formatted string `f"{N}x vs z={Z}"` from §6.1 | all | One message per qualifying claim (usually 0 or 1; see §11 for the multi-claim non-determinism caveat) |
| 4 | Quoted text not in transcript | `transcript is not None` **and** `"transcript" in fields.get("Source", "").lower()` (the short `Source` field, not `Extra` — see §6.2), then `unsourced_quote_fragments(extra, transcript)` yields ≥1 fragment | `f"quoted text is not in the transcript: {fragment!r}"` | all | One message per missing fragment (see §6.2) |
| 5a | No `fact::` tag | `inventory is not None`; `unbacked()`'s `cited` list is empty | `"carries no fact:: tag; a card face is bound to an extracted fact"` | all | Exactly one message (early return inside `unbacked`), appended via `problems += broken` |
| 5b | Cited fact not in inventory | `inventory is not None`; `cited` non-empty but some cited id is not a key of `inventory` | `f"cites {f}, which is not in the inventory"` for each such `f` | all | One message per unknown id (in citation order), via `problems += broken` |
| 6 | Image cloze carries a hint | Looping `spans`; this cloze's `value` contains an `<img>` (`IMAGE_TAG.search(value)` truthy) **and** `hint` is truthy | `"the image cloze carries a hint; it should have none"` | all (in practice only ref-06's `c1`) | After this, `continue` — no other per-cloze check (7–9) runs for this span |
| 7 | No role tag on a non-image cloze | Same loop, `is_image` false; `not re.search(r"<[biu]>", value)` | `f"c{number} has no role tag on {value[:40]!r}"` | all | `value` is the raw (untrimmed-of-tags) cloze value, first 40 chars, Python `repr()` |
| 8 | Cloze carries no hint | Same loop; `hint is None` **and not** (this cloze number has >1 span **and** the *first* span with this number has a truthy hint) | `f"c{number} carries no hint"` | all | The parenthetical is the ref-05 shared-hint exemption — see §5.2 |
| 9 | Hint doesn't end in `?` | `hint is not None` and `not hint.endswith("?")` | `f"c{number} hint does not end in '?': {hint!r}"` | all | `elif` sibling of rule 10 — only one of 9/10 can fire per cloze |
| 10 | Hint not 1–3 words | `hint is not None`, hint *does* end in `?`, and (`"," in hint` **or** `len(hint.rstrip("?").split()) > 3`) | `f"c{number} hint is not one to three words: {hint!r}"` | all | `.rstrip("?")` strips **all** trailing `?` chars, not just one; `.split()` is whitespace-run split |
| 10b | Hint is a sentence, not a slot (added 2026-09-11) | `hint is not None`, ends in `?`, rule 10 did not fire, and `CLAUSE_HINT.search(hint)` matches | `f"c{number} hint is a sentence, not a slot: {hint!r}"` | all | Third `elif` in the 9/10 chain — at most one of 9/10/10b fires per cloze |
| 11 | Too many distinct cloze numbers | `len(numbers) > 3` | `f"{len(numbers)} cloze numbers; never more than three"` | all | Counts **distinct numbers**, not spans (see §5.0) |
| 12 | Text after the final cloze | `tail` (below) is non-empty after `.strip()` | `f"text after the final cloze: {tail[:48]!r}"` | all | `tail = html.unescape(re.sub(r"<[^>]+>", "", text[text.rfind("}}") + 2:])).strip()` — tags stripped to **empty string**, then entities decoded, then trimmed; first 48 chars of the result, `repr()`'d |
| 13 | Role tag wraps a cloze | `re.search(r"<[biu]>[^<]*\{\{c\d", text)` | `"a role tag wraps a cloze; the tag must sit directly on the text"` | all | |
| 14 | Possessive outside the subject | `shape == "prose"` and, on `bare` (§3.2), `re.search(r"\w's\s", bare)` | `"a possessive outside the subject; step 2 handed the wrong entity"` | prose only | |
| 15 | Second `<b>` run splits the subject | `shape == "prose"`; among consecutive pairs of bold runs on the flattened text, some pair's gap has non-whitespace/non-`&nbsp;` content (§3.2) | `f"a second <b> run split from the subject by {gap.strip()[:24]!r}; one subject, one name"` (built from two adjacent literals — no extra/missing space at the join) | prose only | Stops at the **first** offending pair (`break`) — later pairs never separately reported |
| 16 | Inline series ≥5 items | `shape == "prose"` and the numbered-list guard (§3.2) does not exempt the text; then, over `spans` (skipping any whose value contains an `<img>`), the **first** cloze value with `.count(",") >= 4` | `f"a {item_commas + 1}-item series inline; ref-05 list form"` | prose only | Stops at the **first** offending cloze (`break`); exactly 4 commas is only counted elsewhere (never failed — see §11) |
| 17a | No `<b>` on a prose card | `shape == "prose"` and `"<b>" not in text` | `"no <b> subject on a card that is not a recognition card"` | prose only | Plain substring test, not regex |
| 17b | `<b>` present on a recognition card | `shape != "prose"` and `"<b>" in text` | `"a recognition card must carry no <b>; this one does"` | ref-06, ref-07 | Plain substring test |
| 18 | ref-06 wrong cloze numbers | `shape == "ref-06"` and `numbers != ["1", "2"]` (exact list-of-strings equality) | `f"image is clozed (ref-06) so expect c1 and c2, found {numbers}"` | ref-06 only | `{numbers}` interpolates Python's **list repr**: e.g. `['1', '3']` — brackets, single-quoted elements, comma-space separated. Must be reproduced literally, see §11 |
| 19 | ref-07 wrong cloze numbers | `shape == "ref-07"` and `numbers != ["1"]` | `f"image is visible (ref-07) so expect c1 alone, found {numbers}"` | ref-07 only | Same list-repr requirement |
| 20 | Answer word visible on the front | `shape == "ref-07"`; for each word (len > 3) in the tag-**empty**-stripped, lowercased, whitespace-split `answer` text, that word is a raw substring of the tag-**space**-stripped, lowercased `front` text (§3.2 / §5.3) | `f"the answer word {word!r} is visible on the front"` | ref-07 only | **Does not break** — every leaking word in the answer produces its own separate message, in the order the words appear in `answer` |

### 5.2 Rule 8's shared-hint exemption, spelled out

```python
shared = [(v, h) for n, v, h in spans if n == number]
if hint is None and not (len(shared) > 1 and shared[0][1]):
    problems.append(f"c{number} carries no hint")
```

`shared` is recomputed per span, gathering **every** span (anywhere in `spans`, including this one)
with the same cloze number. `shared[0]` is the first such span in **text order** (left to right —
`spans` preserves `CLOZE.finditer`'s scan order). A hintless span is exempted from rule 8 only if
(a) its number is shared by more than one span **and** (b) the very first span with that number
does carry a hint. This is exactly the ref-05 pattern: item 1 (`{{c2::<i>resting cartilage</i>
::which?}}`) carries the hint; items 2–5 (`{{c2::<i>proliferating cartilage</i>}}`, etc., no `::`
at all) are exempted because they share `c2` with an item-1 that has one. If item 1 *also* lacked a
hint, every item sharing that number — including item 1 — would independently fail rule 8, since
the exemption test is evaluated once per span and item 1's own `hint is None` would also trip it.

### 5.3 Rule 20's front/answer construction, spelled out

```python
answer = next((v for n, v, _ in spans if n == "1"), "")   # first span numbered "1"; "" if none
trailing = text[text.rfind("}}") + 2:]
front = IMAGE_TAG.sub(" ", text[:text.find("{{")]) + " " + trailing
front = re.sub(r"<[^>]+>", " ", front).lower()
for word in re.sub(r"<[^>]+>", "", answer).lower().split():
    if len(word) > 3 and word in front:
        problems.append(f"the answer word {word!r} is visible on the front")
```

- `text[:text.find("{{")]` — everything before the **first** literal `{{` in the whole field
  (for a well-formed ref-07 card this is the image tag plus any lead-in prose); its `<img>` tags are
  replaced with a single space (so the image itself cannot contribute characters, but its removal
  doesn't fuse neighboring words).
- `trailing` — everything after the **last** `}}` in the whole field (same slice used for rule 12's
  "text after the final cloze," here reused rather than re-derived).
- `front` = (image-stripped lead-in) + `" "` + `trailing`, then **all** remaining tags replaced
  with a space and the whole thing lowercased.
- The **answer**'s tag-strip uses the empty string (not a space) — this is a deliberate asymmetry
  with `front`'s space-based strip; see §11 for why a port must not "fix" this inconsistency.
- Only answer words longer than 3 characters are checked (so "is," "the," "of," "and," etc. never
  trigger this even if trivially present), and the test is a **raw substring** containment check
  (`word in front`), not word-boundary-aware — a 4+ letter answer word that happens to be a
  substring of some longer word already visible on the front would still be flagged.
- This loop reports **every** qualifying leaking word, not just the first.

---

## 6. The two claim-level checks, in full

### 6.1 Magnification worn as slide-zoom (`zoom_worn_as_magnification`, lines 71–86)

```python
def zoom_worn_as_magnification(extra):
    zoom = LINK_ZOOM.search(extra)
    if not zoom:
        return []
    stated = float(zoom.group(1))
    tolerance = max(1.0, 0.02 * stated)
    return [f"{claim}x vs z={zoom.group(1)}" for claim in set(MAGNIFICATION.findall(extra))
            if abs(float(claim) - stated) <= tolerance]
```

- Operates on the **raw** `Extra` field — not normalized, not lowercased (which is why
  `MAGNIFICATION`'s lowercase-only `x` matters: an uppercase `50X` in Extra is invisible to this
  check).
- `zoom = LINK_ZOOM.search(extra)`: the **first** `?z=` or `&z=` occurrence anywhere in Extra (a
  virtual-slide-viewer URL's own zoom-percentage parameter). If none, the function returns `[]`
  immediately — no claim can be "worn as" a zoom if there is no zoom link to compare against at
  all.
- `stated = float(zoom.group(1))` — the zoom value as a float (e.g. `50.0`, `74.286`).
- `tolerance = max(1.0, 0.02 * stated)` — the **larger** of a flat 1.0 or 2% of the stated zoom.
  This exists because "the claim is the zoom rounded to something tidy" (line 82) — `z=74.286` gets
  written up as "75x," `z=19.475` as "20x."
- `MAGNIFICATION.findall(extra)` — every `NNx`-shaped substring in the raw Extra field, as digit
  strings, then de-duplicated via `set(...)`. **This set's iteration order is not deterministic
  across Python process runs** (string hash randomization) — see §11. In the overwhelmingly common
  case of a card with exactly one magnification-looking number in Extra, this is moot.
- For each **distinct** claim within `tolerance` of `stated`, the returned string is
  `f"{claim}x vs z={zoom.group(1)}"` — note this reuses `zoom.group(1)` **verbatim** (the original
  captured digit/dot text from the URL, e.g. `"74.286"`, not rounded or reformatted) for the `z=`
  half, while `claim` is likewise the raw digit string from `MAGNIFICATION` (e.g. `"75"`, no
  decimal point possible since `\d+` only matches digits).
- Each such string is what rule 3 (§5.1) wraps as `f"states {claim}: a slideview z is a zoom
  percentage, not an objective"` — i.e. the final message embeds the **whole** `"75x vs z=74.286"`
  string as `{claim}` in that outer f-string. (Note the name-shadowing: rule 3's own local loop
  variable is also called `claim`, but it iterates over the **already-fully-formatted strings**
  returned by this function, not over bare numbers.)

### 6.2 `Source:` quote vs. transcript (`--transcript`)

This check has three layers: a **field-level gate** (which field decides whether to run the check
at all), a **quote extractor** (which text is the quote), and a **fuzzy in-order word matcher**
(what counts as "found").

**Gate** (line 312, inside `check()`):
```python
if transcript is not None and "transcript" in fields.get("Source", "").lower():
```
This inspects the **short** `Source` **field** on the note (e.g. `"Slide 12"`, `"Notes"`,
`"Lecture transcript"`) — **not** the `Extra` field. Only if that field's lowercased text contains
the substring `"transcript"` does the check run at all. `fields.get("Source", "")` has **no** `or
""` guard (unlike `Extra` elsewhere) — if `Source` is present in the JSON with value `null`,
`.get` returns `None` (the key exists), and `.lower()` on `None` raises an uncaught
`AttributeError` — a hard crash, not a graceful skip. See §11.

**Loading the transcript** (`load_transcript`, lines 109–127): reads the file as UTF-8 with
`errors="replace"`, splits on Python's universal-newline rules (`str.splitlines()` — broader than
`\n`/`\r\n`; also splits on `\v`, `\f`, `\x1c`–`\x1e`, ` `, ` `; see §11), then:
- Drops any line that, once stripped, is empty, is exactly `"WEBVTT"`, matches `TIMESTAMP`, or
  matches `CUE_INDEX`.
- `is_transcript = any(TIMESTAMP.match(...) for ... in the ORIGINAL unfiltered lines)` — true if
  the file contains at least one cue-timing line anywhere; this is a file-level flag, computed once.
- Only if `is_transcript` is true does each kept line get `SPEAKER.sub("", line)` applied (stripping
  a leading `Name: ` prefix); otherwise every kept line is passed through unchanged — this protects
  a non-VTT source (e.g. a plain-text handout also passed via `--transcript`, since "a card's
  Source quote may come from the lecture or from the handout," line 436) from having a `Label: `
  prefix mistaken for a speaker tag.
- All surviving lines are joined with a single space, then `normalize()`d, then `words()`-tokenized
  into a flat list — this flat word list is `transcript`. **Multiple `--transcript` paths are
  concatenated** (`transcript += load_transcript(path)` per path, in the order given on the command
  line) into one combined word list before any note is checked (lines 462–469).

**Extracting the quote** (`source_quote`, lines 155–170), operating on the **`Extra`** field:
```python
label = SOURCE_LABEL.search(normalize(extra))
if not label: return None
rest = label.group(1).lstrip()
if not rest or rest[0] not in OPEN_QUOTE:   # OPEN_QUOTE = "\"'"  (straight double or single quote)
    return None
closing = rest.rfind(rest[0])
return rest[1:closing] if closing > 0 else rest[1:]
```
- Whole `Extra` field is normalized first (tags→space, entities decoded, lowercased, curly
  quotes/dashes folded to ASCII, whitespace collapsed) — so this works identically whether the
  original markup was `<b>Source:</b> "..."` or `Source: &ldquo;...&rdquo;`.
- Finds the first literal `source:` and takes everything after it (to end of field), left-trimmed.
- If what follows isn't empty and its first character is a straight `"` or `'`, that is treated as
  an opening quote; anything else (an unquoted, described source) returns `None` — nothing to
  verify.
- The **closing** quote is found via `rfind` — the **last** occurrence of that same quote character
  anywhere in the remainder of the (normalized) field, not proper delimiter pairing. This is an
  intentional heuristic: "the quote may contain an apostrophe" (line 169) — using last-occurrence
  rather than first-occurrence avoids stopping at an internal apostrophe when the wrapping
  character is itself a single quote. It can still be fooled by unrelated trailing content in Extra
  that happens to contain the same quote character after the true closing quote.
- If a later occurrence of the quote character was found (`closing > 0`), the quote text is
  everything strictly between the two quote characters. If not (`closing == 0`, meaning `rfind`
  found nothing but the opening quote itself), the "quote" is everything from just after the
  opening character to the end of the field.

**Fragmenting and matching** (`unsourced_quote_fragments`, lines 173–190):
```python
quote = source_quote(extra)
if quote is None: return []
missing, cursor = [], 0
for piece in QUOTE_GAP.split(quote):
    fragment = words(piece)
    if len(fragment) < MIN_FRAGMENT_WORDS:   # 5
        continue
    position = find_words(fragment, transcript, cursor)
    if position < 0:
        text = " ".join(fragment)
        missing.append(text[:60] + ("..." if len(text) > 60 else ""))
    else:
        cursor = position
return missing
```
- The quote is split on `QUOTE_GAP` (`...`, `…`, or a `[...]` span) into pieces — the parts of the
  quote on either side of an omission or an editorial insertion.
- Each piece is tokenized with `words()`; pieces yielding **fewer than 5** words are skipped
  entirely — "shorter pieces match by accident" (line 58).
- Each surviving piece must be found, **in order**, starting the search no earlier than where the
  previous piece was found (`cursor` only ever advances) — a quote's pieces cannot be matched out
  of order or reused.
- A piece that is **not** found contributes one entry to `missing`: its own words re-joined with
  single spaces (so original punctuation/spacing from the quote is discarded — only the alphanumeric
  tokens survive), truncated to the first 60 characters, with a literal `"..."` appended **only**
  if truncation actually occurred (i.e. the joined text is longer than 60 characters). This string
  — ellipsis included when present — is exactly what rule 4 (§5.1) wraps in `repr()`.
- A piece that **is** found advances `cursor` to just past its match, and contributes nothing to
  `missing`.

**The fuzzy matcher** (`find_words`, lines 130–152):
```python
def find_words(fragment, transcript, start):
    slack = max(4, len(fragment) // 4)
    for begin in (i for i, word in enumerate(transcript[start:], start) if word == fragment[0]):
        at, skipped = begin, 0
        for word in fragment:
            while at < len(transcript) and transcript[at] != word:
                at, skipped = at + 1, skipped + 1
                if skipped > slack:
                    break
            if skipped > slack or at >= len(transcript):
                break
            at += 1
        else:
            return at
    return -1
```
- `slack` is a **single shared budget** of tolerated "junk" transcript words for matching the
  **entire** fragment (not a per-gap allowance) — `max(4, len(fragment)//4)`: a floor of 4, growing
  by one for every 4 words of fragment length.
- For every position in `transcript` (starting at `start`) whose word equals the fragment's first
  word, attempt a full match: walk forward through `transcript`, and for each fragment word in
  order, skip forward (incrementing the shared `skipped` counter) until that exact word is found or
  the transcript ends or `skipped` exceeds `slack`. If the whole fragment is matched within budget,
  return the transcript position **just past** the last matched word. If any candidate start
  position exhausts its budget or the transcript, move on to the **next** occurrence of the
  fragment's first word (never backtracking within the same attempt).
- If no candidate start position succeeds, return `-1`.
- This is: an exact-token, forward-only, in-order subsequence match tolerating up to `slack` other
  words interspersed anywhere among the fragment's words combined — never reordering, never
  approximate at the word level (word comparison is exact string equality on already-normalized
  tokens).

**Message** (rule 4, §5.1): `f"quoted text is not in the transcript: {fragment!r}"`. Since
`fragment` here is always the product of `words()` output joined with single spaces (optionally
plus a literal `...`), it contains only lowercase ASCII letters, digits, `&`, and single spaces (and
possibly the three literal dots) — **Python's `repr()` of such a string is always single-quoted
with no escaping needed** (see §11), which meaningfully simplifies the port's job for this one
message.

---

## 7. Deck-wide reported numbers (never fail the run)

None of the following can add to `findings` or affect the exit code — they are printed
unconditionally (subject only to their own `if` guards, noted per item) as context. All are printed
to **stdout**, all appear **before** the `PROBLEMS:`/`clean` line and the per-note findings (see §9
for the full, ordered script).

1. **Notes count** — always: `f"notes: {len(notes)}"`.

2. **Answer/subject frequency table.** Built once (lines 489–495) by scanning **every** note (not
   gated on `check()` findings) for its first cloze whose value contains no `<img>`, tags stripped;
   if such a cloze exists and its stripped text is non-empty, it is tallied into the `answers`
   counter (if `shape_of(text) != "prose"`) or the `subjects` counter (if prose). Printed as (lines
   505–507):
   ```python
   for label, counter in (("answer", answers), ("subject", subjects)):   # ANSWER block first
       for value, count in counter.most_common():
           print(f"  {count:3d}  {label:8s} {value}")
   ```
   `counter.most_common()` sorts by count descending; **ties are broken by first-insertion order**
   — i.e. the order in which each distinct value was first seen while scanning notes 1..N (empirically
   confirmed: Python's `Counter.most_common()` uses a stable sort over the counter's own iteration
   order, which for a `Counter` built by incrementing in a loop is first-insertion order). Format:
   two literal leading spaces, the count right-aligned in a 3-character field (space-padded), two
   literal spaces, the label left-aligned in an 8-character field (space-padded), one literal space,
   then the value verbatim. Worked example — `count=5, label="answer", value="foo"` renders as
   exactly (4 leading spaces before "5", 2 spaces, "answer", 3 spaces, "foo"):
   ```
       5  answer   foo
   ```

3. **Subjects never clozed** — only if the list is non-empty (lines 500–502, 508–510):
   ```python
   visible = [i for i, note in enumerate(notes, 1)
              if shape_of(note["fields"]["Text"]) == "prose"
              and not re.search(r"\{\{c\d+::<b>", note["fields"]["Text"])]
   ```
   i.e. prose notes where **no** cloze opening (`{{c` + digits + `::`) is immediately followed by
   `<b>`, anywhere in the raw text — meaning the bolded subject is never itself inside a cloze.
   Printed:
   ```python
   print(f"subjects never clozed ({len(visible)} - each needs a defence): "
         + ", ".join(f"note {i}" for i in visible))
   ```

4. **`<u>` facet count** — only if there is at least one prose note (lines 516–519):
   ```python
   prose_notes = [note for note in notes if shape_of(note["fields"]["Text"]) == "prose"]
   if prose_notes:
       faceted = sum(1 for note in prose_notes if "<u>" in note["fields"]["Text"])
       print(f"facets: {faceted} of {len(prose_notes)} prose cards carry a <u>")
   ```
   A **plain substring test** for the literal `"<u>"` anywhere in the raw `Text` field — not a
   regex, not gated on where the `<u>` sits (inside or outside a cloze).

5. **Underlines inside a blank without an either/or hint** — only if non-empty (lines 526–531):
   ```python
   u_clozed = [i for i, note in enumerate(notes, 1)
               if any("<u>" in value and " or " not in (hint or "")
                      for _, value, hint in clozes(note["fields"]["Text"]))]
   ```
   A note qualifies if **any** of its cloze *values* contains the literal `"<u>"` and that same
   cloze's hint (or empty string, if the hint is `None`) does **not** contain the literal substring
   `" or "` (space-or-space). Printed:
   ```python
   print(f"underlines inside a blank without an either/or hint ({len(u_clozed)} - the "
         f"bridge is shown, never tested): " + ", ".join(f"note {i}" for i in u_clozed))
   ```

6. **Negations inside a blank** — only if non-empty (lines 537–543):
   ```python
   negated = [i for i, note in enumerate(notes, 1)
              if any(re.search(r"\bnot\b|\bnever\b|rather than|instead of|unlike",
                               re.sub(r"<[^>]+>", "", v), re.I)
                     for _, v, _ in clozes(note["fields"]["Text"]))]
   ```
   Case-insensitive; `not`/`never` are word-bounded (so "cannot" does not match — there is no word
   boundary between the second `n` and `not`... actually there *is* a `\w`→`\w` non-boundary there,
   so "cannot" correctly does **not** match `\bnot\b`), while `rather than`, `instead of`, `unlike`
   are plain (non-word-bounded) substrings, checked against each cloze **value** with its tags
   stripped to the empty string. Printed:
   ```python
   print(f"negations inside a blank ({len(negated)} - contrast belongs in Extra "
         f"unless the negative is the fact): " + ", ".join(f"note {i}" for i in negated))
   ```

7. **Inventory-only: words a card's cited facts don't carry** — printed unconditionally whenever
   `inventory is not None` (this line has **no** `if` gate of its own, unlike every other item in
   this section — lines 550–562):
   ```python
   novel_by_note = []
   for i, note in enumerate(notes, 1):
       broken, novel = unbacked(note, inventory)
       if not broken and novel:
           novel_by_note.append((i, novel))
   total = sum(len(n) for _, n in novel_by_note)
   print(f"words a card's own cited facts do not carry: {total} across "
         f"{len(novel_by_note)} cards (re-wording is the job; this is context, not a list "
         f"to work through)")
   ```
   A note contributes here **only** if `unbacked()` returned no structural problems (i.e. it has
   valid `fact::` tags, all present in the inventory) **and** has ≥1 novel word (see §5.1 rules
   5a/5b and the `unbacked`/`stem`/`FUNCTION_WORDS` mechanics in §11's appendix note below).

8. **Inventory-only: words appearing nowhere in the whole inventory** — only if non-empty (lines
   556–558, 563–568):
   ```python
   everything = {stem(w) for row in inventory.values() for w in row}
   foreign_by_note = [(i, f) for i, note in enumerate(notes, 1)
                      for f in [foreign(note, inventory, everything)] if f]
   if foreign_by_note:
       count = sum(len(n) for _, n in foreign_by_note)
       print(f"words appearing NOWHERE in the inventory ({count} across "
             f"{len(foreign_by_note)} cards - read every one):")
       for i, f in foreign_by_note:
           print(f"    note {i}: " + ", ".join(f))
   ```
   `everything` is the set of stemmed words across **every** fact row in the whole inventory (not
   just cited ones). `foreign(note, inventory, everything)` (lines 249–257) re-derives `novel` via
   `unbacked()` and keeps only the words whose stem is absent from `everything` — the "narrow tier":
   words absent from the entire lecture's extracted vocabulary, not merely from this card's cited
   facts. Per-note breakdown lines are printed **after** the summary line, one per qualifying note,
   in note order, each as `f"    note {i}: " + ", ".join(f)` (four literal leading spaces, `f` is
   the list of foreign words for that note, comma-space joined, in the same order they appear in
   `novel`/the note's own de-duplicated face-word order).

9. **Slide-tag coverage** — only if at least one `slide::` tag was found (lines 575–582):
   ```python
   carded = {int(m.group(1)) for note in notes for tag in note.get("tags", [])
             for m in [slide_tag.match(tag)] if m}
   if carded:
       low, high = min(carded), max(carded)
       holes = [str(s) for s in range(low, high + 1) if s not in carded]
       print(f"slide tags cover {low}-{high}"
             + (f"; no card for: {', '.join(holes)}" if holes else ""))
   ```
   `carded` is the **set of integers** parsed from every note's `slide::...-NN` tags (see §3.3 for
   the pattern; leading zeros in `NN` are lost the moment `int(...)` is applied). `holes` lists
   every integer strictly between `low` and `high` (inclusive) that is **not** in `carded`,
   rendered as plain decimal strings (no zero-padding, regardless of how the original tags were
   written). If there are no holes, the `; no card for: ...` clause is omitted entirely (not printed
   as an empty clause).

---

## 8. Media checking

**Extraction**: for `field` in `("Text", "Extra")` (in that fixed order, per note), every
substring matching `IMAGE_TAG` (`<img\b[^>]*>`) is found via `.findall()`. For each such tag
string, `IMAGE_SRC` (`<img\b[^>]*\bsrc=["']([^"']+)["']`) is searched to pull out the quoted `src`
value.

**No-`src` case**: if `IMAGE_SRC.search(tag)` finds nothing at all (the tag has no `src` attribute,
or it's unquoted, or malformed), rule 1 (§5.1) fires: `f"an <img> with no src in {field}"`. **This
is never suppressed by `--no-media`** — it fires regardless of `check_media`.

**Resolution and existence**: when a `src` value *is* found, and only when `check_media` is `True`,
the file's existence is tested via `os.path.exists(os.path.join(MEDIA_DIR, source.group(1)))`.
Two exact-semantics notes:
- `os.path.join` **discards its first argument entirely if the second is an absolute path** — a
  `src` value that happens to be an absolute filesystem path would bypass `MEDIA_DIR` altogether in
  the original. Real Anki media references are always bare filenames, so this never arises in
  practice, but a straightforward `path.join` in another language does not necessarily have this
  behavior, and a differential test that deliberately probes it would surface the difference.
- A `src` that is actually an external URL (`http://...`) is checked as a literal, always-missing
  local path fragment under `MEDIA_DIR` — it will always be reported as "media missing," which is
  the original's real, intended behavior for such a card (Anki's own renderer would also not
  resolve it as local media), not a bug to special-case away.

**What `--no-media` (and a missing media directory) suppresses**: exactly and only the "media
missing from the collection" existence check (rule 2, §5.1). It does **not** suppress the "no src"
check (rule 1), nor any other structural check. `check_media` is computed once, globally, in
`main()` (§1.4) — never re-evaluated per note or per image.

---

## 9. Output ordering — the full stdout script, in order

For a **successful** run (i.e. `load()`/transcript-loading/inventory-loading did not raise), stdout
receives exactly the following, in exactly this order, with each numbered item gated by the `if`
noted (items with no gate print unconditionally on every successful run):

1. `notes: {len(notes)}` — always.
2. The answer/subject frequency table — always attempted; prints zero lines if both counters are
   empty. **Answer rows before subject rows**; within each, descending count, ties in
   first-insertion order (§7 item 2).
3. `subjects never clozed (...)` — only if `visible` is non-empty.
4. `facets: N of M prose cards carry a <u>` — only if there is ≥1 prose note.
5. `underlines inside a blank without an either/or hint (...)` — only if `u_clozed` is non-empty.
6. `negations inside a blank (...)` — only if `negated` is non-empty.
7. `words a card's own cited facts do not carry: ...` — only if `--inventory` was given (no further
   gate — prints even if the count is 0).
8. `words appearing NOWHERE in the inventory (...)`  followed by one `    note {i}: ...` line per
   qualifying note, in note order — only if `--inventory` was given **and** `foreign_by_note` is
   non-empty.
9. `slide tags cover {low}-{high}[; no card for: ...]` — only if at least one `slide::` tag exists
   anywhere in the deck.
10. `PROBLEMS:` (if `findings` is non-empty) or `clean` (if empty) — always, exactly one of the two.
11. If `findings` is non-empty: one line per finding, `f"   note {position}: {problem}"` (three
    literal leading spaces), in **note order** (1..N), and **within a note, in the fixed check
    order of §5.1** (since `findings` is built as `[(i, p) for i, note in enumerate(notes, 1) for p
    in check(...)]` — a flat list comprehension that iterates notes in the outer loop and that
    note's own problems, in the order `check()` appended them, in the inner loop).

Sections 3–9 above are each entirely omitted (not even a blank line) when their gate is false —
there is no placeholder or "none" line for an empty/inapplicable section. A differential test must
diff the **whole** stdout stream, not just the `PROBLEMS:`/`clean` section, since sections 1–9 are
exactly as load-bearing for byte-identical comparison as the per-note findings are.

For a run that fails during argument parsing, notes loading, transcript loading, or inventory
loading, **none of the above prints** — only the single relevant stderr message from §1.5/§1.6 is
emitted, and the process exits before reaching any of this stdout script.

---

## 10. The seven reference cards, verbatim

Copied exactly from the method's `3-cards.md` reference block (verified byte-for-byte,
including the double space after each `ref-0N` label and the absence of any trailing whitespace;
ref-01's second hint is `what?` since 2026-09-11).
These are the differential test's non-negotiable fixture set: **the standing project rule is that
any check must pass all seven before it is allowed to fail anything else** — a port that flags any
one of these seven has a bug, full stop, regardless of what else it gets right.

```
ref-01  {{c1::<b>Osteoid</b>::what?}} is {{c2::<i>unmineralized bone matrix</i>::what?}}

ref-02  {{c1::<b>Osteoclasts</b>::which cells?}} <u>function</u> to {{c2::<i>resorb bone matrix</i>::do what?}}

ref-03  {{c1::<b>Calcitonin</b>::which hormone?}} acts on bone to {{c2::<u>lower</u>::raise or lower?}} {{c3::<i>blood calcium levels</i>::which levels?}}

ref-04  {{c1::<b>Connective tissue</b>::which tissue?}} is <u>classified</u> into {{c2::<i>embryonic, proper, and specialized types</i>::which three classes?}}

ref-05  The {{c1::<b>epiphyseal growth</b>::which?}} <b>plate</b> has five <u>zones</u>:<br><br>1. {{c2::<i>resting cartilage</i>::which?}}<br>2. {{c2::<i>proliferating cartilage</i>}}<br>3. {{c2::<i>hypertrophic cartilage</i>}}<br>4. {{c2::<i>calcified cartilage</i>}}<br>5. {{c2::<i>ossification</i>}}

ref-06  {{c1::<img src="slide.jpg">}}<br><br>This is {{c2::<i>compact bone</i>::which tissue?}}

ref-07  <img src="slide.jpg"><br><br>This is {{c1::<i>compact bone</i>::which tissue?}}
```

### 10.1 Expected `check()` result for each, per this contract (sanity cross-check for the port)

Assume `check_media=False` (no image asset to resolve), `transcript=None`, `inventory=None` — i.e.
the minimal invocation, since none of these seven carry `fact::` tags or a `Source:` quote in this
fixture form and none reference real media.

- **ref-01**: `shape_of` → not `{{c1::<img` and not `<img` at the very start → `"prose"`. Two
  clozes, `numbers=["1","2"]`. Every cloze has a role tag (`<b>`, `<i>`) and a `?`-ending 1–3-word
  hint that is not clause-shaped (`what?` twice — rule 10b does not fire). No text after the final `}}`. No role tag wraps a cloze. `bare` (subject bolded-out) has no
  `\w's\s`. Exactly two `<b>` runs total but only one (`Osteoid`'s) — the two-bold-run check needs
  **two or more** bold runs to even form a pair, so it never fires here. No cloze value has 4+
  commas. `"<b>"` is present (prose requires it) → clean.
- **ref-02**: `"prose"`. Two clozes, both role-tagged and hinted correctly. The `<u>function</u>`
  sits **outside** any cloze, so it does not affect rules 6–10 at all, and it is not itself inside
  a `{{...}}` so it never contributes to the deck-wide "underline inside a blank" report (§7 item
  5) either — clean, and this note does not appear in that report's index list.
- **ref-03**: `"prose"`, three clozes (`numbers=["1","2","3"]`, length 3 — not > 3, rule 11 does not
  fire). `c2`'s value is `<u>lower</u>` with hint `raise or lower?` — this cloze's value **does**
  contain `<u>`, but per §7 item 5 the hint contains the literal `" or "`, so ref-03 is correctly
  **excluded** from the "underlines inside a blank without an either/or hint" report — clean on
  rule 8/9/10 (hint ends in `?`, one to three words: "raise or lower" is 3 words with no comma —
  passes rule 10's `> 3`-words-or-comma test).
- **ref-04**: `"prose"`. Two clozes; `c2`'s value `embryonic, proper, and specialized types` has 2
  commas — below the ≥4 threshold for rule 16, so the inline-series check does not fire (this is
  exactly the "four legitimate items" the project treats as fine, and even a genuine 4-comma/5-item
  case is only ever counted elsewhere in method docs, never failed by this script at exactly 4 — see
  §11).
- **ref-05**: `"prose"`. Six cloze spans, two distinct numbers (`numbers=["1","2"]`). `c1` is hinted;
  `c2`'s five occurrences: only the first is hinted, and rule 8's shared-hint exemption (§5.2)
  covers the other four. Two `<b>` runs (`epiphyseal growth`, `plate`) with only a single space
  between them once clozes are flattened — the two-bold-run gap check finds nothing but whitespace,
  so it does not fire. No single cloze value has 4+ commas (each list item is comma-free) — the
  inline-series check does not fire regardless of the numbered-list guard's own behavior on this
  text (§3.2). Trailing content after the final `}}` (item 5's) is empty. Clean.
- **ref-06**: `shape_of` sees `{{c1::<img` at the very start → `"ref-06"`. `numbers=["1","2"]` —
  matches rule 18's requirement exactly. `c1`'s value contains `<img>` → the `is_image` branch: no
  hint present, so rule 6 does not fire, and rule 7/8/9/10 are skipped for this span via `continue`.
  `c2` is a normal hinted `<i>` cloze. No `<b>` anywhere in the text → rule 17b does not fire
  (correctly — recognition cards must have none, and this one has none). Clean.
- **ref-07**: `shape_of` sees `<img` at the very start (and not `{{c1::<img`, since there is no
  cloze wrapping it at all) → `"ref-07"`. `numbers=["1"]` — matches rule 19's requirement. No `<b>`
  anywhere. For the answer-leak check: `answer` = `compact bone`; `front` = the image tag (stripped
  to a space) + `"This is "` + trailing (empty) → `"  this is "` (lowercased, tags removed) — the
  words `compact` and `bone` do not appear in `front` → rule 20 does not fire. Clean.

---

## 11. Porting hazards — exact cross-language semantics to replicate on purpose

These are places where Python's own semantics are specific enough that a naive, "obviously
equivalent" TypeScript translation will silently diverge. Each is either (a) something the port
**must** reproduce exactly for byte-identical findings on realistic inputs, or (b) a genuine
indeterminacy in the *original* that the differential-test harness should be told about rather than
have a port "fixed" against (fixing it makes the port *more* correct than the reference it is being
diffed against, which fails the diff).

1. **`Counter.most_common()` tie-breaking is first-insertion order**, empirically confirmed. A
   JS/TS port must use an order-preserving map (e.g. a `Map`, never a plain object relying on
   numeric-key reordering) keyed by first-seen order while accumulating counts, then a **stable**
   sort by count descending (`Array.prototype.sort` has been spec-guaranteed stable since ES2019 —
   Node 24 qualifies) over that map's insertion-ordered entries.

2. **`dict.fromkeys(iterable)` for order-preserving de-duplication maps directly and safely to
   `[...new Set(iterable)]`** in JS — both preserve first-occurrence order. This one is a clean,
   worry-free port; noted here only so it isn't mistaken for a hazard by association with the
   `Counter` item above.

3. **`set(...)` iteration order over strings is *not* deterministic across Python process runs**
   (confirmed empirically: three separate `python3 -c "print(list({'50','75','40'}))"` invocations
   in this environment produced three different orders — string hash randomization,
   `PYTHONHASHSEED`). This affects exactly one place: `zoom_worn_as_magnification`'s `set(
   MAGNIFICATION.findall(extra))` (§6.1). When a card's `Extra` field contains **more than one**
   distinct magnification-looking number that both fall within tolerance of the stated zoom (rare —
   normally there is exactly one), the **order** of the resulting messages is not even
   self-consistent across two runs of the unmodified Python original. Recommendation: the port
   should use first-appearance order (deterministic, and identical to the Python original whenever
   there is only one qualifying claim, which is the case that matters for every real deck); the
   contract explicitly does not require matching Python's own non-determinism in the multi-claim
   case, since there is nothing consistent to match.

4. **`os.path.join` silently drops all prior segments when a later segment is an absolute path**
   (confirmed empirically: `os.path.join('/media/dir', '/etc/passwd') == '/etc/passwd'`). Node's
   `path.join` does **not** do this — it concatenates and normalizes without special-casing an
   absolute later segment. This only matters if a `src` attribute ever contains an absolute path,
   which does not happen with real Anki media references; call it out rather than silently
   "improving" on it, since a test that deliberately constructs this input would otherwise diverge.

5. **`raise SystemExit(some_string)` prints the string to stderr with no traceback and exits 1** —
   confirmed empirically (`python3 -c "raise SystemExit('hello world')"` → stdout: nothing; message
   on stderr; `$?` = 1). This is what backs every row in §1.6's table.

6. **Python `repr()` quote selection**, needed for every `{X!r}` placeholder (rules 4, 7, 9, 10, 12,
   15, 18/19's implicit list-repr, 20): default single-quoted; if the string contains a `'` but no
   `"`, switches to double-quoted instead; if it contains both, falls back to single-quoted with
   internal `'` backslash-escaped (all three cases empirically confirmed above). Backslashes and
   control characters are backslash-escaped per normal Python string-escaping rules; ordinary
   printable non-ASCII characters are **not** escaped. In practice:
   - Rule 4's `{fragment!r}` is always safe to render as plain `'...'` with **no escaping logic
     needed at all** — the value only ever contains lowercase `[a-z0-9&]` tokens, single spaces,
     and possibly a literal `...`, none of which require escaping or a quote-style switch.
   - Rules 7, 9, 10, 12, 15, 20 operate on raw HTML/markup snippets or plain hint text and **can**
     contain a `'` (an eponym's possessive, an apostrophe in prose) — these need the full
     quote-selection logic, not the shortcut above.
   - Rules 18/19's `{numbers}` is Python's **list** repr, not a string repr: square brackets,
     each element single-quoted (elements are always plain digit strings, never containing a quote
     themselves, so no escaping/switching ever triggers here), comma-space separated — e.g.
     `['1', '3']`. A port must produce this exact bracket-and-quote form, not a bare joined list.

7. **`\w` is Unicode-aware by default in Python 3's `re`, but ASCII-only by default in JavaScript**
   regex (JS's `\w` is always `[A-Za-z0-9_]`, with or without the `u`/`v` flag — Unicode word
   matching in JS requires explicit `\p{L}`-style property escapes). This affects rule 14's
   `\w's\s` possessive check: an accented word character immediately before `'s ` would be caught by
   the Python original but missed by a literal JS `\w` port. Given the source material is medical/
   anatomical English terminology, this is unlikely to be exercised, but should be a conscious
   choice (either accept the narrower ASCII match, or use a Unicode property escape to match
   Python's default) rather than an accident.

8. **Python's `str.splitlines()`** (used in `load_transcript`) splits on a broader set of line
   boundaries than `\n`/`\r\n` — also `\v`, `\f`, `\x1c`–`\x1e`, ` `, ` `, and a couple of
   others. A JS `.split(/\r\n|\r|\n/)` will miss the more exotic ones. Transcript files in practice
   are plain `\n`/`\r\n`, so this is a low-probability hazard, but is exact enough to be worth a
   comment at the call site in the port rather than silent narrowing.

9. **Python's `str.split()` (no arguments)** splits on runs of whitespace and produces **no**
   leading/trailing empty strings, regardless of leading/trailing whitespace in the source. A naive
   JS `.split(/\s+/)` on a string with **leading** whitespace produces a leading empty-string
   element (a well-known JS gotcha) — every call site that relies on Python's `.split()` semantics
   (rule 10's `hint.rstrip("?").split()`; rule 20's `answer...lower().split()`) must guard against
   this (e.g. trim first, or `.split(/\s+/).filter(Boolean)`).
10. **Python's `str.lstrip()`** (used in `shape_of`) strips a broader whitespace set than JS's
    `.trimStart()` need not match exactly, but both strip the common ASCII space/tab/newline set
    that this file's fields actually use — low risk, noted for completeness rather than as an
    expected real divergence.

11. **JSON/OS error text embedded in four of the `SystemExit` messages (§1.6) cannot be
    byte-reproduced across runtimes.** The contract for those four rows is: exit 1, message on
    stderr, matching the fixed **template and trigger condition** — a differential test harness
    should either (a) not exercise these paths at all (prefer testing them as unit tests of "exit
    code 1, stderr non-empty, expected prefix present" rather than full-string diffs), or (b) treat
    the embedded `{error}` text as a wildcard region when diffing.

12. **`load()`'s validation only checks that `fields.Text` (or `fields.Source`, checked later in a
    different function) *exists*, never that it is a non-null string.** Two concrete unhandled
    crashes in the original that a port should knowingly decide how to handle (replicate the crash,
    or fail more gracefully — but not silently produce a *different successful result* than the
    original would for the same malformed input, since that breaks the diff):
    - `"fields": {"Text": null}` passes `load()`'s check (the key exists) and then crashes inside
      `shape_of` (`None.lstrip()` → `AttributeError`) the moment that note is checked.
    - `"fields": {"Text": "...", "Source": null}` passes loading, and crashes at
      `fields.get("Source", "").lower()` (§6.2's gate) the moment a `--transcript` run reaches that
      note, **even if that note has nothing to do with a transcript quote** — the crash happens
      before the `unsourced_quote_fragments` call, purely from evaluating the gate condition.
    - Similarly, `{"params": "not-a-dict"}` as the whole deck.json top level crashes inside `load()`
      itself (`"not-a-dict".get(...)` → `AttributeError`, since a string has no `.get`) rather than
      producing the "expected a list of notes" `SystemExit`.

13. **The `front`/`answer` tag-stripping asymmetry in rule 20 (empty-string strip for `answer`,
    space strip for `front`) is real and must be kept asymmetric** — it is not a typo to normalize
    away. Collapsing both to the same replacement would change results for any ref-07 answer whose
    value has adjacent tags with no space between them (e.g. `<i>Compact</i><i>bone</i>` would
    become the single fused token `compactbone` under the original's empty-string strip, versus two
    separate words under a space-based strip) — the port must match the original's asymmetry, not
    "improve" it into consistency.

14. **Leading zeros in cloze numbers and slide numbers behave differently from each other and must
    each be handled on their own terms.** A cloze written `{{c01::...}}` keeps `"01"` as its number
    **string** everywhere it is compared or displayed (rules 18/19's list-repr, rule 7/8/9/10's
    `c{number}` prefix) — `numbers` is numerically *sorted* via a numeric key but the strings
    themselves are never reformatted. A `slide::foo-007` tag, by contrast, is parsed with
    `int(...)` for the coverage report (§7 item 9) and its leading zeros are **lost** — holes are
    printed as plain `str(int)` regardless of the source tag's own zero-padding style. These are two
    different fields with two different fidelity rules; do not unify them.

15. **A cloze value containing a literal `::` is truncated at the first one, both for hint-splitting
    (`clozes()`) and for the flattening idiom used in rules 15 and in `unbacked()`'s face-word
    extraction (`CLOZE.sub(lambda m: m.group(2).partition("::")[0], text)`).** This is existing,
    intentional-by-construction behavior in the original (there is no escaping mechanism for `::`
    inside a value) — replicate the truncation-at-first-`::`, do not attempt to be smarter about it.

16. **Exactly 4 commas (5 items) in one cloze value is never failed by rule 16 — the threshold is
    strictly `>= 4` for *fail*, meaning `item_commas == 4` *does* fail (5-item series), while
    `item_commas == 3` (4 items) passes silently with no report anywhere in this script.** (Method
    docs outside this script describe 4-item series as "close enough that it is only counted" —
    but this script performs no such counting or reporting for the 4-item case at all; it simply
    never fires for it. Do not add a new deck-wide "4-item series" report that does not exist in
    the original.)

17. **Every occurrence of "shape" in this document means the return value of `shape_of(text)` as
    defined in §4, called fresh on the note's raw `Text` field each time it is needed** (it is
    called once per note at the top of `check()` and reused as the `shape` local for the rest of
    that call, and called again independently — recomputing the identical result — inside the
    deck-wide report comprehensions in §7 items 2–4, since those loops do not have access to the
    per-note `shape` local computed inside separate `check()` calls). A port may cache this per note
    if convenient; the original does not, but recomputation is pure and side-effect-free, so caching
    changes nothing observable.

---

## 12. Appendix: per-note check order inside `check()`, as pseudocode

For implementers who want a single linear checklist to transcribe directly into a port's main
per-note function, this is §5's table collapsed to control flow (message text and shape gates
elided — see §5 for those):

```
compute fields, text, extra, shape, spans, numbers
if spans is empty: return ["no cloze at all"]          # nothing else runs

for field in [Text, Extra]:
    for each <img> tag:
        if no src attribute: emit (rule 1)
        elif check_media and file missing: emit (rule 2)

for each claim in zoom_worn_as_magnification(extra): emit (rule 3)

if transcript given and Source field contains "transcript":
    for each unmatched quote fragment: emit (rule 4)

if inventory given:
    append unbacked()'s broken-tag messages, if any (rules 5a/5b)

for (number, value, hint) in spans:
    if value contains <img>:
        if hint truthy: emit (rule 6)
        continue                                        # skip rules 7-10 for this span
    if value has no <b>/<i>/<u>: emit (rule 7)
    if hint is None and not (shared-list exemption): emit (rule 8)
    if hint is not None:
        if hint doesn't end in "?": emit (rule 9)
        elif hint has a comma or > 3 words: emit (rule 10)
        elif CLAUSE_HINT matches: emit (rule 10b)

if len(numbers) > 3: emit (rule 11)
if text after final "}}" (tag-stripped, unescaped, trimmed) is non-empty: emit (rule 12)
if a role tag directly wraps a "{{cN": emit (rule 13)

if shape == prose:
    if a possessive appears outside every <b>...</b> span: emit (rule 14)
    if two adjacent <b> runs (on hint-flattened text) have non-whitespace content between them:
        emit (rule 15); stop after the first such pair
    if not exempted by the numbered-list guard:
        if some cloze value (skipping image clozes) has >= 4 commas:
            emit (rule 16); stop after the first such cloze

if shape == prose and no "<b>" anywhere: emit (rule 17a)
if shape != prose and "<b>" appears anywhere: emit (rule 17b)

if shape == ref-06 and numbers != ["1","2"]: emit (rule 18)

if shape == ref-07:
    if numbers != ["1"]: emit (rule 19)
    for each word (len > 3) in the answer (c1's value, tag-stripped/lowercased/split):
        if that word is a substring of the front (image+trailing, tag-stripped/lowercased):
            emit (rule 20)                               # every qualifying word, no early stop

return the accumulated list of emitted messages
```
