// The browser half of the engine's ZIP codec seam (src/apkg/zip.ts).
//
// fflate rather than the platform's own CompressionStream('deflate-raw'):
// that API is async, and the engine's writer is synchronous end to end (see
// src/apkg/build.ts). fflate is synchronous and about 10 KB, which keeps the
// two builds the same shape rather than forking the writer's signature.
//
// fflate's deflateSync emits raw DEFLATE -- no zlib wrapper, no gzip header
// -- which is what a ZIP local file header with method 8 expects, and what
// node:zlib's deflateRawSync (not deflateSync) produces on the other side.
// The CRC-32 is not here: fflate does not export one, and the engine shares
// a single implementation across both builds (src/apkg/crc32.ts).

import { deflateSync } from 'fflate';
import type { ZipCodec } from '../../../dist/apkg/zip.js';

export const fflateZipCodec: ZipCodec = {
  deflateRaw: (data) => deflateSync(data),
};
