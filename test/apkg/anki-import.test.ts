// The only test in this suite that asks *Anki* whether the package is valid.
//
// Every other apkg test reads the output back with node:sqlite and `unzip`.
// Those are independent of the writer, but not independent of this repo's
// *reading of the format spec* -- so a misread that is applied consistently
// sails through all of them. That is not hypothetical: docs/research/
// apkg-format.md recorded the notetype's top-level `did` as optional, the
// exporter omitted it accordingly, all 167 other tests passed, and real Anki
// rejected every single package produced with
//
//     decoding models: JsonError { info: "missing field `did`" }
//
// Nothing in this repo could have caught that, because the oracle for "is
// this a valid .apkg" is Anki's own deserializer and nothing else. This test
// borrows it: a desktop Anki install ships its Rust backend behind a Python
// library, so we import into a throwaway collection in a temp directory and
// assert on what lands.
//
// It never touches the user's real collection -- a fresh Collection() in a
// mkdtemp'd directory, discarded when the test ends.
//
// If Anki is not installed, this test SKIPS rather than fails, and says so.
// A skip here means the repo's strongest correctness signal did not run:
// treat a green suite on a machine without Anki as weaker evidence than a
// green suite on one with it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeApkg } from '../../dist/apkg/index.js';
import type { DeckNote } from '../../dist/types.js';
import { fixedClock, makeEmptyMediaDir, makeTempDir } from './helpers.ts';

const ANKI_PACKAGES = '/Applications/Anki.app/Contents/Resources/app_packages';

/**
 * Anki's bundled library includes compiled `_mypyc` extension modules built
 * against one specific CPython minor version, so an arbitrary `python3` will
 * not do -- it must match. 3.13 is what Anki 25.x/26.x ship against; if a
 * future Anki moves, this returns null and the test skips (loudly) rather
 * than failing for an unrelated reason.
 */
function findAnkiPython(): string | null {
  if (!existsSync(ANKI_PACKAGES)) return null;
  const candidates = [
    '/opt/homebrew/bin/python3.13',
    '/usr/local/bin/python3.13',
    '/usr/bin/python3.13',
  ];
  for (const python of candidates) {
    if (!existsSync(python)) continue;
    try {
      execFileSync(python, ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(ANKI_PACKAGES)}); import anki`], {
        stdio: 'pipe',
      });
      return python;
    } catch {
      // Wrong ABI for the bundled extension modules -- try the next one.
    }
  }
  return null;
}

/** Imports `apkgPath` into a brand-new disposable collection and reports what landed. */
const IMPORT_SCRIPT = `
import sys, os, json, tempfile
sys.path.insert(0, ${JSON.stringify(ANKI_PACKAGES)})
from anki.collection import Collection

apkg = sys.argv[1]
tmp = tempfile.mkdtemp(prefix='ape_disposable_')
col = Collection(os.path.join(tmp, 'collection.anki2'))
try:
    try:
        from anki.collection import ImportAnkiPackageRequest, ImportAnkiPackageOptions
        col.import_anki_package(ImportAnkiPackageRequest(package_path=apkg, options=ImportAnkiPackageOptions()))
    except ImportError:
        col.import_anki_package(apkg)
except Exception as e:
    print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
    col.close(); sys.exit(0)

out = {
    "ok": True,
    "notes": len(col.find_notes('')),
    "cards": len(col.find_cards('')),
    "ordinals": sorted(sorted(c.ord for c in col.get_note(nid).cards()) for nid in col.find_notes('')),
    "decks": [d.name for d in col.decks.all_names_and_ids()],
    "notetypes": [m.name for m in col.models.all_names_and_ids()],
    "media": sorted(os.listdir(col.media.dir())),
}
col.close()
print(json.dumps(out))
`;

test('real Anki imports the exported package and generates the expected cards', (t) => {
  const python = findAnkiPython();
  if (python === null) {
    t.skip(
      'Anki desktop (or a matching python3.13) not found on this machine. ' +
        'The suite cannot verify that exported packages are actually importable; ' +
        'every remaining apkg assertion checks only this repo against its own reading of the format.',
    );
    return;
  }

  const tempDir = makeTempDir('anki-import');
  const notes = JSON.parse(
    readFileSync(new URL('../fixtures/reference-cards.json', import.meta.url), 'utf8'),
  ).notes as DeckNote[];
  const deckName = notes[0].deckName;
  const apkgPath = join(tempDir, 'reference-cards.apkg');

  // The seven reference cards carry one <img>; point mediaDir at the fixture
  // holding it so the media branch is exercised too, not just the notes.
  const fixtureMedia = new URL('./fixtures/', import.meta.url).pathname;
  const mediaDir = existsSync(join(fixtureMedia, 'slide.jpg'))
    ? fixtureMedia
    : makeEmptyMediaDir(tempDir);

  writeApkg(notes, { deckName, outPath: apkgPath, mediaDir, clock: fixedClock });

  const scriptPath = join(tempDir, 'import_check.py');
  writeFileSync(scriptPath, IMPORT_SCRIPT);
  const raw = execFileSync(python, [scriptPath, apkgPath], { encoding: 'utf8' });
  const result = JSON.parse(raw.trim().split('\n').at(-1)!);

  assert.equal(result.ok, true, `Anki rejected the package: ${result.error}`);
  assert.equal(result.notes, 7, 'all seven reference notes should land');
  assert.equal(result.cards, 14, 'the seven notes expand to fourteen cloze cards');

  // Hand-derived from the cloze syntax in the fixture, not read back from the
  // exporter: ref-07 is the single-cloze recognition card, one note carries
  // c1..c3, and the remaining five are two-cloze prose cards.
  assert.deepEqual(
    result.ordinals,
    [[0], [0, 1], [0, 1], [0, 1], [0, 1], [0, 1], [0, 1, 2]],
    'cloze ordinals must match what the {{cN::}} syntax specifies',
  );

  assert.ok(result.decks.includes(deckName), `deck ${deckName} should exist after import`);
  assert.ok(result.notetypes.includes('Custom Cloze'), 'the Custom Cloze notetype should be created');
  assert.ok(result.media.includes('slide.jpg'), 'referenced media should be installed into the profile');
});
