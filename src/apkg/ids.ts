// Id and guid generation -- docs/research/apkg-format.md §8 and §6.

import { sha1 } from './sha1.js';
//
// §8's practical recipe: seed a counter at "now" (milliseconds) and hand out
// counter++ for every id needed across every table. Exact collision
// avoidance against a destination collection doesn't matter (the import
// path reconciles notes/cards/decks/notetypes by guid/name/id-then-name
// respectively, per the doc) -- only within-file uniqueness does.
//
// determinism.test.ts additionally requires (see that file's own header)
// that this never reach for Date.now()/Math.random()/crypto.randomUUID():
// every id and every guid must be a pure function of the caller-supplied
// clock value and this allocator's own counter state, or two writeApkg
// calls with the same injected clock could not produce byte-identical
// output.

export class IdAllocator {
  #next: number;

  constructor(seedMs: number) {
    this.#next = seedMs;
  }

  /** The next unique id, monotonically increasing from the seed. */
  next(): number {
    const value = this.#next;
    this.#next += 1;
    return value;
  }
}

// The 91-character alphabet Anki's own anki_base91 uses: the 94 printable
// ASCII characters '!'..'~' minus '"', '\'', and '\\' -- excluded because
// they're awkward inside quoted strings/HTML attributes (doc §6). Matching
// this exactly is cosmetic, not required for import correctness (guids are
// matched by plain string equality, doc §6) -- reproduced anyway since it's
// cheap and indistinguishable from what a real Anki client would emit.
const BASE91_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~";

function toBase91(value: bigint): string {
  let v = value;
  let out = '';
  const base = 91n;
  while (v > 0n) {
    const digit = Number(v % base);
    out = BASE91_ALPHABET[digit] + out;
    v /= base;
  }
  return out || BASE91_ALPHABET[0];
}

const U64_MASK = (1n << 64n) - 1n;

/**
 * A note's guid from what the note is, not when it was exported: the first
 * 64 bits of sha1(key), base-91 encoded like Anki's own. Anki matches an
 * imported note to an existing one by guid alone (doc §6), so a guid minted
 * from the export clock made every re-export of a deck a second copy of it.
 * The caller chooses the key; see buildCollection.
 */
export function contentGuid(key: string): string {
  const digest = sha1(new TextEncoder().encode(key));
  let value = 0n;
  for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(digest[i]!);
  return toBase91(value === 0n ? 1n : value);
}
