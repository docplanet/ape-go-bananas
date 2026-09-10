// Byte helpers shared by the writer's platform-neutral parts.
//
// The writer used to build everything out of node:Buffer, which does not
// exist in a browser. Uint8Array is the common denominator -- and Buffer is
// itself a Uint8Array subclass, so Node code passing a Buffer into any of
// this still works unchanged.

const ENCODER = new TextEncoder();

/** UTF-8 bytes of `text`. */
export function utf8(text: string): Uint8Array {
  return ENCODER.encode(text);
}

/** One buffer holding `chunks` end to end, in order. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
