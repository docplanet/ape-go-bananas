// One "cannot read X: Y" wrapping, reused everywhere this CLI reads a file
// path a user typed on the command line -- deck.json (deck-loader.ts),
// --transcript, and --inventory (check.ts) all report a missing/unreadable
// file the same way, matching check-deck-contract.md §1.6's message
// template in every one of its three trigger rows.
import { readFileSync } from 'node:fs';

export function readFileOrThrow(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${path}: ${(err as Error).message}`);
  }
}
