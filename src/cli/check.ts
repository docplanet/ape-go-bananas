// `ape check` -- a straight port of tools/check_deck.py's main(), lines
// 435-485 (verified directly against that file in the engine repo; every
// step below is in that file's own order, not a guess from the doc alone):
//   1. pull --transcript (repeatable) and --inventory (single) out of argv
//   2. validate what's left: exactly one positional, no stray flags
//   3. resolve the media directory and decide checkMedia, printing the
//      "not found" note unconditionally at this point (before anything
//      about the deck itself is known)
//   4. load --transcript file(s), concatenating word lists in argv order
//   5. load --inventory, rejecting an empty result
//   6. load deck.json itself
//   7. "contains no notes" is its own exit-2 case, distinct from every
//      load() failure above (which are exit 1) and checked only now
// checkDeck/formatCheckReport (src/checks) own every byte of the report
// itself; this file's only job is reproducing check_deck.py's own argv
// handling and exit-code contract around a call to them.
import { checkDeck, formatCheckReport, loadInventory, loadTranscript, type CheckDeckOptions } from '../checks/index.js';
import { nodeMediaExists } from '../checks/media-exists-node.js';
import { requireOnePositional, takeBoolean, takeRepeatable, takeSingle } from './args.js';
import { loadDeckNotes } from './deck-loader.js';
import { isExistingDirectory, resolveMediaDir } from './media-dir.js';
import { readFileOrThrow } from './read-file.js';

const USAGE = 'usage: ape check [--no-media] [--transcript <file>]... [--inventory <file>] <deck.json>';

export function runCheck(argv: string[]): number {
  const args = [...argv];
  if (args.includes('-h') || args.includes('--help')) {
    console.log(USAGE);
    return 0;
  }

  const transcriptPaths = takeRepeatable(args, '--transcript');
  const inventoryPath = takeSingle(args, '--inventory');
  const noMedia = takeBoolean(args, '--no-media');
  const deckPath = requireOnePositional(args, USAGE);

  const mediaDir = resolveMediaDir();
  const checkMedia = !noMedia && isExistingDirectory(mediaDir);
  if (!checkMedia && !noMedia) {
    // Literal " - ", not an em dash -- contract §1.4.
    console.error(`note: ${mediaDir} not found - skipping the media check`);
  }

  // contract §6.2: load_transcript() handles one source at a time (WEBVTT
  // header stripping and the is_transcript speaker-prefix decision are both
  // per-file); multiple sources are concatenated word-list-to-word-list, in
  // the order given on the command line -- never by concatenating raw text
  // first and tokenizing once.
  const transcript = transcriptPaths.length > 0 ? transcriptPaths.flatMap((p) => loadTranscript(readFileOrThrow(p))) : undefined;

  let inventory: Map<string, Set<string>> | undefined;
  if (inventoryPath !== undefined) {
    inventory = loadInventory(readFileOrThrow(inventoryPath));
    if (inventory.size === 0) {
      throw new Error(`${inventoryPath}: no numbered fact rows found`);
    }
  }

  const notes = loadDeckNotes(deckPath);
  if (notes.length === 0) {
    console.error(`${deckPath} contains no notes`);
    return 2;
  }

  const opts: CheckDeckOptions = { checkMedia, mediaDir, mediaExists: nodeMediaExists, transcript, inventory };
  const result = checkDeck(notes, opts);
  process.stdout.write(formatCheckReport(result));
  return result.findings.length > 0 ? 1 : 0;
}
