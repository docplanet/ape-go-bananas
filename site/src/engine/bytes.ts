// Base64 over bytes, in chunks. `btoa(String.fromCharCode(...bytes))` blows
// the argument limit on anything large (a rendered slide is ~200 KB), and
// `atob` yields one char per byte -- latin1 -- so decoding text through it
// mangles every non-ASCII character. A spike wrote "Step 1 â Extract" for
// "Step 1 — Extract" that way. These two are the only conversions the page
// should use.

const CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function encodeUtf8Base64(text: string): string {
  return toBase64(new TextEncoder().encode(text));
}

export function decodeUtf8Base64(b64: string): string {
  return new TextDecoder().decode(fromBase64(b64));
}
