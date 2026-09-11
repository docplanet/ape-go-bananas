// Every regex from check_deck.py / render_review.py, transcribed verbatim from contract §3.
// Kept as one file so a reviewer can diff this against the contract's regex list directly,
// rather than hunting them down spread across the rule implementations.
//
// A shared module-level RegExp with the `g`/`gm` flag is safe to reuse across calls ONLY via
// stateless idioms - String#match, String#matchAll, String#replace, String#split - never a
// manual, stateful `.exec()`/`.test()` loop on the same object (that would leak `lastIndex`
// across unrelated calls). Every call site in this module sticks to those stateless idioms;
// see the individual usage comments below for which pattern is safe for which.

/** {{cN::BODY}} - BODY stops at the first "}}", so a cloze can never straddle the next one. */
export const CLOZE_RE = /\{\{c(\d+)::((?:(?!\}\})[\s\S])*)\}\}/g;

/** A hint that is a question of its own, not a slot: opens with a question word and carries its
 *  own verb ("what is it?", "what happens?"). Non-global, one-shot .test(). Contract §3.1 / rule 10b. */
export const CLAUSE_HINT_RE = /^(?:what|which|who|where|when|why|how)\b[\s\S]*\b(?:is|are|was|were|do|does|did|happen|happens|happened)\b/i;

/** One <img ...> opening tag. Global: safe via .match()/.replace() (see file header). */
export const IMAGE_TAG_RE = /<img\b[^>]*>/g;
/** The same pattern, non-global, for a one-shot boolean "does this contain an <img>" test. */
export const IMAGE_TAG_TEST_RE = /<img\b[^>]*>/;

/** An <img> tag's quoted src value (check_deck.py's own copy - not render_review.py's). */
export const IMAGE_SRC_RE = /<img\b[^>]*\bsrc=["']([^"']+)["']/;

/** render_review.py's own IMAGE_SRC: captures the "<img ... src=" prefix separately, and
 *  excludes ":" from the filename class - see docs/research/render-review-and-conventions.md
 *  §1.5 for why that (not a deliberate scheme check) is what leaves an absolute/data/file URL
 *  untouched. A genuinely different pattern from check_deck's, not a shared constant. */
export const RENDER_IMAGE_SRC_RE = /(<img\b[^>]*\bsrc=)["']([^"':]+)["']/g;

/** The slide-viewer's own "?z=" / "&z=" query parameter - first occurrence only (.exec). */
export const LINK_ZOOM_RE = /[?&]z=([\d.]+)/;
/** Every "50x"-shaped claim in raw Extra - lowercase x only, no re.I equivalent. */
export const MAGNIFICATION_RE = /\b(\d+)x\b/g;

/** First "source:" label in already-normalized (lowercased) text, to end of string. */
export const SOURCE_LABEL_RE = /source:\s*([\s\S]*)/;
export const OPEN_QUOTE = '"\'';

/** "..." / the ellipsis glyph / a "[...]" span - the pieces a Source quote is split on. */
export const QUOTE_GAP_RE = /\.\.\.|…|\[[^\]]*\]/;

/** WebVTT ("00:00:03.580 --> ...") and Zoom-plain-text ("00:00 --> ...") cue-timing lines. */
export const TIMESTAMP_RE = /^\d{1,2}:\d{2}(:\d{2})?[.,]?\d*\s*-->/;
/** A line that is nothing but a WebVTT/SRT numeric cue index. */
export const CUE_INDEX_RE = /^\d+$/;
/** A leading "Speaker Name: " prefix - capped at 40 chars so it never eats mid-sentence prose. */
export const SPEAKER_RE = /^[^:]{1,40}:\s/;

/** One note tag, full-string: "fact::F12" (capital F, case-sensitive). */
export const FACT_TAG_RE = /^fact::(F\d+)$/;
/** One inventory table row per line: "| 12 | rest of the row |". */
export const INVENTORY_ROW_RE = /^\|\s*(\d+)\s*\|(.*)$/gm;
/** A "slide::lecture-014" tag, full-string - digits after the LAST hyphen. */
export const SLIDE_TAG_RE = /^slide::.+-(\d+)$/;

/** The literal role-tag-wraps-a-cloze shape: <b>/<i>/<u> immediately ahead of "{{cN". */
export const ROLE_WRAPS_CLOZE_RE = /<[biu]>[^<]*\{\{c\d/;
/** Does this cloze value carry at least one role tag (<b>, <i>, or <u>)? */
export const HAS_ROLE_TAG_RE = /<[biu]>/;
/** Any HTML tag - used both as a space-strip and (elsewhere) an empty-strip; see call sites. */
export const ANY_TAG_RE = /<[^>]+>/g;
/** Every individual <b>...</b> span, non-greedy, so adjacent bolds never fuse into one match. */
export const BOLD_SPAN_NONGREEDY_RE = /<b>[\s\S]*?<\/b>/g;
/** A possessive outside of any bolded subject. Contract §11 hazard 7 flags that Python's
 *  `\w` is Unicode-aware by default while JS's is ASCII-only, and requires a CONSCIOUS
 *  choice between the two, not an accident - this picks the Unicode-matching form (Python's
 *  own default), since the narrower ASCII-only form silently opens the gate on exactly the
 *  eponyms and loanwords (an accented "café's", say) most likely to need it, which is a
 *  weaker check than the port is supposed to replicate, not a stronger one. `\w` for a
 *  Python str is `[a-zA-Z0-9_]` plus every Unicode letter/digit/mark, i.e. roughly
 *  `\p{L}\p{N}\p{M}_` - see differential.test.ts's rule-14 cases for the ASCII form this
 *  must still catch. */
export const POSSESSIVE_RE = /[\p{L}\p{N}\p{M}_]'s\s/u;
/** A <b>...</b> run that itself stops at the first "</b>" (mirrors CLOZE's own technique). */
export const BOLD_RUN_RE = /<b>(?:(?!<\/b>)[\s\S])*<\/b>/g;
/** &nbsp; or any whitespace - stripped from a bold-to-bold gap to test if real prose remains. */
export const NBSP_OR_SPACE_RE = /&nbsp;|\s/g;
/** The numbered-list guard: does the tag-stripped text begin a line with "N."? */
export const NUMBERED_LIST_GUARD_RE = /^\s*\d\./m;
/** Negation/contrast language inside a cloze blank - case-insensitive; only not/never are
 *  word-bounded (so "cannot" does not match \bnot\b). */
export const NEGATION_RE = /\bnot\b|\bnever\b|rather than|instead of|unlike/i;
/** A bolded subject that is ALSO wrapped in its own cloze - the deck-wide "never clozed" test. */
export const CLOZED_BOLD_SUBJECT_RE = /\{\{c\d+::<b>/;
