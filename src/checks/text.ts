// The shared text-cleaning pipeline (contract §3.2), used by every claim-level and
// inventory check: tag-strip, decode entities, lowercase, fold "fancy" punctuation to
// ASCII, collapse whitespace. Deliberately not `.trim()`-ed - normalize() never trims,
// so a leading/trailing whitespace run survives as a single leading/trailing space.
import { ANY_TAG_RE } from './regex.js';
import { htmlUnescape } from './pystrings.js';

// Six ordered, disjoint replacements: right/left single quote, right/left double quote,
// em dash, en dash - folded to their ASCII stand-ins. Order is immaterial (contract §3.2).
const FANCY_PUNCTUATION: ReadonlyArray<readonly [string, string]> = [
  ['’', "'"],
  ['‘', "'"],
  ['“', '"'],
  ['”', '"'],
  ['—', '-'],
  ['–', '-'],
];

export function normalize(text: string): string {
  let out = htmlUnescape(text.replace(ANY_TAG_RE, ' ')).toLowerCase();
  for (const [fancy, plain] of FANCY_PUNCTUATION) {
    out = out.split(fancy).join(plain);
  }
  return out.replace(/\s+/g, ' ');
}

/** Maximal runs of lowercase ASCII letters, digits, and "&" - assumes already-lowercased
 *  input, which every call site guarantees by only ever calling this on normalize()'s output. */
export function words(text: string): string[] {
  return text.match(/[a-z0-9&]+/g) ?? [];
}
