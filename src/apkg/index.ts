// Public API: writeApkg(notes, {deckName, outPath, mediaDir, clock}) --
// assembles collection.anki21 (collection.ts), the media manifest and
// numbered media members (media.ts), and packs them into a ZIP (zip.ts).
// See docs/research/apkg-format.md §1 for why this writes exactly
// collection.anki21 + media (+ numbered media files) and nothing else --
// no `meta` member, no legacy collection.anki2 stub.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DeckNote, NoteFields } from '../types.js';
import { buildCollection } from './collection.js';
import { collectMedia } from './media.js';
import { buildZip, type ZipEntryInput } from './zip.js';

export interface WriteApkgOptions {
  /** Every note passed to a given call is written into this one deck. */
  deckName: string;
  outPath: string;
  /** Must exist; referenced media files are read from here (doc §10). */
  mediaDir: string;
  /**
   * epoch-ms "now". Defaults to real time in production. Every id,
   * mod/crt/scm timestamp, and note guid this exporter writes is derived
   * from this value (and this call's own counter state) -- never a fresh
   * Date.now()/Math.random()/crypto.randomUUID() call -- so two calls with
   * the same clock and the same notes produce byte-identical output.
   */
  clock?: () => number;
}

export interface WriteApkgResult {
  /**
   * Filenames some note referenced (via <img>/<audio>/... in Text/Extra)
   * that had no readable file behind them in mediaDir -- collectMedia's own
   * `unresolved`, passed through here rather than dropped (media.ts). Empty
   * when every reference resolved. check_deck.py's media check is expected
   * to have already caught this upstream of writeApkg (doc §10); this is a
   * second, cheap line of visibility for whatever a given run actually
   * found, not a replacement for that check -- the package is still
   * written either way, just missing these files' bytes.
   */
  unresolvedMedia: string[];
}

const NOTE_FIELD_NAMES: readonly (keyof NoteFields)[] = ['Text', 'Extra', 'Source'];

/**
 * Writes a `.apkg` file containing exactly one deck's worth of notes and
 * cards: schema-11 SQLite (collection.anki21), a JSON media manifest, and
 * the referenced media files, deflate/store zipped per docs/research/apkg-format.md.
 *
 * A plain (non-`async`) function: every step here -- SQLite writes, media
 * reads, deflate, the final file write -- is synchronous, so an `async`
 * signature would only have claimed to yield the event loop without ever
 * doing so. `await writeApkg(...)` still works at every call site (`await`
 * on a non-Promise value resolves to that value immediately).
 *
 * Validates its own inputs before doing any work, rather than letting a
 * malformed note or a bad clock surface as a raw TypeError/RangeError from
 * deep inside collection.ts/ids.ts with no indication of which note or
 * option was at fault -- deck.json (the usual source of `notes`) is
 * LLM-authored, not a trusted, statically-typed value, so the declared
 * DeckNote[]/WriteApkgOptions types are a contract this function checks
 * rather than one it's entitled to assume.
 */
export function writeApkg(notes: DeckNote[], options: WriteApkgOptions): WriteApkgResult {
  const clock = options.clock ?? Date.now;
  const clockMs = clock();
  // Every id/guid this exporter writes derives from clockMs via BigInt()
  // (ids.ts) -- a non-integer reaches that conversion as an unlabeled
  // RangeError, so it's caught here instead, named to the actual option at
  // fault.
  if (!Number.isInteger(clockMs)) {
    throw new RangeError(`options.clock() must return an integer epoch-ms value, got ${clockMs}`);
  }
  notes.forEach((note, index) => {
    for (const field of NOTE_FIELD_NAMES) {
      if (typeof note.fields?.[field] !== 'string') {
        throw new TypeError(`notes[${index}].fields.${field} must be a string, got ${typeof note.fields?.[field]}`);
      }
    }
  });

  const media = collectMedia(notes, options.mediaDir);
  const dbBytes = buildCollection(notes, { deckName: options.deckName, clockMs });

  const entries: ZipEntryInput[] = [
    { name: 'collection.anki21', data: dbBytes, method: 'deflate' },
    { name: 'media', data: Buffer.from(JSON.stringify(media.manifest), 'utf8'), method: 'deflate' },
    // Stored, not deflated -- doc §2: these are already-compressed
    // image/audio formats in every real sample, so deflating them again
    // buys nothing.
    ...media.files.map((file, index): ZipEntryInput => ({ name: String(index), data: file.bytes, method: 'store' })),
  ];

  mkdirSync(dirname(options.outPath), { recursive: true });
  writeFileSync(options.outPath, buildZip(entries));

  return { unresolvedMedia: media.unresolved };
}
