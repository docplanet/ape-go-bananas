// CRC-32 (IEEE 802.3, the polynomial ZIP and zlib both use) -- the checksum
// every ZIP local-file and central-directory header carries, doc §2.
//
// Pure and shared by both builds rather than taken from each platform:
// node:zlib exports crc32, fflate does not export its own, and a checksum
// that disagreed between the two would produce archives that one reader
// accepts and another rejects -- with nothing in the output to say which
// side was wrong. One implementation, pinned by a differential test against
// node:zlib (test/apkg/primitives.test.ts, which sweeps lengths 0-130 plus
// the multi-block cases and the published 0xCBF43926 check value), is the
// version of this that can actually be trusted.

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Unsigned 32-bit CRC-32 of `data`. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
