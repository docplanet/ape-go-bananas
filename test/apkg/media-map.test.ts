// The deck's own media list (apkg-format.md §3, the 2026-09-11 note): a
// referenced filename is read from its mapped path first, then mediaDir,
// then each fallback directory. This is how the app's decks export at all --
// their images sit under _extracted/ under working names.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { writeApkg } from '../../dist/apkg/index.js';
import { mappedMediaExists, resolveMediaFile } from '../../dist/apkg/media-node.js';
import { fixedClock, makeEmptyMediaDir, makeNote, makeTempDir, readZipMember } from './helpers.ts';

const DECK_NAME = 'Fixtures::Media Map';

function extractedPage(tempDir: string, bytes: string): string {
  const dir = join(tempDir, '_extracted', 'Lecture 9.pdf');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'p003.jpg');
  writeFileSync(path, bytes);
  return path;
}

test('media map: a referenced name maps to a page image under _extracted/, and its bytes go in under the referenced name', async () => {
  const tempDir = makeTempDir('media-map');
  const mediaDir = makeEmptyMediaDir(tempDir);
  const page = extractedPage(tempDir, 'page three bytes');
  const note = makeNote('{{c1::<b>E. coli</b>::which bacterium?}} has {{c2::<i>one circular chromosome</i>::what chromosome?}}', {
    deckName: DECK_NAME,
    extra: '<img src="isf-biochem-09-slide-03.jpg">',
  });
  const outPath = join(tempDir, 'out.apkg');

  const { unresolvedMedia } = await writeApkg([note], {
    deckName: DECK_NAME,
    outPath,
    mediaDir,
    media: [{ filename: 'isf-biochem-09-slide-03.jpg', path: page }],
    clock: fixedClock,
  });

  assert.deepEqual(unresolvedMedia, []);
  const manifest = JSON.parse(readZipMember(outPath, 'media').toString('utf8'));
  assert.deepEqual(manifest, { '0': 'isf-biochem-09-slide-03.jpg' });
  assert.equal(readZipMember(outPath, '0').toString('utf8'), 'page three bytes');
});

test('media map: an unmapped name still comes from mediaDir, then a fallback dir; a name nowhere is reported unresolved', async () => {
  const tempDir = makeTempDir('media-map-fallback');
  const mediaDir = makeEmptyMediaDir(tempDir);
  writeFileSync(join(mediaDir, 'in-collection.jpg'), 'collection bytes');
  const deckDir = join(tempDir, 'deck');
  mkdirSync(deckDir);
  writeFileSync(join(deckDir, 'beside-deck.jpg'), 'deck folder bytes');
  const note = makeNote('{{c1::<b>A</b>::what?}} is {{c2::<i>b</i>::what?}}', {
    deckName: DECK_NAME,
    extra: '<img src="in-collection.jpg"><img src="beside-deck.jpg"><img src="nowhere.jpg">',
  });
  const outPath = join(deckDir, 'out.apkg');

  const { unresolvedMedia } = await writeApkg([note], { deckName: DECK_NAME, outPath, mediaDir, media: [], fallbackDirs: [deckDir], clock: fixedClock });

  assert.deepEqual(unresolvedMedia, ['nowhere.jpg']);
  const manifest = JSON.parse(readZipMember(outPath, 'media').toString('utf8'));
  assert.deepEqual(manifest, { '0': 'in-collection.jpg', '1': 'beside-deck.jpg' });
  assert.equal(readZipMember(outPath, '1').toString('utf8'), 'deck folder bytes');
});

test('media map: resolveMediaFile and mappedMediaExists agree, and a filename with a directory part is refused', () => {
  const tempDir = makeTempDir('media-map-resolve');
  const page = extractedPage(tempDir, 'x');
  const media = [{ filename: 'slide-03.jpg', path: page }, { filename: 'gone.jpg', path: join(tempDir, 'missing.jpg') }];
  assert.equal(resolveMediaFile('slide-03.jpg', media, []), page);
  assert.equal(resolveMediaFile('gone.jpg', media, []), undefined, 'a mapped path that does not exist is not a resolution');
  const exists = mappedMediaExists(media, [tempDir]);
  assert.equal(exists(join('/nonexistent/collection.media', 'slide-03.jpg')), true, 'rule 2 asks about the collection path; the list answers');
  assert.equal(exists(join('/nonexistent/collection.media', 'gone.jpg')), false);
  assert.throws(() => resolveMediaFile('../slide-03.jpg', media, []), /not a bare filename/);
  assert.equal(readFileSync(page, 'utf8'), 'x');
});
