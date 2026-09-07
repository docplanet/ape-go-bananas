// The output is a valid ZIP with exactly the expected members --
// docs/research/apkg-format.md §1-3. Verified with an independent tool
// (the system `unzip` binary: -l for the member list, -t for CRC-32
// integrity, -v for per-entry CRC-32) rather than any zip-reading code that
// could share a bug with the exporter's own zip-writing code.
//
// The fixture media file (test/apkg/fixtures/slide.jpg, 108 bytes) has its
// CRC-32 (3afd57a7) independently computed with Python's zlib -- a
// different language/runtime than the exporter, per
// apkg-format.md's own source item 6 ("zlib.crc32() ... matches Python's
// zlib.crc32 bit-for-bit" was the doc's own standard of verification for
// this exact primitive). The `media` manifest's *shape* (§3: a flat
// {"<index>": "<real filename>"} map) is doc-transcribed; this suite checks
// it by parsing the JSON and comparing the resulting object, not by
// comparing raw bytes, since the doc gives no indication that the
// manifest's incidental whitespace (a real sample byte-inspected this
// session prints keys as `"0": "..."` with a space after the colon --
// Anki's own importer parses this with an ordinary JSON parser, so that
// space is not load-bearing and asserting it verbatim would only make this
// suite reject a correct, differently-formatted JSON.stringify call).
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeApkg } from '../../dist/apkg/index.js';
import {
  fixedClock,
  makeTempDir,
  makeEmptyMediaDir,
  makeNote,
  listZipEntries,
  listZipEntryDetails,
  checkZipIntegrity,
  readZipMember,
} from './helpers.ts';

const DECK_NAME = 'Fixtures::Zip Shape';
const FIXTURE_MEDIA_PATH = join(import.meta.dirname, 'fixtures', 'slide.jpg');
const FIXTURE_MEDIA_CRC32 = '3afd57a7'; // python3: hex(zlib.crc32(open(...).read()))

test('zip: a note with no media produces exactly collection.anki21 + an empty media manifest', async () => {
  const tempDir = makeTempDir('zip-no-media');
  const outPath = join(tempDir, 'out.apkg');
  const mediaDir = makeEmptyMediaDir(tempDir); // nothing references it, but it does exist
  const note = makeNote('{{c1::Bern}} is the capital of Switzerland.', { deckName: DECK_NAME });

  await writeApkg([note], { deckName: DECK_NAME, outPath, mediaDir, clock: fixedClock });

  const names = listZipEntries(outPath)
    .map((e) => e.name)
    .sort();
  assert.deepEqual(names, ['collection.anki21', 'media']);
  assert.ok(!names.includes('collection.anki2'), 'the legacy-1 stub is deliberately never written (doc §1)');
  assert.ok(!names.includes('meta'), 'meta is deliberately omitted -- its absence is the documented Legacy2 fallback (doc §1)');

  checkZipIntegrity(outPath); // throws on any CRC-32 mismatch; nothing further to assert

  const media = JSON.parse(readZipMember(outPath, 'media').toString('utf8'));
  assert.deepEqual(media, {}, 'no note references media, so the manifest must be empty (doc §3)');
});

test('zip: a note referencing one media file produces collection.anki21 + media + one numbered member', async () => {
  const tempDir = makeTempDir('zip-one-media');
  const outPath = join(tempDir, 'out.apkg');
  const mediaDir = makeEmptyMediaDir(tempDir);
  copyFileSync(FIXTURE_MEDIA_PATH, join(mediaDir, 'slide.jpg'));
  // ref-07 shape: image visible on the front, one cloze naming the answer.
  const note = makeNote('<img src="slide.jpg"><br><br>This is {{c1::compact bone}}.', { deckName: DECK_NAME });

  await writeApkg([note], { deckName: DECK_NAME, outPath, mediaDir, clock: fixedClock });

  const entries = listZipEntries(outPath);
  const names = entries.map((e) => e.name).sort();
  assert.deepEqual(names, ['0', 'collection.anki21', 'media']);

  checkZipIntegrity(outPath);

  const media = JSON.parse(readZipMember(outPath, 'media').toString('utf8'));
  assert.deepEqual(media, { '0': 'slide.jpg' }, 'numbered member "0" maps to the real filename the note referenced');

  const embeddedBytes = readZipMember(outPath, '0');
  const originalBytes = readFileSync(FIXTURE_MEDIA_PATH);
  assert.ok(embeddedBytes.equals(originalBytes), 'embedded media bytes must round-trip unmodified');

  const entryFor0 = entries.find((e) => e.name === '0')!;
  assert.equal(entryFor0.length, statSync(FIXTURE_MEDIA_PATH).size);

  const details = listZipEntryDetails(outPath).find((d) => d.name === '0')!;
  assert.equal(details.crc32, FIXTURE_MEDIA_CRC32, 'CRC-32 as computed by the independent `unzip` reader, not the exporter');
});
