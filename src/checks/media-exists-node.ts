// The Node half of the media-existence seam (note.ts, rule 2).
//
// Kept out of note.ts so that src/checks has no node: imports at all: every
// other rule is a pure function of the note's own text, and rule 2 is the
// single exception that asks the host anything. A browser supplies its own
// predicate (a directory handle lookup) or leaves checkMedia off.

import { existsSync } from 'node:fs';

/** Rule 2's existence predicate over the real filesystem. */
export function nodeMediaExists(path: string): boolean {
  return existsSync(path);
}
