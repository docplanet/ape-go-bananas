// Does the browser build produce the same package as the Node build?
//
// The engine's writer is deterministic under a fixed clock (src/apkg/build.ts),
// so this runs buildApkg twice over the same seven reference cards with the
// same clock, differing only in the injected platform primitives, and compares
// the results. sql.js runs perfectly well under Node, so this needs no browser
// -- what is under test is the adapters, not the DOM.
//
// The whole .apkg files are NOT byte-identical, and should not be expected to
// be: zlib and fflate are both correct DEFLATE implementations but not the
// same one, so the compressed members differ in length while decompressing to
// the same bytes. What is compared here is every member's decompressed
// content.
//
// Those match exactly, with one two-byte exception that is asserted rather
// than waved through: bytes 96-99 of a SQLite file are SQLITE_VERSION_NUMBER,
// the version of SQLite that wrote it (node:sqlite ships 3.50.4 here, sql.js
// 3.49.1). Every other byte of the 53 KB collection -- schema, notes, cards,
// ids, guids, checksums -- is identical. Pinning the exception this precisely
// is the point: a real divergence in any of that content would fail, where a
// loose "both are valid SQLite" check would not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import initSqlJs from 'sql.js';

import { buildApkg } from '../../dist/apkg/build.js';
import { openNodeSqlite } from '../../dist/apkg/sqlite-node.js';
import { nodeZipCodec } from '../../dist/apkg/zlib-node.js';
import type { DeckNote } from '../../dist/types.js';
import { sqlJsOpener } from '../src/engine/sqlite-sqljs.ts';
import { fflateZipCodec } from '../src/engine/deflate-fflate.ts';

const FIXTURE = new URL('../../test/fixtures/reference-cards.json', import.meta.url);
const notes = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { notes: DeckNote[] }).notes;

/** Fixed: every id, timestamp and guid the writer emits derives from it. */
const CLOCK = () => 1_700_000_000_000;
const DECK = 'Fixtures::Reference Cards';

/** SQLite header, bytes 96-99 -- the version that wrote the file. */
const VERSION_OFFSET = 96;
const VERSION_END = 100;

function sqliteVersion(file: Uint8Array): string {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const n = view.getUint32(VERSION_OFFSET, false);
  return `${Math.floor(n / 1_000_000)}.${Math.floor(n / 1000) % 1000}.${n % 1000}`;
}

test('the browser adapters build the same package as the Node ones', async () => {
  const SQL = await initSqlJs();
  // Neither build resolves slide.jpg, so both land it on unresolvedMedia the
  // same way; media embedding is covered by the engine's own apkg suite.
  const common = { deckName: DECK, readMedia: () => undefined, clock: CLOCK };

  const node = buildApkg(notes, { ...common, openSqlite: openNodeSqlite, zipCodec: nodeZipCodec });
  const browser = buildApkg(notes, { ...common, openSqlite: sqlJsOpener(SQL), zipCodec: fflateZipCodec });

  assert.deepEqual(browser.unresolvedMedia, node.unresolvedMedia, 'same unresolved media');

  const a = unzipSync(node.bytes);
  const b = unzipSync(browser.bytes);
  assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort(), 'same zip members');

  // The manifest and any media members must match outright.
  for (const name of Object.keys(a).filter((n) => n !== 'collection.anki21')) {
    assert.deepEqual(b[name], a[name], `member ${name} is byte-identical`);
  }

  const nodeDb = a['collection.anki21']!;
  const browserDb = b['collection.anki21']!;
  assert.ok(nodeDb.length > 0, 'the Node build produced a collection');
  assert.equal(browserDb.length, nodeDb.length, 'collections are the same size');

  // Everything before the version stamp...
  assert.deepEqual(
    browserDb.subarray(0, VERSION_OFFSET),
    nodeDb.subarray(0, VERSION_OFFSET),
    'SQLite header before the version stamp is identical',
  );
  // ...and everything after it: the schema, and every note and card row.
  assert.deepEqual(
    browserDb.subarray(VERSION_END),
    nodeDb.subarray(VERSION_END),
    'the entire collection body is byte-identical across the two SQLite implementations',
  );

  // The one allowed difference, named rather than skipped: both must still be
  // a plausible SQLite 3.x stamp, so a zeroed or garbage header still fails.
  for (const [label, file] of [['node:sqlite', nodeDb], ['sql.js', browserDb]] as const) {
    const version = sqliteVersion(file);
    assert.match(version, /^3\.\d+\.\d+$/, `${label} wrote a SQLite 3.x version stamp (got ${version})`);
  }
});
