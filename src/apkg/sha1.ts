// SHA-1 (FIPS 180-4), synchronous and dependency-free, for Anki's
// field_checksum -- doc §6.
//
// Why not node:crypto, which this file replaces: `createHash` does not exist
// in a browser, and the browser's own SubtleCrypto.digest is async. writeApkg
// is deliberately synchronous end to end (see index.ts's header), so an async
// digest would force that signature open across every caller for the sake of
// hashing a few hundred short strings. This is the one primitive that keeps
// the writer's shape identical on both platforms.
//
// Used by both Node and browser builds -- there is no platform branch, so
// there is exactly one implementation to pin. test/apkg/primitives.test.ts
// diffs it against node:crypto over every padding boundary and asserts all
// twenty digest bytes; that last part matters, because the only caller
// (fieldChecksum in text.ts) reads the first four, so h1..h4 are otherwise
// unobservable by the entire suite.

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/** 20-byte SHA-1 digest of `bytes`. */
export function sha1(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.length * 8;
  // 0x80 terminator + the 8-byte length field, rounded up to whole 64-byte blocks.
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[bytes.length] = 0x80;

  const view = new DataView(msg.buffer);
  // Big-endian 64-bit bit count. Split rather than using BigInt: the high
  // word is only ever nonzero above 512 MB of input, which no field is.
  view.setUint32(total - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(total - 4, bitLength >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);

  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 80; i += 1) w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      // Every term is < 2^32 and there are five of them, so the sum stays
      // exact in a double (< 2^35) and `>>> 0` truncates it correctly.
      const t = (rotl(a, 5) + (f >>> 0) + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  return out;
}
