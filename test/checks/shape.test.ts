// Unit tests for shapeOf() against contract §4, verbatim:
//
//   def shape_of(text):
//       stripped = text.lstrip()
//       if stripped.startswith("{{c1::<img"):
//           return "ref-06"
//       if stripped.startswith("<img"):
//           return "ref-07"
//       return "prose"
//
// This one function is the sole determinant of shape for every shape-dependent check, so
// its exact literal-prefix, non-generalizing behavior is worth pinning on its own before
// any rule that reads `shape` is trusted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeOf } from '../../dist/checks/index.js';

test('ref-06: exact literal "{{c1::<img" prefix', () => {
  assert.equal(shapeOf('{{c1::<img src="slide.jpg">}}<br>This is {{c2::<i>bone</i>}}'), 'ref-06');
});

test('ref-07: exact literal "<img" prefix, no cloze wrapping it', () => {
  assert.equal(shapeOf('<img src="slide.jpg">This is {{c1::<i>bone</i>}}'), 'ref-07');
});

test('prose: neither literal prefix matches', () => {
  assert.equal(shapeOf('{{c1::<b>Osteoid</b>}} is {{c2::<i>bone matrix</i>}}'), 'prose');
  assert.equal(shapeOf('plain text with no markup at all'), 'prose');
  assert.equal(shapeOf(''), 'prose');
});

// Contract §4's explicitly load-bearing detail: "hard-coded to cloze number 1
// specifically - a card whose image cloze is numbered c2 (or any number other than 1) is
// not detected as ref-06 by this test, and falls through." It falls all the way through
// to prose, since "{{c2::<img" also fails the plain "<img" literal-prefix test.
test('an image clozed as c2 (not c1) is prose, not ref-06 - shape detection does not generalize the "1"', () => {
  assert.equal(shapeOf('{{c2::<img src="slide.jpg">}}<br>This is {{c1::<i>bone</i>}}'), 'prose');
});

test('leading whitespace is stripped before either prefix test', () => {
  assert.equal(shapeOf('   {{c1::<img src="slide.jpg">}}'), 'ref-06');
  assert.equal(shapeOf('\n\t <img src="slide.jpg">'), 'ref-07');
});

// Case-sensitive, markup-literal: no normalization happens before the prefix test.
test('the prefix test is case-sensitive', () => {
  assert.equal(shapeOf('{{C1::<img src="x.jpg">}}'), 'prose');
  assert.equal(shapeOf('{{c1::<IMG src="x.jpg">}}'), 'prose');
  assert.equal(shapeOf('<IMG src="x.jpg">'), 'prose');
});

// Only the front of the field decides ref-07 - an image anywhere else in the text is a
// plain prose card as far as shape_of is concerned (its own image-visibility rules are a
// different, later check, not part of shape detection).
test('an <img> not at the very front of the field is prose', () => {
  assert.equal(shapeOf('Some lead-in text <img src="x.jpg"> then {{c1::<i>bone</i>}}'), 'prose');
});

// ref-07's test is a bare 4-character prefix, not a tag-shaped regex - "<img" immediately
// followed by any character (not just a tag delimiter) still counts, since there is no
// boundary check at all after the literal.
test('ref-07 prefix has no trailing boundary check', () => {
  assert.equal(shapeOf('<imgsrc="x.jpg">'), 'ref-07');
});
