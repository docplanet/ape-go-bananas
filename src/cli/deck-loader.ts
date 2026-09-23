// deck.json loading: src/deck-json.ts's validation over a file on disk.
// The three accepted shapes, the per-note guarantee and the message formats
// all live there; this adds the read and nothing else.

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { DeckNote } from '../types.js';
import { parseDeckMedia, parseDeckNotes, type DeckMediaRef } from '../deck-json.js';
import { readFileOrThrow } from './read-file.js';

export { parseDeckNotes, parseDeckMedia } from '../deck-json.js';
export type { DeckMediaRef } from '../deck-json.js';

function within(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The deck's own media list, every path made absolute against the deck file's
 * folder, and every one inside it. deck.json is written by an agent reading
 * the lecture, and whatever a media entry names is read, packed into the
 * .apkg and put into the Anki collection -- which syncs. An entry naming a
 * file outside the deck's folder (a key, a config, anything readable) is
 * refused like any other malformed entry, links resolved first so one inside
 * the folder cannot point out of it.
 */
export function loadDeckMedia(path: string): DeckMediaRef[] {
  const dir = dirname(path);
  const root = existsSync(dir) ? realpathSync(dir) : resolve(dir);
  return parseDeckMedia(readFileOrThrow(path), path).map((m, i) => {
    const abs = isAbsolute(m.path) ? m.path : resolve(dir, m.path);
    const inside = existsSync(abs) ? within(root, realpathSync(abs)) : within(resolve(dir), abs);
    if (!inside) throw new Error(`${path}: media entry ${i + 1} path is outside the deck's folder: ${JSON.stringify(m.path)}`);
    return { filename: m.filename, path: abs };
  });
}

/**
 * Reads and validates one deck.json. Throws a plain Error, message shaped
 * exactly like check-deck-contract.md §1.6's SystemExit templates; index.ts's
 * top-level catch turns any such Error into that message on stderr and exit 1.
 */
export function loadDeckNotes(path: string): DeckNote[] {
  return parseDeckNotes(readFileOrThrow(path), path);
}
