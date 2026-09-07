// Distinct cloze-ordinal scanning -- docs/research/apkg-format.md §7, "the
// load-bearing rule": one card per distinct cloze NUMBER found anywhere in
// the note's fields, ord = number - 1, gaps preserved (never compacted,
// never renumbered). Getting this wrong silently drops or misnumbers cards,
// which is why cloze-ordinals.test.ts hand-counts every expected {ord} set
// rather than trusting any shared parsing code -- this module is exactly
// the code that test is trying to catch a mistake in.
//
// Deliberately the narrower dialect tools/check_deck.py already parses and
// this pipeline's decks are actually written in: {{cN::body}}, a single
// numeral, no comma-separated ordinals, no nesting. Real Anki's own
// cloze.rs is a strict superset (rslib/src/cloze.rs, per the doc) but
// neither extra feature appears anywhere in this pipeline's authoring
// rules -- see the doc's own scope note for why implementing only this
// dialect is a deliberate choice, not an oversight.

import type { NoteFields } from '../types.js';

// Only the opening "{{cN::" marker is needed to find which ordinals exist --
// the deletion body itself is irrelevant to how many cards get generated or
// at what `ord`, so this doesn't need to parse out to the matching "}}" the
// way tools/check_deck.py's own CLOZE regex does for its own purposes.
const CLOZE_OPEN_RE = /\{\{c(\d+)::/g;

// cardgen.rs's set is a HashSet<u16> (doc §7's quoted source) -- a cloze
// number that doesn't fit in u16 (0..=65535) was never actually inserted
// into that set by real Anki, so it must generate no card here either. This
// is a hard cutoff, not a clamp: nothing upstream of this module bounds the
// digits a `{{cN::` marker can carry (tools/check_deck.py's own CLOZE regex
// is `\{\{c(\d+)::`, same as this file's, and its only ordinal check is a
// "never more than three numbers" count, not a range check on any one of
// them), so a typo'd or malformed marker is the only thing this guards.
const MAX_CLOZE_NUMBER = 0xffff;

/**
 * Every distinct cloze number N found across Text, Extra, and Source,
 * ascending, excluding any N > 65535 (see MAX_CLOZE_NUMBER -- such an N
 * yields no card, not a card at some clamped ord). cardgen.rs's
 * cloze_number_in_fields scans ALL of a note's fields, not just the one a
 * template renders -- doc §7 cites this explicitly and
 * cloze-ordinals.test.ts's "cloze-in-extra-field" case exercises exactly
 * this: a {{c2::...}} sitting in Extra still yields a real second card.
 * Callers still need to map each returned number to `ord` themselves via
 * `saturating_sub(1).min(499)` (doc §7) -- this function only decides which
 * numbers exist, not what ord they land on -- and, because that mapping is
 * many-to-one at both ends (0 and 1 both floor to ord 0; anything >= 500
 * ceilings to ord 499), the caller must dedupe by *ord*, not assume the
 * distinct-numbers guarantee here still holds after the mapping.
 */
export function distinctClozeNumbers(fields: NoteFields): number[] {
  // Joined on a character that can never appear inside "{{cN::" (a newline
  // suffices) so a field boundary can never accidentally complete a cloze
  // marker split across two fields -- e.g. Text ending "...{{c1" with Extra
  // starting "::x}}..." must not read as a real cloze.
  const combined = [fields.Text, fields.Extra, fields.Source].join('\n');
  const found = new Set<number>();
  // A fresh RegExp per call avoids relying on resetting a shared /g
  // instance's lastIndex -- see text.ts's replaceMediaTags for the same
  // reasoning.
  const re = new RegExp(CLOZE_OPEN_RE.source, CLOZE_OPEN_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(combined))) {
    const number = Number(match[1]);
    if (number <= MAX_CLOZE_NUMBER) found.add(number);
  }
  return [...found].sort((a, b) => a - b);
}
