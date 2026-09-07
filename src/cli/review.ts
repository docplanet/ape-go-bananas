// `ape review` -- ports tools/render_review.py's main() (verified directly
// against that file in the engine repo): read deck.json, render one HTML
// page, write it, report the note count. Two intentional differences from
// the original, both cheap and both documented at the point they matter:
// deck.json validation goes through deck-loader.ts's stricter load()
// (see that file's header) instead of a bare KeyError, and the output path
// is given with `-o` rather than a second positional (this task's own
// spec) -- the default when `-o` is omitted is still render_review.py's own
// "review.html next to deck.json" convention (contract §1.2).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderReview } from '../checks/index.js';
import { requireOnePositional, takeSingle } from './args.js';
import { loadDeckNotes } from './deck-loader.js';
import { resolveMediaDir } from './media-dir.js';

const USAGE = 'usage: ape review <deck.json> [-o <out.html>]';

export function runReview(argv: string[]): number {
  const args = [...argv];
  if (args.includes('-h') || args.includes('--help')) {
    console.log(USAGE);
    return 0;
  }

  const outOpt = takeSingle(args, '-o');
  const deckPath = requireOnePositional(args, USAGE);
  const notes = loadDeckNotes(deckPath);

  // Node's path.dirname already returns "." for a bare filename with no
  // directory component -- unlike Python's os.path.dirname, which returns
  // "" there and needs its own explicit `or "."` (render-review-and-
  // conventions.md §1.2), so no equivalent fallback is needed here.
  const outPath = outOpt ?? join(dirname(deckPath), 'review.html');

  // render_review.py always resolves media against MEDIA_DIR -- there is no
  // flag to turn this off, unlike check_deck.py's --no-media.
  const html = renderReview(notes, { mediaDir: resolveMediaDir() });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, 'utf8');
  console.log(`wrote ${outPath} (${notes.length} notes)`);
  return 0;
}
