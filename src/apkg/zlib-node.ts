// The Node half of the ZIP codec seam (zip.ts). Kept in its own file so that
// zip.ts imports nothing from node: -- the browser build supplies the same
// function from fflate and shares every other byte of the archive layout.

import { deflateRawSync } from 'node:zlib';
import type { ZipCodec } from './zip.js';

export const nodeZipCodec: ZipCodec = {
  // A view, not a copy: deflateRawSync's Buffer may sit inside a pooled
  // ArrayBuffer, so the offset and length both matter.
  deflateRaw: (data) => {
    const out = deflateRawSync(data);
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  },
};
