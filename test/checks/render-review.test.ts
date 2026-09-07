// Differential tests for the render_review.py port, per
// docs/research/render-review-and-conventions.md Part 1. Real `python3 tools/
// render_review.py` output is compared byte-for-byte against renderReview()'s return
// value, with ANKI_MEDIA pinned to a real scratch directory on both sides so neither run
// depends on whether this host happens to have Anki installed (same reasoning as
// differential.test.ts's media-dir handling).
//
// One deliberate, documented divergence from the Python original: §1.3.1 of that doc
// names a real inconsistency in render_review.py - the page header reads
// `data[0].get("deck_name", "")`, snake_case, while every documented deck.json note (the
// shared DeckNote type included) uses AnkiConnect's own camelCase `deckName`. Against any
// input actually shaped like DeckNote, that snake_case read is dead code - it always
// returns "". Since DeckNote has no snake_case field for a faithful port to even read, and
// replicating "always blank the header" would make the port worse than the tool it is
// replacing, renderReview() is specified to read `deckName` (camelCase) instead. Every
// differential case below accounts for this by ALSO giving the Python-side JSON payload a
// matching snake_case `deck_name` on note 0 - so both sides are asked to render the same
// semantic "deck name for display," and the comparison stays a true diff on everything
// else (CSS, per-cloze face markup, image resolution, escaping).
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DeckNote } from '../../dist/types.js';
import { renderReview } from '../../dist/checks/index.js';
import { runRenderReviewPython, makeMediaDir, makeScratchDir } from './helpers.ts';

function note(text: string, opts: { extra?: string; tags?: string[]; source?: string } = {}): DeckNote {
  return {
    deckName: 'Fixtures::Reference Cards',
    modelName: 'Custom Cloze',
    fields: { Text: text, Extra: opts.extra ?? '', Source: opts.source ?? 'S' },
    tags: opts.tags ?? [],
  };
}

// Runs both renderers on the same notes and returns their outputs for a direct diff.
// `deckName` is injected into the Python payload as snake_case `deck_name` on note 0 only
// (matching what data[0].get("deck_name","") actually reads) - see the file header.
function renderBoth(notes: DeckNote[], mediaDir: string): { py: string; ts: string } {
  const payload = notes.map((n, i) => (i === 0 ? { ...n, deck_name: n.deckName } : n));
  const py = runRenderReviewPython({ payload, mediaDir });
  assert.equal(py.stderr, '', 'render_review.py should never write to stderr on a successful run');
  assert.equal(py.status, 0, 'render_review.py should exit 0 on a successful run');
  assert.ok(py.html !== null, 'render_review.py should have written an output file');
  return { py: py.html as string, ts: renderReview(notes, { mediaDir }) };
}

test('a three-note deck spanning all three shapes matches byte-for-byte', () => {
  const mediaDir = makeMediaDir(['slide.jpg', 'slide5.jpg']);
  const notes: DeckNote[] = [
    note('{{c1::<b>Osteoid</b>::what?}} is {{c2::<i>unmineralized bone matrix</i>::what is it?}}', {
      source: 'Slide 1',
      tags: ['reference', 'ref-01'],
    }),
    note(
      'The {{c1::<b>epiphyseal growth</b>::which?}} <b>plate</b> has five <u>zones</u>:<br><br>' +
        '1. {{c2::<i>resting cartilage</i>::which?}}<br>2. {{c2::<i>proliferating cartilage</i>}}<br>' +
        '3. {{c2::<i>hypertrophic cartilage</i>}}<br>4. {{c2::<i>calcified cartilage</i>}}<br>' +
        '5. {{c2::<i>ossification</i>}}',
      { source: 'Slide 5', extra: '<img src="slide5.jpg">', tags: ['reference', 'ref-05'] },
    ),
    note('{{c1::<img src="slide.jpg">}}<br><br>This is {{c2::<i>compact bone</i>::which tissue?}}', {
      source: 'Slide 6',
      tags: ['reference', 'ref-06'],
    }),
  ];
  const { py, ts } = renderBoth(notes, mediaDir);
  assert.equal(ts, py);
});

test('zero notes: exit 0, empty deck name, "0 notes"', () => {
  const mediaDir = makeScratchDir();
  const py = runRenderReviewPython({ payload: { notes: [] }, mediaDir });
  assert.equal(py.status, 0);
  assert.equal(renderReview([], { mediaDir }), py.html);
});

test('single- and double-quoted img src are both rewritten identically', () => {
  const mediaDir = makeMediaDir(['a.jpg', 'b.jpg']);
  const notes: DeckNote[] = [
    note('<img src="a.jpg"><br><br>This is {{c1::<i>bone</i>::which tissue?}}'),
    note("<img src='b.jpg'><br><br>This is {{c1::<i>bone</i>::which tissue?}}"),
  ];
  const { py, ts } = renderBoth(notes, mediaDir);
  assert.equal(ts, py);
});

// The IMAGE_SRC pattern's captured character class excludes ":" entirely - a src value
// that already contains a colon (an absolute URL, a data: URI, an already-built file:
// URL) fails to match past the colon and is left completely untouched. This looks like a
// deliberate "don't touch an absolute URL" rule but is really just a side effect of the
// character class - and the port must reproduce the effect either way.
test('a src containing a colon (an external URL) is left completely untouched', () => {
  const mediaDir = makeScratchDir();
  const notes: DeckNote[] = [
    note('<img src="http://example.com/remote.jpg"><br><br>This is {{c1::<i>bone</i>::which tissue?}}'),
  ];
  const { py, ts } = renderBoth(notes, mediaDir);
  assert.equal(ts, py);
  assert.ok(ts.includes('src="http://example.com/remote.jpg"'), 'the external URL must survive verbatim');
});

test('a src with a nested relative path is rewritten with the full path preserved under mediaDir', () => {
  const mediaDir = makeMediaDir(['already/nested/path.jpg']);
  const notes: DeckNote[] = [
    note('<img src="already/nested/path.jpg"><br><br>This is {{c1::<i>bone</i>::which tissue?}}'),
  ];
  const { py, ts } = renderBoth(notes, mediaDir);
  assert.equal(ts, py);
});

// Only Source and the deck-name header ever pass through html.escape; Text and Extra are
// injected as trusted, unescaped HTML (by design - the whole point is rendering the
// <b>/<i>/<u>/<img>/cloze markup as markup). An "&" typed directly into Extra must render
// raw, while the same "&" in Source must come back as "&amp;".
test('Source is HTML-escaped; Extra is injected raw, unescaped', () => {
  const mediaDir = makeScratchDir();
  const notes: DeckNote[] = [
    note('{{c1::<b>Bone</b>::what?}} is {{c2::<i>hard</i>::how hard?}}', {
      source: 'Slide 12 & notes',
      extra: 'H&E. stain',
    }),
  ];
  const { py, ts } = renderBoth(notes, mediaDir);
  assert.equal(ts, py);
  assert.ok(ts.includes('Slide 12 &amp; notes'), 'Source should be escaped');
  assert.ok(ts.includes('H&E. stain'), 'Extra should render raw, not escaped to H&amp;E.');
});

// ref-05's shared-cloze list: [verified] against the real Python original - blanking c2
// hides ALL FIVE list items at once (per-occurrence, not per-ordinal-with-a-borrowed-
// hint). Item 1 shows its own [which?]; items 2-5, which never carried a hint of their
// own, each show a bare [...] rather than inheriting item 1's hint.
test('ref-05 shape: blanking c2 hides all five list items at once, each with its own hint or a bare ellipsis', () => {
  const mediaDir = makeScratchDir();
  const notes: DeckNote[] = [
    note(
      'The {{c1::<b>epiphyseal growth</b>::which?}} <b>plate</b> has five <u>zones</u>:<br><br>' +
        '1. {{c2::<i>resting cartilage</i>::which?}}<br>2. {{c2::<i>proliferating cartilage</i>}}<br>' +
        '3. {{c2::<i>hypertrophic cartilage</i>}}<br>4. {{c2::<i>calcified cartilage</i>}}<br>' +
        '5. {{c2::<i>ossification</i>}}',
    ),
  ];
  const { py, ts } = renderBoth(notes, mediaDir);
  assert.equal(ts, py);
  const c2Front = ts.split('<span class="cn">c2</span>')[1].split('</div>')[0];
  assert.equal((c2Front.match(/class="blank"/g) ?? []).length, 5, 'all five occurrences should be blanked');
  assert.ok(c2Front.includes('[which?]'), 'item 1 keeps its own hint');
  assert.equal((c2Front.match(/\[&hellip;\]/g) ?? []).length, 4, 'items 2-5 show a bare ellipsis, not a borrowed hint');
});

// A recognition card's image sits INSIDE a cloze (ref-06): on c1's front it is blanked
// like any other cloze value; on c2's front and on the back it is revealed, wrapped in
// <span class="cloze"> - visually inert on an <img>, but structurally present.
test('ref-06 shape: the image cloze is blanked on its own front and wrapped in .cloze elsewhere', () => {
  const mediaDir = makeMediaDir(['slide.jpg']);
  const notes: DeckNote[] = [
    note('{{c1::<img src="slide.jpg">}}<br><br>This is {{c2::<i>compact bone</i>::which tissue?}}'),
  ];
  const { py, ts } = renderBoth(notes, mediaDir);
  assert.equal(ts, py);
});
