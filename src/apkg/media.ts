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
// "Not found" is the ONLY failure this module tolerates. Anything else --
// permission denied, the name turning out to be a directory, too many open
// files -- means a file that check_deck.py's `os.path.exists` upstream
// check would have already seen exists, but this exporter still can't read;
// that upstream guarantee doesn't cover those cases, so treating them the
// same as "not found" would silently ship a package with broken media and
// no error anywhere. Those are rethrown instead.
//
// Field text driving all of this is LLM-authored, not a trusted source of
// filesystem paths -- see isBareFilename below for why a name is validated
// before it's ever joined onto mediaDir.

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DeckNote } from '../types.js';
import { extractMediaFilenames } from './text.js';

export interface MediaFile {
  /** The real filename Anki should use in collection.media on import. */
  filename: string;
  bytes: Buffer;
}

export interface MediaCollectionResult {
  /** {"0": "first.jpg", "1": "second.png", ...} -- doc §3. */
  manifest: Record<string, string>;
  /** files[i]'s filename is manifest[String(i)]; same order. */
  files: MediaFile[];
  /**
   * Filenames some note referenced but that had no readable file behind
   * them in mediaDir (checked directly, then via the NFC/NFD fallback) --
   * first-occurrence order, matching `files`' ordering convention. Empty
   * when every reference resolved. The caller (writeApkg, index.ts) puts
   * this on its own result rather than swallowing it.
   */
  unresolved: string[];
}

// A media filename is always a bare name -- one path segment, no directory
// component -- doc §3, and exactly what Anki's own importer enforces on the
// way in (safe_normalized_file_name, cited there). `join(mediaDir, name)`
// only neutralizes a *leading* "/" (it doesn't reset to root the way
// `resolve` would); it does nothing at all against a "../" segment, which
// resolves straight out of mediaDir. Since the note text naming this file
// is LLM-authored rather than trusted, that check has to happen here, not
// be assumed away: `basename(name) !== name` is true for any name carrying
// a path separator, a leading "/", or a ".." segment, i.e. for anything
// that isn't already a single bare component.
function isBareFilename(filename: string): boolean {
  return basename(filename) === filename;
}

function isNotFoundError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * Returns undefined when `filename` genuinely doesn't exist under
 * `mediaDir` (ENOENT). Throws for a filename shaped like a path-traversal
 * attempt (see isBareFilename) and for any other read failure (permission
 * denied, a directory of the same name, ...) -- see the file header for why
 * only "not found" is this function's business to swallow.
 */
function tryReadMediaBytes(mediaDir: string, filename: string): Buffer | undefined {
  if (!isBareFilename(filename)) {
    throw new Error(
      `media reference is not a bare filename, refusing to read outside mediaDir: ${JSON.stringify(filename)}`,
    );
  }

  try {
    return readFileSync(join(mediaDir, filename));
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    // doc §3: macOS hands back NFD-normalized names from a directory
    // listing even when the field text (typically typed/pasted as NFC)
    // doesn't match byte-for-byte. Fall back to a normalized scan of the
    // directory before giving up -- untested by this suite (its one media
    // fixture, slide.jpg, is plain ASCII and never exercises this branch),
    // but cheap, documented insurance for a real accented filename.
    let entries: string[];
    try {
      entries = readdirSync(mediaDir);
    } catch (dirErr) {
      if (!isNotFoundError(dirErr)) throw dirErr;
      return undefined;
    }
    const match = entries.find((entry) => entry.normalize('NFC') === filename);
    if (match === undefined) return undefined;
    try {
      return readFileSync(join(mediaDir, match));
    } catch (matchErr) {
      if (!isNotFoundError(matchErr)) throw matchErr;
      return undefined;
    }
  }
}

/**
 * Distinct media filenames referenced across all notes' Text/Extra, in
 * first-occurrence order, then the numbered manifest plus each file's
 * bytes read from `mediaDir`. 0-based, contiguous numbering matches every
 * real sample (doc §3) -- the importer's own parser doesn't require
 * contiguity, but this is the tested, conventional shape. A referenced
 * filename with no readable file behind it is left out of both the
 * manifest and `files`, same as before, but is no longer dropped silently:
 * it's named on `unresolved` instead (see the file header). A filename
 * shaped like a path-traversal attempt is not caught here -- it throws,
 * out of tryReadMediaBytes -- so this loop only ever needs to handle the
 * "genuinely not found" outcome.
 */
export function collectMedia(notes: DeckNote[], mediaDir: string): MediaCollectionResult {
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
    const bytes = tryReadMediaBytes(mediaDir, filename);
    if (bytes === undefined) {
      unresolved.push(filename);
      continue;
    }
    manifest[String(files.length)] = filename;
    files.push({ filename, bytes });
  }

  return { manifest, files, unresolved };
}
