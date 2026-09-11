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

import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

/** One {filename, path} of a deck's own media list (deck-json.ts DeckMediaRef, without the import cycle). */
export interface MediaMapEntry {
  filename: string;
  path: string;
}

/**
 * Where the bytes for `filename` are: the deck's own media list first (the
 * name the field uses, mapped to the file under _extracted/ or wherever the
 * writer put it), then each directory in order. Undefined when nowhere.
 * Only the list's own paths may leave a directory; a filename with a
 * directory part is refused, as tryReadMediaBytes refuses it.
 */
export function resolveMediaFile(filename: string, media: MediaMapEntry[], dirs: string[]): string | undefined {
  if (!isBareFilename(filename)) {
    throw new Error(`media reference is not a bare filename, refusing to read outside mediaDir: ${JSON.stringify(filename)}`);
  }
  const mapped = media.find((m) => m.filename === filename || m.filename.normalize('NFC') === filename.normalize('NFC'));
  if (mapped !== undefined && existsSync(mapped.path)) return mapped.path;
  for (const dir of dirs) {
    const direct = join(dir, filename);
    if (existsSync(direct)) return direct;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      continue;
    }
    const match = entries.find((entry) => entry.normalize('NFC') === filename.normalize('NFC'));
    if (match !== undefined) return join(dir, match);
  }
  return undefined;
}

/** A MediaReader over the deck's own media list, then the given directories in order. */
export function mappedMediaReader(media: MediaMapEntry[], dirs: string[]): MediaReader {
  return (filename) => {
    const path = resolveMediaFile(filename, media, dirs);
    if (path === undefined) return undefined;
    try {
      return readFileSync(path);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      return undefined;
    }
  };
}

/**
 * The media-existence predicate for checkDeck (rule 2) when a deck carries
 * its own media list: the rule asks about `join(mediaDir, filename)`; the
 * answer is yes when the list, that path, or any of `dirs` has the file.
 */
export function mappedMediaExists(media: MediaMapEntry[], dirs: string[]): (path: string) => boolean {
  return (path) => existsSync(path) || resolveMediaFile(basename(path), media, dirs) !== undefined;
}
