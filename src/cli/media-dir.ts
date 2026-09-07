// The one media-directory convention shared by check_deck.py and
// render_review.py, both quoted verbatim in docs/research (check-deck-
// contract.md §1.3, render-review-and-conventions.md §1.5) and both
// module-level constants computed the same way. Every subcommand that
// touches media -- `check` (gated by --no-media), `review`, and `export`
// (when --media-dir is omitted) -- resolves it through this one function so
// "the collection" means the same directory everywhere in this CLI.
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function expanduser(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

// The macOS-style path is tried first regardless of the actual host OS --
// this is a filesystem existence probe, not a platform check (contract
// §1.3). Computed once, at module load, matching the Python originals'
// own module-level MEDIA_DIR constant.
const DEFAULT_MEDIA_MAC = expanduser('~/Library/Application Support/Anki2/User 1/collection.media');
const DEFAULT_MEDIA_LINUX = expanduser('~/.local/share/Anki2/User 1/collection.media');

export function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * ANKI_MEDIA, if set, wins outright and is used verbatim -- no expanduser,
 * no existence check at this point, exactly like the Python originals (a
 * literal "~" in ANKI_MEDIA is never expanded). Otherwise whichever of the
 * two hardcoded per-OS profile paths exists on disk, Mac path checked first.
 */
export function resolveMediaDir(): string {
  const override = process.env.ANKI_MEDIA;
  if (override !== undefined) return override;
  return existsSync(DEFAULT_MEDIA_MAC) && isExistingDirectory(DEFAULT_MEDIA_MAC) ? DEFAULT_MEDIA_MAC : DEFAULT_MEDIA_LINUX;
}
