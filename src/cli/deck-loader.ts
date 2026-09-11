// deck.json loading: src/deck-json.ts's validation over a file on disk.
// The three accepted shapes, the per-note guarantee and the message formats
// all live there; this adds the read and nothing else.

import { dirname, isAbsolute, resolve } from 'node:path';
import type { DeckNote } from '../types.js';
import { parseDeckMedia, parseDeckNotes, type DeckMediaRef } from '../deck-json.js';
import { readFileOrThrow } from './read-file.js';

export { parseDeckNotes, parseDeckMedia } from '../deck-json.js';
export type { DeckMediaRef } from '../deck-json.js';

/** The deck's own media list, every path made absolute against the deck file's folder. */
export function loadDeckMedia(path: string): DeckMediaRef[] {
  const dir = dirname(path);
  return parseDeckMedia(readFileOrThrow(path), path).map((m) => ({ filename: m.filename, path: isAbsolute(m.path) ? m.path : resolve(dir, m.path) }));
}

/**
 * Reads and validates one deck.json. Throws a plain Error, message shaped
 * exactly like check-deck-contract.md §1.6's SystemExit templates; index.ts's
 * top-level catch turns any such Error into that message on stderr and exit 1.
 */
export function loadDeckNotes(path: string): DeckNote[] {
  return parseDeckNotes(readFileOrThrow(path), path);
}
