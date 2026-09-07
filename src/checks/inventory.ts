// The fact/inventory checks - contract §3.3 and the unbacked()/foreign()/stem() mechanics.
// A card face is bound to an extracted fact ("Faithfulness binds facts, never words"); this
// module is what turns that rule into: which fact ids a card cites, whether they exist,
// and which face words those cited facts' own text cannot back.
import type { DeckNote } from '../types.js';
import { FACT_TAG_RE, INVENTORY_ROW_RE } from './regex.js';
import { normalize, words } from './text.js';
import { flattenClozes } from './cloze.js';

const FACT_ROW_CELLS = 5;
const STEM_SUFFIXES = ['ing', 'ies', 'ed', 'es', 's', 'ly'] as const;

/** A crude suffix-stripping stem: only strips a suffix when >= 4 characters remain, so
 *  short words ("is", "was") are never over-stemmed. Stems are compared instead of raw
 *  words so "absorbs" backs an inventory row that only ever wrote "absorbed". */
export function stem(word: string): string {
  for (const suffix of STEM_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
      return word.slice(0, word.length - suffix.length);
    }
  }
  return word;
}

/**
 * {fact id -> the normalized words of that row} - contract §3.3's load_inventory(). A row
 * only counts if it has at least FACT_ROW_CELLS pipe characters, which is what keeps the
 * coverage table at the foot of an inventory (its own bare-number rows) from being
 * misread as facts F1..F28.
 */
export function loadInventory(rawText: string): Map<string, Set<string>> {
  const facts = new Map<string, Set<string>>();
  for (const match of rawText.matchAll(INVENTORY_ROW_RE)) {
    const number = match[1];
    const rest = match[2];
    if (rest.split('|').length - 1 < FACT_ROW_CELLS) continue;
    const key = `F${number}`;
    let row = facts.get(key);
    if (!row) {
      row = new Set<string>();
      facts.set(key, row);
    }
    for (const w of words(normalize(rest))) row.add(w);
  }
  return facts;
}

// Re-wording is the point of step 3, so most new face words are legitimate and this list
// can only ever be reported, never failed. These are the connective/filler words that
// carried the invented claims that motivated this check - copied verbatim from
// check_deck.py's FUNCTION_WORDS so the two stay in lockstep by construction.
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'also', 'already', 'another', 'because', 'become', 'becomes', 'been', 'before', 'being',
  'between', 'both', 'called', 'came', 'come', 'comes', 'does', 'doing', 'each', 'either',
  'from', 'give', 'gives', 'have', 'held', 'hold', 'holds', 'into', 'just', 'keep', 'keeps',
  'kind', 'leave', 'leaves', 'left', 'lies', 'like', 'made', 'make', 'makes', 'many', 'more',
  'most', 'much', 'must', 'name', 'named', 'names', 'need', 'needs', 'only', 'other', 'over',
  'part', 'puts', 'reach', 'run', 'runs', 'same', 'seen', 'sits', 'some', 'such', 'take',
  'taken', 'takes', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'toward', 'under', 'until', 'used', 'uses', 'very', 'were', 'what',
  'when', 'where', 'which', 'while', 'will', 'with', 'within', 'without',
]);

/**
 * [structural problems, novel face words] for one note against the inventory - contract
 * §5.1 rules 5a/5b and §7 item 7's unbacked(). `cited` is read from the note's own
 * `fact::F<n>` tags; a missing tag, or a cited id absent from the inventory, short-circuits
 * with the structural message(s) and no novel-word list. Otherwise: `backing` is every
 * cited fact row's own words (stemmed) plus the note's own Extra (also stemmed - the
 * card's own Source quote counts as evidence too), and `novel` is every de-duplicated,
 * length > 2, non-function face word (cloze hints flattened away first) whose stem is not
 * in `backing`.
 */
export function unbacked(note: DeckNote, inventory: Map<string, Set<string>>): [string[], string[]] {
  const cited: string[] = [];
  for (const tag of note.tags ?? []) {
    const m = FACT_TAG_RE.exec(tag);
    if (m) cited.push(m[1]);
  }
  if (cited.length === 0) {
    return [['carries no fact:: tag; a card face is bound to an extracted fact'], []];
  }
  const unknown = cited.filter((f) => !inventory.has(f));
  if (unknown.length > 0) {
    return [unknown.map((f) => `cites ${f}, which is not in the inventory`), []];
  }

  const backing = new Set<string>();
  for (const f of cited) {
    for (const w of inventory.get(f) ?? []) backing.add(stem(w));
  }
  for (const w of words(normalize(note.fields.Extra ?? ''))) backing.add(stem(w));

  const face = words(normalize(flattenClozes(note.fields.Text)));
  const seen = new Set<string>();
  const novel: string[] = [];
  for (const w of face) {
    if (seen.has(w)) continue;
    seen.add(w);
    if (w.length > 2 && !FUNCTION_WORDS.has(w) && !backing.has(stem(w))) {
      novel.push(w);
    }
  }
  return [[], novel];
}

/**
 * Face words that appear nowhere in the WHOLE inventory, not merely outside this card's
 * own cited facts - contract §7 item 8's foreign(). `everything` is precomputed once per
 * deck (every fact row's stemmed words) and passed in, not recomputed per note.
 */
export function foreign(note: DeckNote, inventory: Map<string, Set<string>>, everything: ReadonlySet<string>): string[] {
  const [, novel] = unbacked(note, inventory);
  return novel.filter((w) => !everything.has(stem(w)));
}
