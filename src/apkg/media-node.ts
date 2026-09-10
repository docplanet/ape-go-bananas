// The Node half of the media seam (media.ts): reading one referenced
// filename out of a real Anki media directory on disk.
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
import type { MediaReader } from './media.js';

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
function tryReadMediaBytes(mediaDir: string, filename: string): Uint8Array | undefined {
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

/** A MediaReader over a real media directory. */
export function nodeMediaReader(mediaDir: string): MediaReader {
  return (filename) => tryReadMediaBytes(mediaDir, filename);
}
