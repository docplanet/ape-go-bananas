#!/usr/bin/env node
// Thin dispatcher over the three subcommands -- src/checks and src/apkg own
// every byte of actual behavior; this file's only job is routing argv to
// the right one and turning a thrown Error into the right stderr line and
// exit code. UsageError (errors.ts) is exit 2; anything else is exit 1 --
// the same two-way split both check_deck.py and render_review.py use for
// "you called this wrong" versus "the run failed" (check-deck-contract.md
// §1.5, render-review-and-conventions.md §1.2).
//
// Each subcommand is loaded with a dynamic import, not a static one, purely
// so `ape check`/`ape review` don't drag in src/apkg (and, with it,
// node:sqlite's ExperimentalWarning) when nothing about those two
// subcommands ever touches it.
import { UsageError } from './errors.js';

const TOP_USAGE = [
  'usage: ape <command> [args]',
  '',
  'commands:',
  '  check  <deck.json> [--no-media] [--transcript <file>]... [--inventory <file>]',
  '  review <deck.json> [-o <out.html>]',
  '  export <deck.json> [-o <out.apkg>] [--deck-name <name>] [--media-dir <dir>]',
].join('\n');

async function dispatch(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined) {
    console.error(TOP_USAGE);
    return 2;
  }
  if (command === '-h' || command === '--help') {
    console.log(TOP_USAGE);
    return 0;
  }

  switch (command) {
    case 'check':
      return (await import('./check.js')).runCheck(rest);
    case 'review':
      return (await import('./review.js')).runReview(rest);
    case 'export':
      return (await import('./export.js')).runExport(rest);
    default:
      throw new UsageError(`unknown command: ${command}\n${TOP_USAGE}`);
  }
}

try {
  process.exitCode = await dispatch(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    console.error(err.message);
    process.exitCode = 2;
  } else {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
