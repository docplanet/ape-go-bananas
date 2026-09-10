// deck.json loading: src/deck-json.ts's validation over a file on disk.
// The three accepted shapes, the per-note guarantee and the message formats
// all live there; this adds the read and nothing else.

import type { DeckNote } from '../types.js';
import { parseDeckNotes } from '../deck-json.js';
import { readFileOrThrow } from './read-file.js';

export { parseDeckNotes } from '../deck-json.js';

/**
 * Reads and validates one deck.json. Throws a plain Error, message shaped
 * exactly like check-deck-contract.md §1.6's SystemExit templates; index.ts's
 * top-level catch turns any such Error into that message on stderr and exit 1.
 */
export function loadDeckNotes(path: string): DeckNote[] {
  return parseDeckNotes(readFileOrThrow(path), path);
}
