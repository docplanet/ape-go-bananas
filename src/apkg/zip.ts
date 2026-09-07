// Minimal ZIP writer over node:zlib -- docs/research/apkg-format.md §2. No
// zip dependency: this is exactly the local-file-header / central-directory
// / end-of-central-directory layout the doc lays out byte-for-byte (PKZIP
// APPNOTE, unrelated to Anki specifically), with every field width/offset
// taken straight from that table.
//
// Deliberately narrow: no zip64, no encryption, no extra fields, no
// filename encoding beyond ASCII -- ecosystems this project actually needs
// (a from-scratch small package, ASCII entry names only, doc §2) don't need
// any of that, and adding it would be untested surface area.

import { crc32, deflateRawSync } from 'node:zlib';

export type ZipMethod = 'store' | 'deflate';

export interface ZipEntryInput {
  /** ASCII only -- doc §2: every entry name this project writes is ASCII. */
  name: string;
  data: Buffer;
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

function compress(data: Buffer, method: ZipMethod): Buffer {
  return method === 'deflate' ? deflateRawSync(data) : data;
}

interface PreparedEntry {
  nameBuf: Buffer;
  compressed: Buffer;
  crc: number;
  method: ZipMethod;
  uncompressedSize: number;
}

function prepare(entry: ZipEntryInput): PreparedEntry {
  return {
    nameBuf: Buffer.from(entry.name, 'utf8'),
    compressed: compress(entry.data, entry.method),
    // node:zlib's crc32 returns an unsigned 32-bit integer (verified on the
    // pinned Node build against Python's zlib.crc32, doc source item 6) --
    // no sign-handling needed before writing it as a plain LE uint32.
    crc: crc32(entry.data),
    method: entry.method,
    uncompressedSize: entry.data.length,
  };
}

function writeLocalHeader(entry: PreparedEntry): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(0, 6); // gp flag
  header.writeUInt16LE(methodCode(entry.method), 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressed.length, 18);
  header.writeUInt32LE(entry.uncompressedSize, 22);
  header.writeUInt16LE(entry.nameBuf.length, 26);
  header.writeUInt16LE(0, 28); // extra field length
  return header;
}

function writeCentralHeader(entry: PreparedEntry, localHeaderOffset: number): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4); // version made by
  header.writeUInt16LE(VERSION_NEEDED, 6); // version needed
  header.writeUInt16LE(0, 8); // gp flag
  header.writeUInt16LE(methodCode(entry.method), 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressed.length, 20);
  header.writeUInt32LE(entry.uncompressedSize, 24);
  header.writeUInt16LE(entry.nameBuf.length, 28);
  header.writeUInt16LE(0, 30); // extra field length
  header.writeUInt16LE(0, 32); // comment length
  header.writeUInt16LE(0, 34); // disk number start
  header.writeUInt16LE(0, 36); // internal attrs
  header.writeUInt32LE(0, 38); // external attrs
  header.writeUInt32LE(localHeaderOffset, 42);
  return header;
}

function writeEocd(entryCount: number, centralDirSize: number, centralDirOffset: number): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entryCount, 8);
  eocd.writeUInt16LE(entryCount, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  return eocd;
}

/**
 * Builds a complete ZIP archive: local headers + data in entry order, then
 * one central directory header per entry, then the EOCD record -- doc §2.
 * Member order is otherwise not load-bearing (Anki looks members up by
 * name, doc §2) so entries are written in the order given.
 */
export function buildZip(entries: ZipEntryInput[]): Buffer {
  const prepared = entries.map(prepare);
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of prepared) {
    const localHeader = writeLocalHeader(entry);
    localChunks.push(localHeader, entry.nameBuf, entry.compressed);
    centralChunks.push(writeCentralHeader(entry, offset), entry.nameBuf);
    offset += localHeader.length + entry.nameBuf.length + entry.compressed.length;
  }

  const centralDirOffset = offset;
  const centralDir = Buffer.concat(centralChunks);
  const eocd = writeEocd(prepared.length, centralDir.length, centralDirOffset);

  return Buffer.concat([...localChunks, centralDir, eocd]);
}
