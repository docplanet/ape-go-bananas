// Id and guid generation -- docs/research/apkg-format.md §8 and §6.
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
 * A guid, unique within the file and deterministic in (clockMs, counter).
 * Not Anki's actual RNG-backed algorithm (doc §6 explains why that's not
 * required) -- this mixes the two inputs with fixed odd multipliers purely
 * so different notes at the same clock value don't collide, then base-91
 * encodes the result the same way Anki's own generator would. `counter`
 * is expected to already be unique per note (the note's own allocated id
 * does the job) so the mixing step doesn't have to work hard to avoid
 * collisions -- it only has to not be constant.
 */
export function guidFor(clockMs: number, counter: number): string {
  const mixed =
    (BigInt(clockMs) * 1000003n + BigInt(counter) * 2654435761n + 0x9e3779b97f4a7c15n) & U64_MASK;
  return toBase91(mixed === 0n ? 1n : mixed);
}
