// With an injected fixed clock, two writeApkg runs over the same notes must
// produce byte-identical output.
//
// This is only satisfiable at all if `clock` is the SOLE source of
// nondeterminism in the exporter: every id, every mod/crt/scm timestamp, and
// -- per this suite's own pinned reading of the API (see helpers.ts and the
// review notes returned alongside this suite) -- every note guid must be a
// deterministic function of clock()'s return value and the writer's own
// counter state, never a fresh Date.now(), Math.random(), or
// crypto.randomUUID() call. The pinned options carry no separate seed for
// guid randomness, so guid generation has to ride on `clock` too for this
// file to be satisfiable by any implementation. This is flagged clearly
// because it is a design constraint this suite is imposing on the
// implementation, not something apkg-format.md states outright -- the doc's
// own §6 guid discussion only says the exact algorithm is not required for
// Anki-import correctness, not that it must be clock-derived.
//
// A second check (the "different clock" case) guards the inverse failure
// mode: an implementation that hardcodes every timestamp/id regardless of
// input would also produce byte-identical output for two same-clock runs,
// vacuously passing the main assertion for the wrong reason. Changing the
// clock and requiring the bytes to change catches that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeApkg } from '../../dist/apkg/index.js';
import type { DeckNote } from '../../dist/types.js';
import { FIXED_CLOCK_MS, makeTempDir, makeEmptyMediaDir, checkZipIntegrity } from './helpers.ts';

const DECK_NAME = 'Fixtures::Reference Cards';
const FIXTURE_MEDIA_PATH = join(import.meta.dirname, 'fixtures', 'slide.jpg');

function loadSharedNotes(): DeckNote[] {
  const fixturePath = join(import.meta.dirname, '..', 'fixtures', 'reference-cards.json');
  return (JSON.parse(readFileSync(fixturePath, 'utf8')) as { notes: DeckNote[] }).notes;
}

async function run(outName: string, clockMs: number, tempDir: string, mediaDir: string): Promise<Buffer> {
  const outPath = join(tempDir, outName);
  await writeApkg(loadSharedNotes(), {
    deckName: DECK_NAME,
    outPath,
    mediaDir,
    clock: () => clockMs,
  });
  return readFileSync(outPath);
}

test('determinism: two runs with the same fixed clock produce byte-identical .apkg files', async () => {
  const tempDir = makeTempDir('determinism');
  const mediaDir = makeEmptyMediaDir(tempDir);
  // ref-06/ref-07 (in the shared fixture) reference slide.jpg -- exercise
  // the media path too, not just notes/cards.
  copyFileSync(FIXTURE_MEDIA_PATH, join(mediaDir, 'slide.jpg'));

  const bufA = await run('out-a.apkg', FIXED_CLOCK_MS, tempDir, mediaDir);
  const bufB = await run('out-b.apkg', FIXED_CLOCK_MS, tempDir, mediaDir);

  assert.ok(bufA.length > 0, 'sanity: the file is not empty');
  assert.equal(bufA.length, bufB.length, 'byte-identical files are necessarily the same length');
  assert.ok(bufA.equals(bufB), 'two writeApkg calls with the same clock and the same notes must be byte-identical');

  checkZipIntegrity(join(tempDir, 'out-a.apkg'));
  checkZipIntegrity(join(tempDir, 'out-b.apkg'));
});

test('determinism: a different clock value produces different output (rules out a hardcoded, fake-deterministic writer)', async () => {
  const tempDir = makeTempDir('determinism-diff');
  const mediaDir = makeEmptyMediaDir(tempDir);
  copyFileSync(FIXTURE_MEDIA_PATH, join(mediaDir, 'slide.jpg'));

  const bufA = await run('out-a.apkg', FIXED_CLOCK_MS, tempDir, mediaDir);
  const bufC = await run('out-c.apkg', FIXED_CLOCK_MS + 1000, tempDir, mediaDir);

  assert.ok(!bufA.equals(bufC), 'a different clock must change the output -- otherwise clock is not actually load-bearing');
});
