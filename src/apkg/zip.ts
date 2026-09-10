// Minimal ZIP writer -- docs/research/apkg-format.md §2. No zip dependency:
// this is exactly the local-file-header / central-directory /
// end-of-central-directory layout the doc lays out byte-for-byte (PKZIP
// APPNOTE, unrelated to Anki specifically), with every field width/offset
// taken straight from that table.
//
// Deliberately narrow: no zip64, no encryption, no extra fields, no
// filename encoding beyond ASCII -- ecosystems this project actually needs
// (a from-scratch small package, ASCII entry names only, doc §2) don't need
// any of that, and adding it would be untested surface area.
//
// Platform-neutral: the two compression primitives are injected (ZipCodec)
// rather than imported from node:zlib, so this file -- the whole archive
// layout -- is shared byte-for-byte between the Node and browser builds.

import { concatBytes, utf8 } from './bytes.js';
import { crc32 } from './crc32.js';

export type ZipMethod = 'store' | 'deflate';

/**
 * The one compression primitive this writer cannot supply itself: node:zlib
 * provides it in Node (zlib-node.ts), fflate in the browser. Everything else
 * about the archive -- the layout below, and the CRC-32 in crc32.ts -- is
 * shared, so the two builds differ by exactly this function.
 */
export interface ZipCodec {
  /** Raw deflate -- no zlib wrapper, no gzip header. */
  deflateRaw(data: Uint8Array): Uint8Array;
}

export interface ZipEntryInput {
  /** ASCII only -- doc §2: every entry name this project writes is ASCII. */
  name: string;
  data: Uint8Array;
  method: ZipMethod;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 20; // 2.0 -- enough for deflate (doc §2)

// Arbitrary DOS time/date -- doc §2 says nothing reads this. DOS_TIME=0
// decodes to a fully valid 00:00:00 (hour/minute/second-halves are all
// 0-indexed, so all-zero is in range) and needs no substitute; DOS_DATE=0
// would decode to day=0, month=0, which is genuinely invalid on any reader
// that checks the field (day and month are 1-indexed) -- 0x21 is the doc's
// own suggested value instead, decoding to 1980-01-01. Only confirmed
// against one reader, Python's zipfile (permissive: parses this pair as
// (1980,1,1,0,0,0) without complaint) -- no strict/validating reader was
// available to try in this session, so whether one would actually object
// to an all-zero DOS_DATE remains an assumption, not a tested fact.
const DOS_TIME = 0;
const DOS_DATE = 0x21;

function methodCode(method: ZipMethod): number {
  return method === 'deflate' ? 8 : 0;
}

function compress(data: Uint8Array, method: ZipMethod, codec: ZipCodec): Uint8Array {
  return method === 'deflate' ? codec.deflateRaw(data) : data;
}

interface PreparedEntry {
  nameBuf: Uint8Array;
  compressed: Uint8Array;
  crc: number;
  method: ZipMethod;
  uncompressedSize: number;
}

function prepare(entry: ZipEntryInput, codec: ZipCodec): PreparedEntry {
  return {
    nameBuf: utf8(entry.name),
    compressed: compress(entry.data, entry.method, codec),
    crc: crc32(entry.data),
    method: entry.method,
    uncompressedSize: entry.data.length,
  };
}

function writeLocalHeader(entry: PreparedEntry): Uint8Array {
  const header = new Uint8Array(30);
  const view = new DataView(header.buffer);
  view.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
  view.setUint16(4, VERSION_NEEDED, true);
  view.setUint16(6, 0, true); // gp flag
  view.setUint16(8, methodCode(entry.method), true);
  view.setUint16(10, DOS_TIME, true);
  view.setUint16(12, DOS_DATE, true);
  view.setUint32(14, entry.crc, true);
  view.setUint32(18, entry.compressed.length, true);
  view.setUint32(22, entry.uncompressedSize, true);
  view.setUint16(26, entry.nameBuf.length, true);
  view.setUint16(28, 0, true); // extra field length
  return header;
}

function writeCentralHeader(entry: PreparedEntry, localHeaderOffset: number): Uint8Array {
  const header = new Uint8Array(46);
  const view = new DataView(header.buffer);
  view.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
  view.setUint16(4, VERSION_NEEDED, true); // version made by
  view.setUint16(6, VERSION_NEEDED, true); // version needed
  view.setUint16(8, 0, true); // gp flag
  view.setUint16(10, methodCode(entry.method), true);
  view.setUint16(12, DOS_TIME, true);
  view.setUint16(14, DOS_DATE, true);
  view.setUint32(16, entry.crc, true);
  view.setUint32(20, entry.compressed.length, true);
  view.setUint32(24, entry.uncompressedSize, true);
  view.setUint16(28, entry.nameBuf.length, true);
  view.setUint16(30, 0, true); // extra field length
  view.setUint16(32, 0, true); // comment length
  view.setUint16(34, 0, true); // disk number start
  view.setUint16(36, 0, true); // internal attrs
  view.setUint32(38, 0, true); // external attrs
  view.setUint32(42, localHeaderOffset, true);
  return header;
}

function writeEocd(entryCount: number, centralDirSize: number, centralDirOffset: number): Uint8Array {
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, EOCD_SIGNATURE, true);
  view.setUint16(4, 0, true); // disk number
  view.setUint16(6, 0, true); // disk with central dir
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralDirSize, true);
  view.setUint32(16, centralDirOffset, true);
  view.setUint16(20, 0, true); // comment length
  return eocd;
}

/**
 * Builds a complete ZIP archive: local headers + data in entry order, then
 * one central directory header per entry, then the EOCD record -- doc §2.
 * Member order is otherwise not load-bearing (Anki looks members up by
 * name, doc §2) so entries are written in the order given.
 */
export function buildZip(entries: ZipEntryInput[], codec: ZipCodec): Uint8Array {
  const prepared = entries.map((entry) => prepare(entry, codec));
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of prepared) {
    const localHeader = writeLocalHeader(entry);
    localChunks.push(localHeader, entry.nameBuf, entry.compressed);
    centralChunks.push(writeCentralHeader(entry, offset), entry.nameBuf);
    offset += localHeader.length + entry.nameBuf.length + entry.compressed.length;
  }

  const centralDirOffset = offset;
  const centralDir = concatBytes(centralChunks);
  const eocd = writeEocd(prepared.length, centralDir.length, centralDirOffset);

  return concatBytes([...localChunks, centralDir, eocd]);
}
