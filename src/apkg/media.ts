// Media collection -- docs/research/apkg-format.md §3 and §10. Scans every
// note's Text/Extra fields (not Source -- doc §10's own contract phrasing)
// for <img|audio|video|object|source ... src|data="X"> references, and
// builds the {"<0-based index>": "<real filename>"} manifest plus the raw
// bytes for each numbered zip member.
//
// This exporter's contract mirrors tools/check_deck.py's own media check:
// deck.json reaching here is assumed already validated (every referenced
// file exists in the media directory) -- that check runs upstream of this
// exporter, not inside it (doc §10). Consequently a reference this exporter
// can't find on disk (ENOENT, even after the NFD fallback below) is left out
// of the manifest rather than aborting the whole export: nothing in the
// notes/cards logic depends on a media file's actual bytes, and test/apkg's
// own notes.test.ts and cloze-ordinals.test.ts deliberately reuse
// ref-06/ref-07's <img src="slide.jpg"> text without providing that file
// (they're exercising sfld/csum and cloze-ordinal behavior, not media
// embedding) -- so writeApkg must not throw merely because a referenced name
// has no file backing it in a given run. A note whose media genuinely went
// missing is check_deck.py's failure mode to catch, upstream of here; this
// module's job is only to not make that failure *invisible* once it reaches
// here anyway -- collectMedia reports every such name back on `unresolved`
// (see index.ts) instead of dropping it into a void.
//
// Reading is the caller's job (media-node.ts under Node, a directory handle
// in a browser): this module decides *which* names a deck references and
// what happens when one cannot be read, never how to read one.

import type { DeckNote } from '../types.js';
import { extractMediaFilenames } from './text.js';

/**
 * Supplies the bytes behind one referenced filename, or undefined when there
 * is genuinely no such file. Anything else -- a file that exists but cannot
 * be read, a name shaped like a path-traversal attempt -- must throw rather
 * than return undefined; media-node.ts explains why that distinction is the
 * whole contract.
 */
export type MediaReader = (filename: string) => Uint8Array | undefined;

export interface MediaFile {
  /** The real filename Anki should use in collection.media on import. */
  filename: string;
  bytes: Uint8Array;
}

export interface MediaCollectionResult {
  /** {"0": "first.jpg", "1": "second.png", ...} -- doc §3. */
  manifest: Record<string, string>;
  /** files[i]'s filename is manifest[String(i)]; same order. */
  files: MediaFile[];
  /**
   * Filenames some note referenced but that had no readable file behind
   * them (checked directly, then via the reader's own fallbacks) --
   * first-occurrence order, matching `files`' ordering convention. Empty
   * when every reference resolved. The caller (writeApkg, index.ts) puts
   * this on its own result rather than swallowing it.
   */
  unresolved: string[];
}

/**
 * Distinct media filenames referenced across all notes' Text/Extra, in
 * first-occurrence order, then the numbered manifest plus each file's
 * bytes from `readMedia`. 0-based, contiguous numbering matches every
 * real sample (doc §3) -- the importer's own parser doesn't require
 * contiguity, but this is the tested, conventional shape. A referenced
 * filename with no readable file behind it is left out of both the
 * manifest and `files`, same as before, but is no longer dropped silently:
 * it's named on `unresolved` instead (see the file header). A filename
 * shaped like a path-traversal attempt is not caught here -- it throws,
 * out of the reader -- so this loop only ever needs to handle the
 * "genuinely not found" outcome.
 */
export function collectMedia(notes: DeckNote[], readMedia: MediaReader): MediaCollectionResult {
  const seen = new Set<string>();
  const order: string[] = [];

  for (const note of notes) {
    for (const html of [note.fields.Text, note.fields.Extra]) {
      for (const filename of extractMediaFilenames(html)) {
        if (!seen.has(filename)) {
          seen.add(filename);
          order.push(filename);
        }
      }
    }
  }

  const manifest: Record<string, string> = {};
  const files: MediaFile[] = [];
  const unresolved: string[] = [];
  for (const filename of order) {
    const bytes = readMedia(filename);
    if (bytes === undefined) {
      unresolved.push(filename);
      continue;
    }
    manifest[String(files.length)] = filename;
    files.push({ filename, bytes });
  }

  return { manifest, files, unresolved };
}
