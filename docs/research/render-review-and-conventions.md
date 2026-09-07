# `render_review.py` behavioral contract, and the engine repo's standing conventions

Source repo for everything below (read-only reference; paths are given relative to its root):
`~/Dev/Anki/.claude/worktrees/codegraph-review-3c12f3`

Everything in Part 1 marked **[verified]** was confirmed by actually running
`tools/render_review.py` against synthetic `deck.json` fixtures built for this task (Python
3.14, stdlib only) — not inferred from reading alone. No real `deck.json` exists anywhere in the
source repo to test against (course material and decks are gitignored/local-only per its
`AGENTS.md`/`README.md`), so the fixtures were built to match the documented `Custom Cloze`
AnkiConnect shape exactly (`anki/README.md`, `.claude/skills/anki-cards/SKILL.md`). The test
fixtures and captured output live under this session's scratchpad, not in either repo.

---

## Part 1 — `tools/render_review.py`

### 1.1 Purpose

Quoting its own docstring: it renders a `deck.json` as "one reviewable HTML page: every card's
fronts and backs, in order." It exists because the handover step of `method/3-cards.md`
(`.claude/skills/anki-cards/SKILL.md`) requires showing the user *rendered card faces*, not the
JSON payload — the **hint-fluency test** ("read each sentence with the blank in place and it
must still be English") only runs against a rendered front, and that is a pass check_deck.py
cannot perform: "a script cannot read a defence." This is a deliberate division of labor that
recurs throughout the source repo: `check_deck.py` is the automatable, exit-code-gated structural
check; `render_review.py` produces the artifact a human reads for the two judgments no script can
make — hint fluency, and "does this still read as a true sentence."

`render_review.py` never talks to Anki/AnkiConnect. It is a pure `deck.json` → `review.html`
transform, no network, no side effects beyond the one file it writes.

### 1.2 CLI surface

```
python3 tools/render_review.py deck.json              # writes review.html beside deck.json
python3 tools/render_review.py deck.json out.html      # writes to an explicit path
```

- `argv` must have exactly 2 or 3 elements (script name + 1 or 2 args). **[verified]** Any other
  count prints `usage: render_review.py deck.json [out.html]` to stderr and returns **exit 2**.
- Default output path: `os.path.join(os.path.dirname(deck.json path) or ".", "review.html")`.
  **[verified]** A bare filename with no directory component (`deck.json` in the cwd) writes to
  `./review.html`, not to a bare `review.html` — the `or "."` fallback is explicit.
- `ANKI_MEDIA` env var overrides the media directory used to resolve image `src`s (see 1.5).
- No other flags. No `--help`.
- On success, prints `wrote {out_path} ({N} notes)` to stdout and returns **exit 0**.

### 1.3 Input contract

**Payload shapes.** The script's own comment says it "reads the same three payload shapes as
check_deck.py," and `check_deck.py`'s docstring names them explicitly: "Accepts a bare list of
notes, `{"notes": [...]}`, or an AnkiConnect `{"params": {"notes": [...]}}` payload." Confirmed
**[verified]** identical output from all three shapes against the same note data:

```python
data = json.load(handle)
if isinstance(data, dict):
    data = data.get("params", data).get("notes", [])
```

A dict lacking both `params` and `notes` does **not** raise — `.get("notes", [])` silently
resolves to an empty list. **[verified]** `{"unrelated": "blob"}` produces `wrote out.html (0
notes)`, exit 0, no warning. This is an asymmetry worth naming: a top-level shape miss fails
*silently*, while a per-note structural miss fails *hard* (next paragraph).

**Per-note requirements.** Each note is indexed with plain `dict` subscripts, not `.get()`, for
the two fields that matter to rendering:

```python
fields = note["fields"]      # KeyError if absent
text = fields["Text"]        # KeyError if absent
```

**[verified]** A note missing `fields`, or a `fields` object missing `Text`, produces an
**uncaught `KeyError`, a Python traceback on stderr, and exit 1** — not a friendly validation
message. `fields.get("Extra", "")` and `fields.get("Source", "")` are `.get()`-based and default
to `""` when absent — no crash. `note.get("deck_name", "")` is also `.get()`-based (see 1.3.1).

Other file-level failure modes, all **[verified]**, all uncaught-exception **exit 1** with a
traceback (no custom error handling anywhere in the script): input file does not exist
(`FileNotFoundError`), input file is not valid JSON (`json.decoder.JSONDecodeError`).

**Exit code summary:**

| condition | exit | mechanism |
|---|---|---|
| wrong arg count | 2 | explicit `return 2` after printing usage |
| success | 0 | explicit `return 0` |
| missing input file / invalid JSON / note missing `fields` or `fields.Text` | 1 | **unhandled** Python exception (default interpreter exit status — not a designed signal) |
| top-level dict has neither `params` nor `notes` | 0 | silently treated as zero notes |

#### 1.3.1 A discovered inconsistency: `deck_name` vs. `deckName`

The page `<h1>` is populated from `data[0].get("deck_name", "")` — **snake_case**. But every
documented `deck.json` note object in this repo uses AnkiConnect's own wire shape, which is
**camelCase** `deckName` (see the `addNotes` example in `.claude/skills/anki-cards/SKILL.md`:
`"deckName":"<Course>::Test 2::Histology::Bone"`). **[verified]**: a fixture built with only
`deckName` (the real, documented shape) renders `<h1></h1>` and `<title> — 5 notes</title>` —
completely blank. A fixture with `deck_name` added renders the header correctly. `check_deck.py`
itself never reads either key — it doesn't use a deck name at all. There is no `deck.json`
fixture anywhere in the source repo to confirm which key real decks actually carry; based on the
documented AnkiConnect shape, the header is dead code in practice as shipped.

### 1.4 Cloze-to-face algorithm — how one note becomes N front faces

```python
CLOZE = re.compile(r"\{\{c(\d+)::((?:(?!\}\})[\s\S])*)\}\}")
```

A cloze body runs up to the first `}}` — it cannot straddle into a following cloze. (This exact
regex is duplicated verbatim in `check_deck.py`; the two files do not share a module. Porting
both to one codebase removes the reason for that duplication — see decisions.)

```python
def render(text, blank=None):
    def sub(match):
        number, inner = match.group(1), match.group(2)
        value, separator, hint = inner.partition("::")
        if number == blank:
            return '<span class="blank">[%s]</span>' % (hint if separator else "&hellip;")
        return '<span class="cloze">%s</span>' % value
    return CLOZE.sub(sub, text)
```

Per note:

1. Find every `{{cN::...}}` in `fields.Text`; take the **set** of distinct ordinals `N`, sorted
   numerically as strings (`c1, c2, c3, ...`) — call this `numbers`.
2. **One front face per distinct ordinal** in `numbers` (this is exactly how many actual cards
   Anki will generate from the note — the tool's face count is a faithful proxy without ever
   asking Anki). For ordinal `n`, `render(text, n)` re-scans the *entire* text and, for **every**
   cloze match found anywhere in it:
   - if that match's own ordinal `== n`: replace with `<span class="blank">[H]</span>`, where `H`
     is **that specific occurrence's own** hint (text after `::`) — or a literal `&hellip;` if
     that occurrence has no `::hint` part at all.
   - otherwise: replace with `<span class="cloze">V</span>` showing that occurrence's value,
     hint discarded — this is how "siblings revealed" is produced.
3. **Every occurrence of the target ordinal is blanked together, not just the first.**
   **[verified]** against a `ref-05`-shaped list note (one hint on the first of five same-numbered
   clozes, none on the other four): the `c2` front face blanks **all five** list items
   simultaneously — item 1 shows `[which?]` (its own hint), items 2–5 each show a bare `[…]`
   (no hint was ever authored on those occurrences, and none is borrowed from item 1). This
   matches genuine Anki cloze semantics (hiding is per-occurrence, not per-ordinal-with-a-shared-
   hint).
4. **The back face is single and shared**: `render(text)` with `blank=None` never equals any
   ordinal string, so every cloze in the text — regardless of number — becomes a revealed
   `<span class="cloze">`. One `.face` div under `.backs` per note, always, independent of how
   many distinct ordinals exist.
5. Each front face is preceded by `<span class="cn">cN</span>` naming which ordinal it tests.

Recognition cards (`ref-06`/`ref-07` shapes) fall out of the same algorithm with no special
casing: an image `<img>` tag sitting *inside* a `{{c1::...}}` (ref-06) is treated exactly like any
other cloze value — on `c1`'s front it is blanked to `[…]` (no hint authored on it, by
convention), on `c2`'s front (and on the back) it is revealed wrapped in
`<span class="cloze">`, which is visually inert on an `<img>` but structurally present. An image
*outside* any cloze (ref-07) is never touched by the substitution at all and appears identically
on every face of that note — and because ref-07 has only one distinct ordinal, the note produces
exactly one front face, i.e. one card, confirming the doc claim that ref-06 "makes two cards" and
ref-07 "makes one instead of two."

### 1.5 Image `src` resolution

```python
DEFAULT_MEDIA = os.path.expanduser("~/Library/Application Support/Anki2/User 1/collection.media")
if not os.path.isdir(DEFAULT_MEDIA):
    DEFAULT_MEDIA = os.path.expanduser("~/.local/share/Anki2/User 1/collection.media")
MEDIA_DIR = os.environ.get("ANKI_MEDIA", DEFAULT_MEDIA)

IMAGE_SRC = re.compile(r'''(<img\b[^>]*\bsrc=)["']([^"':]+)["']''')

def local_images(markup):
    return IMAGE_SRC.sub(
        lambda m: '%s"file://%s"' % (m.group(1), os.path.join(MEDIA_DIR, m.group(2))), markup)
```

Applied to every rendered face **and** to the `Extra` field, so a staged slide image renders
in-browser without opening Anki. **[verified]** behavior of the regex, which is easy to
misdescribe from reading alone:

- Matches **both** `src="…"` and `src='…'`.
- The captured filename character class is `[^"':]+` — **excludes colons**, not just quotes. A
  `src` already containing a colon anywhere (`http://…`, `data:…`, an already-built `file://…`)
  fails to match at all past the colon and is therefore **left completely untouched** —
  **[verified]**: `<img src="http://example.com/remote.jpg">` passes through unchanged. This
  looks intentional ("don't touch an already-absolute URL") but is actually a side effect of
  excluding `:` from the character class, not an explicit scheme check.
- Anything *without* a colon is rewritten, **including a value with slashes** —
  `already/nested/path.jpg` becomes `file:///…/collection.media/already/nested/path.jpg`. It is
  not "bare filename only"; it's "no colon anywhere in the value."
- `MEDIA_DIR` is used exactly as given, via `os.path.join`, with **no `os.path.abspath()` call**.
  **[verified]**: `ANKI_MEDIA=./fake_media` produces `file://./fake_media/course-slide-01.jpg` — a
  relative `file://` URL, which browsers do not reliably resolve (`file:` URIs are specified as
  absolute). The two built-in defaults are safe because `os.path.expanduser` always returns an
  absolute path; a caller-supplied `ANKI_MEDIA` is not normalized the same way.
- `render_review.py` never checks whether the resolved file actually exists on disk — that
  existence check belongs to `check_deck.py` alone (against `collection.media`, skippable with
  `--no-media`).

### 1.6 HTML/CSS output contract

One self-contained HTML file, inline `<style>` and inline `<script>`, no external assets, no
network calls, dark-theme-only (`color-scheme: dark` is hardcoded, not conditional).

**Escaping.** Only two things are ever passed through `html.escape`: the `Source` field and the
deck-name header. **[verified]**: `Source: "Slide 12 & notes"` renders as `Slide 12 &amp; notes`;
an `&` typed directly into `Extra` renders completely raw (`H&E.` stays `H&E.`, not
`H&amp;E.`). `fields.Text` and `fields.Extra` are injected as **trusted, unescaped HTML** — by
design, since the whole point is rendering the `<b>`/`<i>`/`<u>`/`<img>`/cloze markup as markup,
not as literal text. See decisions/risks: this is a real trust-boundary decision if the port ever
renders a `deck.json` the current session did not just author.

**Page structure** (`%`-formatted single string, not a templating engine):

```
<!doctype html><meta charset="utf-8"><title>{deck} — {N} notes</title>
<style>…</style>
<div class="wrap">
  <h1>{deck}</h1>
  <div class="sub">{N} notes · <b>subject</b> · <u>facet</u> · <i>value</i> · <span class="blank">[hint]</span></div>
  {one <article> per note, in input order}
</div>
<bar>{Fronts / Backs / Extras toggle buttons}</bar>
<script>{toggle logic}</script>
```

The `.sub` line is a **static legend**, not derived from the note data — it exists purely to
teach the reviewer the color code before they start reading.

Per note, `<article>` contains, in this fixed order:
`.idx` (1-based position + escaped `Source`) → `.fronts` (N `.face` divs, one per ordinal) →
`.backs` (exactly one `.face` div) → `.extra` (the `Extra` field, media-resolved, unescaped).

**CSS roles**, and — worth stating explicitly — these colors are **not arbitrary**; they are
copy-identical to the live `Custom Cloze` Anki note type's own CSS documented in
`anki/README.md`, so the preview is a faithful stand-in for how the card will actually look once
inserted:

| selector | rule | role |
|---|---|---|
| `b` | `color:#C695C6` | subject |
| `u` | `color:#5EB3B3` | facet/bridge |
| `i` | `color:IndianRed; font-style:normal` | answer/value |
| `.cloze` | `font-weight:bold; color:MediumSeaGreen` | a *revealed* sibling cloze (front) or any cloze on the back |
| `.blank` | `color:#E8C07D; font-weight:bold` | the currently-hidden cloze, shown as `[hint]` or `[…]` |
| `.cn` | small, dim | the `cN` ordinal label on a front face |
| `.extra` | dim, top border, `display:none` by default | shown only in Extras mode |

**View toggle** (`Fronts` / `Backs` / `Extras`, plain inline `<script>`, no framework): a
single `class` on `<body>` (`f`, `b`, or unset) driven by CSS (`body.f .backs{display:none}`,
`body.b .fronts{display:none}`), plus an independent `x` class toggled onto `<body>` that shows
`.extra` blocks without affecting the f/b state — so "show extras" is a layer on top of either
Fronts or Backs, not a third exclusive mode. Starts in Fronts mode (`B.className='f'`) — i.e. the
hint-fluency view is the default view, which matches its stated purpose.

### 1.7 Relationship to `check_deck.py`

Both scripts independently parse the same three payload shapes and define **the identical `CLOZE`
regex** (verified by direct comparison of both files' regex literals and their code comments,
which use the same wording — "runs to the first `}}`, so a cloze can never straddle into the next
one"). Neither imports the other; each is written to remain standalone-copyable (the repo's
stdlib-only, no-shared-module convention). `check_deck.py`'s own docstring states it "Recognises
the three card shapes in method/3-cards.md and applies the rules that belong to each, so the
seven reference exemplars all pass — which method/3-cards.md requires of any check," and separately
confirms: `sys.exit` codes are `2` (usage error), `1` (structural findings present — a **designed**
failure signal, unlike `render_review.py`'s accidental `1`), `0` (clean). `check_deck.py` was not
given the same line-by-line verification pass in this task as `render_review.py` — see open risks.

### 1.8 The hook — `tools/hooks/on_deck_write.sh` — automatic gating today

```sh
path=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))' 2>/dev/null) || exit 0
[ "$(basename "$path")" = "deck.json" ] || exit 0
repo=$(cd "$(dirname "$0")/../.." && pwd)
{
  echo "deck-write hook > python3 tools/check_deck.py --no-media '$path'"
  echo "(structural check only; the media + --transcript run is still owed — see the run-sheet)"
  python3 "$repo/tools/check_deck.py" --no-media "$path"
} >&2
exit 2
```

Wired in `.claude/settings.json` as a `PostToolUse` hook with matcher `Write|Edit` — meaning **the
harness fires it after every single Write or Edit tool call in the whole session**, not just
`deck.json` writes; the hook itself does all the filtering:

1. Extract `tool_input.file_path` from the hook's stdin JSON. If that extraction fails for any
   reason (`|| exit 0`), no-op silently.
2. Compare `basename(path)` to the **literal string** `"deck.json"` — exact match, not a glob or
   extension check. Anything else (`mydeck.json`, `deck.json.bak`, `plan.md`) no-ops silently.
3. Resolve the repo root from the **hook script's own location** (`dirname "$0"/../..`), not the
   caller's cwd — so it works regardless of where the writing tool call happened from.
4. Run `check_deck.py --no-media` only — the structural checks, deliberately excluding the
   media-existence check and the `--transcript` quote-verification check, because "a deck is
   often written before its images are staged." The comment is explicit that the full run (media
   + `--transcript`) is a separate, still-owed manual step (run-sheet step 1's "full form").
5. Echo two context lines plus the check's own full output, all redirected to **stderr**, then
   **unconditionally `exit 2`** — regardless of whether `check_deck.py` itself exited 0 (clean) or
   1 (findings). The comment explains why: "Exit 2 is the PostToolUse channel whose stderr reaches
   the model, so the report goes there **even when the deck is clean** — the deck-wide counts
   (facets, slide coverage) are the point, not only the failures." This is a reporting mechanism,
   not a hard block — nothing here prevents the write from having already happened; it forces the
   report into the conversation every time.

`render_review.py` is **never invoked by this hook**. Rendering the review page is a separate,
explicit run-sheet step (step 2, "Render"), always user/pipeline-triggered — the hook only ever
runs the structural linter.

For the A.P.E. port, "the same gating behavior" means, concretely: an event fires on every
relevant write regardless of which file changed; the gate itself decides relevance by an exact
match on what stage-artifact it cares about; it always resolves its check code by a fixed,
caller-independent path; it runs only the cheap structural subset automatically and reports
unconditionally (pass or fail) because the non-failing counts are the point; and it never doubles
as the render/preview step, which stays separate and explicit.

---

## Part 2 — Conventions binding the A.P.E. build

Sources: `AGENTS.md`, `README.md`, `APP.md`, `anki/README.md`, cross-checked against
`.claude/skills/anki-cards/SKILL.md` (the actual file `method/3-cards.md` symlinks to) where the
top-level docs pointed at it by name for something this task asked to extract exactly (the seven
reference cards; the writer-ratifies-nothing mechanism).

### 2.1 "No code chooses what a card says"

From `README.md`'s "Why there is no code" section: an earlier version of this project was 2,924
lines of Python plus an 80,412-character rulebook, orchestrating sub-agents to reproduce what
1,737 characters of examples already specified — and a single day of debugging found nine bugs,
all in the plumbing, none in "the model's ability to write a flashcard." The condemning detail:
the six worked example cards sat at 97% of the way into a 57,000-character prompt, *under* the
line telling the agent to compare its draft against the references *below* them. An independent
audit kept 34 instructions out of "roughly 140," and every one of the 140 was a *prohibition* —
none described what a normal card looks like, which is why step 3 of the method now opens with
"what a card is" and seven worked examples before a single constraint.

The line the repo draws, verbatim: **"no code chooses what a card says — the moment a script
starts ranking facts or writing sentences, it is the 2,924 lines again."** `tools/` is explicitly
carved out as not violating this: it is a *converter* (turning slide-viewer links into image
files, "the same job `soffice` already does for a `.pptx`"), and a converter decides nothing about
content. `APP.md`'s non-goals restate this for the app itself: **"No card-authoring logic in app
code — the line the repo already holds ('no code chooses what a card says') applies to the app
verbatim."**

The practical boundary: prose method files decide *what a card says and why*; code may extract,
convert, render, check structure, and check claims against sources — but must never rank facts,
choose phrasing, or generate/rewrite a card's tested sentence.

### 2.2 The seven reference cards — mandatory fixture set

From `AGENTS.md`: "Card style is defined by the **seven reference cards** at the top of
`method/3-cards.md`. Where a written rule and those cards disagree, the cards win." From `APP.md`:
"The seven reference cards ship as the fixture set, and any check the app grows must pass them
first — the repo's standing rule, inherited whole." The method file itself
(`.claude/skills/anki-cards/SKILL.md`) states the rule in the form a check-writer needs: **"run
these seven through it first — they are the regression test. A check that fails ref-06 or ref-07
has not understood recognition cards; a check that passes a card these seven would reject is not
checking the right thing."** `check_deck.py`'s own docstring opens by restating the same
obligation for itself.

The seven cards, verbatim (Appendix A has them with the annotations that explain what each one is
pinning down):

```
ref-01  {{c1::<b>Osteoid</b>::what?}} is {{c2::<i>unmineralized bone matrix</i>::what is it?}}
ref-02  {{c1::<b>Osteoclasts</b>::which cells?}} <u>function</u> to {{c2::<i>resorb bone matrix</i>::do what?}}
ref-03  {{c1::<b>Calcitonin</b>::which hormone?}} acts on bone to {{c2::<u>lower</u>::raise or lower?}} {{c3::<i>blood calcium levels</i>::which levels?}}
ref-04  {{c1::<b>Connective tissue</b>::which tissue?}} is <u>classified</u> into {{c2::<i>embryonic, proper, and specialized types</i>::which three classes?}}
ref-05  The {{c1::<b>epiphyseal growth</b>::which?}} <b>plate</b> has five <u>zones</u>: [five items, one per line, every item on c2, hint on item 1 only]
ref-06  {{c1::<img src="slide.jpg">}}<br><br>This is {{c2::<i>compact bone</i>::which tissue?}}
ref-07  <img src="slide.jpg"><br><br>This is {{c1::<i>compact bone</i>::which tissue?}}
```

These are canonical text, not decoration: the method file warns that `ref-05` itself once carried
a self-contradicting annotation for a period and "24 cards were written to match it before anyone
compared the two" — i.e., even the reference set has shipped wrong before, which is the argument
for treating it as a fixture to run checks against mechanically, not just prose to remember.

**Implication for A.P.E.:** whatever check code the app ships (structural linter, style rule,
coverage counter) needs these seven as an actual, sourced-from-the-method fixture file, and CI/
tests should run every check against all seven before trusting a check's verdict on a real deck.

### 2.3 The writer-ratifies-nothing rule

`APP.md`: **"The flag loop, with the standing rule enforced by the interface: the writer ratifies
nothing. A flagged card routes to a fresh adjudicator context that returns fix-or-approve; the
writing context applies verbatim. In the harness this is discipline; in the app it is wiring."**

The method file states the mechanism this is inherited from, in its handover run-sheet (step 4,
"Fix"), with an incident behind it:

> **Fix — and the writer ratifies nothing.** A flag sends you back to the source, not to the
> markup, and the fix is a separate pass that gets reviewed again. Every finding ends in one of
> exactly two states: **fixed**, or **approved by a context that wrote none of the cards** — a
> fresh adjudicator given the finding, the card and its sources, or the owner. What the writer may
> not do is accept a finding away, however reasonable the acceptance reads: the session that wrote
> the card is judging the pattern it chose, not the card in front of it. *An auditor filed a bare
> either/or cloze as "a design choice, noted once"; the writer — whose choice it was — accepted
> it, and the card reached the owner still broken on every front the auditor had grouped away.*

So the rule is not "get a second opinion eventually" — it is a hard **two-outcome** contract per
finding (fixed / approved-by-someone-else), with the specific failure mode it defends against
named explicitly: the same context rationalizing away a valid finding about its own pattern
because the rationale sounds reasonable in isolation. `APP.md` leaves one detail open on purpose:
"Whether the app's adjudicator context runs on the same agent session or a second one — the rule
only requires a context that wrote none of the cards."

**Implication for A.P.E.:** the review-loop's data model and control flow must make it
structurally impossible for the card-writing context/session to be the same context that resolves
a flag against its own card as "no change needed." That has to be enforced by the code path
(who is allowed to call the "resolve" action), not by a prompt asking nicely.

### 2.4 `APP.md` — architecture decisions for the checks port

- `check_deck.py` and `render_review.py` are described as "a few hundred lines of stdlib" that
  "port to TypeScript and run on every stage the way the repo's hook fires on every `deck.json`
  write." Two things follow: (a) a rewrite in TypeScript, not a wrapped Python subprocess; (b) the
  ported checks are meant to run at *every* relevant stage of the app's own pipeline — Extract →
  inventory review → Organize → plan review → Cards → deck preview → audit → deliver — not only
  at the one `deck.json`-write moment the current hook happens to fire on.
- The seven reference cards ship as the app's fixture set too (2.2) — "the repo's standing rule,
  inherited whole," not reinvented for the app.

### 2.5 `APP.md` — the `.apkg` tier and the other three hard edges

Stated as one of four deliberately-named "hard edges," each with a call already made:

1. **File conversion.** No bundled LibreOffice/office-parsing pipeline. v1 asks the user to
   export slides to PDF (the model reads PDF natively); rasterized figures go through vision, "as
   the method already requires."
2. **Transcription.** v1 is bring-your-own-transcript ("the method treats the transcript as
   emphasis, not anchor, so a rough one degrades gracefully"); a bundled `whisper.cpp` tier is
   named as a possible follow-on, explicitly because the current Python/mlx-whisper tooling is
   Mac-only and does not ship as a binary.
3. **Anki / the `.apkg` tier.** Default output is a **self-contained `.apkg` file**, double-click,
   no add-on, no running Anki required, cross-platform. AnkiConnect is **progressive
   enhancement**, offered only "if detected," unlocking capabilities `.apkg` structurally cannot
   provide: direct insert, tier tags, suspend/unsuspend, and **in-place repair of an existing
   live deck**. The `.apkg` path is the load-bearing default, not a fallback bolted on afterward.
4. **Cost.** Always shown, never hidden — a pre-run estimate, an audit-depth selector, a running
   meter on the API-key tier; the ACP/subscription tier's "cost" is simply the subscription the
   user already has, which `APP.md` gives as the reason that tier is the default.

Surrounding architecture, for context on how far the current build may or may not extend:
ACP-first agent connection (the app is an ACP *client*; the user's own subscription-authenticated
CLI is the agent server; an embedded-agent/API-key tier is the fallback behind a shown cost
estimate); Tauri over Electron, one window (chat pane, file-drop, stage rail, preview pane); state
lives on disk in the user's own course folders, nothing server-side — "no server, no accounts, no
telemetry, no cloud storage." Non-goals stated explicitly: no web version, no hosted service, no
accounts, no card-authoring logic in app code (2.1), no editing the method from inside the app.

`APP.md` opens by flagging itself as **"design only. Nothing in this document is built."** Its own
named open questions (Codex's ACP support being adapter- not first-party at time of writing;
Windows/Linux `.apkg` and AnkiConnect-detection parity being untested; media-heavy deck size
estimates; which context runs the adjudicator) are inherited as open, not resolved by anything
read for this task.

### 2.6 Naming/prose conventions — public, medium-agnostic repo

The source repo is public and deliberately written to be usable by "an agent in any harness, or
by a person with no agent at all" (`README.md`). Concrete, checkable evidence of what that
discipline looks like in practice:

- **Harness-specific mechanics are isolated, never blended into the default voice.** `AGENTS.md`
  puts everything Claude-Code-specific — the hook, the skills-as-symlinked-method-files trick, the
  `deck-auditor` agent file — under one heading, explicitly titled **"If you are Claude Code."**
  The rest of the document, and `README.md`, describe the method in harness-neutral terms
  throughout (`README.md`: "Nothing here is tied to one assistant... an agent in any harness can
  read it, and so can you"). `APP.md` treats "Claude Code, Gemini CLI, Codex" as parallel,
  named-and-verified options, not a single default with others as afterthoughts.
- **No real identifying names anywhere, including in examples.** `AGENTS.md`'s Conventions
  section, verbatim: "Deck and tag names in the docs are placeholders
  (`<Course>::Test N::<Subject>::<Lecture>`). Substitute your own; do not commit real ones." Every
  worked example in every file follows this — `<Course>`, `<Subject>`, `<Lecture>`, generic
  tissue/anatomy examples, never a real course code or institution name.
  `README.md`: "Course material is not in this repo... `.gitignore` is a whitelist — assume
  anything you add outside the allowed paths will not commit, and never work around that."
- **Claims are backed by a specific, measured incident, never an adjective.** Every rule of any
  weight in these documents is followed by a concrete number and what actually happened, not a
  qualitative assurance — "24 of 31 cards," "37 cards... rewritten to 21," "11 facets across 125
  cards against a plan that named 93," "one 228-card sitting used the facet role in half the cards
  in its first block of 20 and in none at all by the seventh." No document read for this task uses
  marketing language, hedged qualifiers, or unearned superlatives.
- **Comments/prose explain *why* a rule exists (usually via the incident it followed), not what
  the next line does.** This matches this build's own stated rule 6 verbatim and should be
  enforced the same way in A.P.E.'s own code and docs.

Given this task's own standing rule that **nobody has said what "A.P.E." stands for, and no
expansion may be invented anywhere** — this is the same discipline applied to an even smaller
surface: don't manufacture specifics (a name, a rationale, an identity) that were never actually
settled, whether the gap is an acronym or a placeholder course name.

---

## Checkable rules for the A.P.E. code review

See `decisions_for_implementers` in this task's structured output for the consolidated,
review-ready list. They are reproduced here so this document is self-contained for anyone reading
it from disk rather than from the task result.

---

## Appendix A — the seven reference cards, with their annotations

(`.claude/skills/anki-cards/SKILL.md`, the file `method/3-cards.md` symlinks to.)

- **ref-01** — subject + answer, the workhorse.
- **ref-02** — a *visible* facet (`<u>function</u>` stays on the face, unclozed).
- **ref-03** — an either/or choice wears `<u>`; the value wears `<i>`.
- **ref-04** — an inline set is **one** answer: three classes recalled together share one cloze
  rather than becoming three cards.
- **ref-05** — a list: numbers **outside** the cloze braces and unstyled, one item per line, every
  item on **one shared** cloze number, hint on item 1 only. The subject phrase spans a cloze
  boundary ("epiphyseal growth" clozed, "plate" left visible, in two separate `<b>` runs) so the
  hint still reads.
- **ref-06** — a recognition card: the image *is* a cloze, with **no hint**, and **no `<b>` at
  all**.
- **ref-07** — the same card with the image **not** clozed — one card instead of two.

Common to all seven, stated as the thing worth reading them for beyond their markup: "every
subject is a **specific named entity**... and each card states **one property of it**. Not one has
a topic heading in the subject slot."

The `ref-06` vs. `ref-07` choice is a real, per-deck decision, not a style preference: clozing the
image asks the fact both directions (name the tissue from the image, *and* produce the image from
the name) — worth it only when the image itself is the thing being taught (a diagram, a single
canonical picture). For a slide practical where dozens of different fields of view all answer the
same tissue name, `ref-06` wastes half the deck on a direction the exam never asks; a first pass
at one practical built 37 cards on `ref-06` and was rewritten to 21 on `ref-07`.

## Appendix B — verified test matrix (this task's fixtures)

All run with `python3` (3.14.0, stdlib only) against
`tools/render_review.py` from the source repo, fixtures and output kept in this session's
scratchpad (not committed anywhere):

| input | result |
|---|---|
| bare list of 5 notes (ref-01/03/05/06/07 shapes), `deckName` camelCase | exit 0; `<h1>` empty (see 1.3.1) |
| same notes wrapped `{"notes":[...]}}`, note 0 also carries `deck_name` | exit 0; `<h1>` populated |
| full AnkiConnect `{"action","version","params":{"notes":[...]}}}` | exit 0; identical article output to the bare-list case |
| `{"action":"addNotes","version":6,"params":{"notes":[]}}` | exit 0; "0 notes" |
| `{"unrelated":"blob"}` (no `params`, no `notes`) | exit 0; "0 notes", no warning |
| no args / 3+ args | exit 2; usage message on stderr |
| nonexistent input path | exit 1; `FileNotFoundError` traceback on stderr |
| malformed JSON | exit 1; `JSONDecodeError` traceback on stderr |
| note with no `fields` key | exit 1; `KeyError: 'fields'` traceback |
| note with `fields` but no `Text` key | exit 1; `KeyError: 'Text'` traceback |
| `<img src='single-quoted.jpg'>` | rewritten to `file://…/collection.media/single-quoted.jpg` |
| `<img src="http://example.com/remote.jpg">` | left untouched (colon in value blocks the match) |
| `<img src="already/nested/path.jpg">` | rewritten with full nested path preserved under `MEDIA_DIR` |
| `ANKI_MEDIA=./fake_media` (relative override) | produced `file://./fake_media/...` — a non-absolute `file://` URL |
| ref-05-shaped shared-cloze list, `c2` front face | all 5 list items blanked at once; item 1 shows `[which?]`, items 2-5 show `[…]` each |
