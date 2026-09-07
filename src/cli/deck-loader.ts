// deck.json loading -- check-deck-contract.md §2's exact three accepted
// top-level shapes and the one per-note guarantee load() makes before
// handing notes to anything else. Neither the checks module nor the apkg
// module owns this: both take DeckNote[] as a given, already-validated
// input (src/types.ts's own header: deck.json is "LLM-authored... untrusted
// input, not something this module validates on the way in"). This is that
// validation, lifted from tools/check_deck.py's load() (lines 417-432) since
// every subcommand needs the same three-shape unwrap and there is nowhere
// else in this repo it belongs.
//
// render_review.py has no equivalent guard of its own -- a missing `fields`
// or `fields.Text` there is an uncaught KeyError with a Python traceback
// (render-review-and-conventions.md §1.3). Reusing check_deck.py's stricter,
// friendlier load() for `review` and `export` too, rather than reproducing
// two different failure styles, is a deliberate choice: this CLI is a new
// tool, not a byte-for-byte port of either original, and one clear error
// path for a malformed deck.json is strictly better than matching a
// traceback no Node process would ever produce the same way regardless.
import type { DeckNote } from '../types.js';
import { readFileOrThrow } from './read-file.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads and validates one deck.json. Throws a plain Error, message shaped
 * exactly like check-deck-contract.md §1.6's SystemExit templates (the
 * embedded system-error text itself is Node's own, not Python's -- the
 * contract's own §1.6 already flags that text as implementation-specific
 * and not part of what a port owes byte-identically); index.ts's top-level
 * catch turns any such Error into that message on stderr and exit 1.
 */
export function loadDeckNotes(path: string): DeckNote[] {
  const raw = readFileOrThrow(path);

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }

  // data.get("params", data).get("notes", []) -- a dict with no "params" key
  // falls back to itself (shape 2: {"notes": [...]}); a dict with "params"
  // uses that value instead (shape 3: the AnkiConnect payload). Python
  // raises an uncaught AttributeError if params is present but not itself
  // dict-shaped, a case the contract (§2) explicitly leaves without a
  // message template of its own -- a plain Error here still lands on exit
  // 1, same as every other load failure, without pretending to know text
  // Python's runtime alone produces.
  let notes: unknown = data;
  if (isPlainObject(data)) {
    const params = 'params' in data ? data.params : data;
    if (!isPlainObject(params)) {
      throw new Error(`${path}: params is present but is not an object`);
    }
    notes = 'notes' in params ? params.notes : [];
  }

  if (!Array.isArray(notes)) {
    throw new Error(`${path}: expected a list of notes`);
  }

  notes.forEach((note, i) => {
    const fields = isPlainObject(note) ? note.fields : undefined;
    if (!isPlainObject(note) || !isPlainObject(fields) || !('Text' in fields)) {
      throw new Error(`${path}: note ${i + 1} has no fields.Text`);
    }
  });

  return notes as DeckNote[];
}
