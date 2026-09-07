// Small argv-mutation helpers shared by every subcommand, generalizing the
// exact flag-pulling style check_deck.py's own main() uses (lines 438-456 of
// tools/check_deck.py in the engine repo, quoted in full in
// docs/research/check-deck-contract.md §1.2): find a flag, splice it and its
// value out of a working copy of argv, and treat whatever is left over as
// positionals-plus-stray-flags. Each function mutates `argv` in place so a
// subcommand can call several of these in a row and then look at what
// remains, the same way the Python original chains its own `while`/`if`
// extractions before ever validating the leftovers.
//
// One deliberate divergence, in every function below: the Python original
// lets a flag with no following value crash uncaught (`argv[position + 1]`
// past the end of the list raises IndexError -- check-deck-contract.md
// §1.2.1-2 calls this out explicitly as unguarded). A UsageError here instead
// is not an attempt to byte-replicate that crash -- these subcommands are new
// tools this repo is shipping, not a literal port of check_deck.py's argv
// handling, so a clear exit-2 message is strictly better for anyone actually
// typing the command.
import { UsageError } from './errors.js';

/**
 * Repeatable value flag: every `flag value` pair is removed from `argv` and
 * the values are returned in the order they appeared. Mirrors the
 * `--transcript` loop exactly (`while flag in argv: ...`), generalized.
 */
export function takeRepeatable(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = argv.indexOf(flag); i !== -1; i = argv.indexOf(flag)) {
    if (i === argv.length - 1) {
      throw new UsageError(`${flag} requires a value`);
    }
    values.push(argv[i + 1]);
    argv.splice(i, 2);
  }
  return values;
}

/**
 * Single-value flag: only the first `flag value` pair is removed. A second
 * occurrence is deliberately left in `argv` -- it will surface on its own as
 * a stray, unrecognized flag once the caller checks the leftovers, which is
 * clearer than this function silently picking a "winning" occurrence.
 */
export function takeSingle(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  if (i === argv.length - 1) {
    throw new UsageError(`${flag} requires a value`);
  }
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
}

/** Zero-argument flag: every occurrence is removed; returns whether it was
 *  present at all. */
export function takeBoolean(argv: string[], flag: string): boolean {
  let found = false;
  for (let i = argv.indexOf(flag); i !== -1; i = argv.indexOf(flag)) {
    found = true;
    argv.splice(i, 1);
  }
  return found;
}

/**
 * What is left after every recognized flag has been pulled out of `argv`:
 * positionals (tokens not starting with "-") and stray flags (tokens that
 * do) -- check-deck-contract.md §1.2.3's own split
 * (`args`/`flags` in the Python source), generalized to every subcommand. A
 * caller treats a non-empty `strayFlags` or the wrong positional count as a
 * usage error.
 */
export function splitPositionalsAndFlags(argv: readonly string[]): { positionals: string[]; strayFlags: string[] } {
  const positionals = argv.filter((a) => !a.startsWith('-'));
  const strayFlags = argv.filter((a) => a.startsWith('-'));
  return { positionals, strayFlags };
}

/** Requires exactly one positional and no stray flags; throws the given
 *  usage message (verbatim, so each subcommand controls its own wording)
 *  otherwise. Returns that one positional. */
export function requireOnePositional(argv: readonly string[], usage: string): string {
  const { positionals, strayFlags } = splitPositionalsAndFlags(argv);
  if (positionals.length !== 1 || strayFlags.length > 0) {
    throw new UsageError(usage);
  }
  return positionals[0];
}
