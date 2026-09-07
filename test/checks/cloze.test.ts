// Unit tests for clozes() against contract §3.1 (CLOZE) and §5.0:
//
//   CLOZE = re.compile(r"\{\{c(\d+)::((?:(?!\}\})[\s\S])*)\}\}")
//
//   def clozes(text):
//       out = []
//       for match in CLOZE.finditer(text):
//           value, separator, hint = match.group(2).partition("::")
//           out.append((match.group(1), value, hint if separator else None))
//       return out
//
// The body is built one character at a time under a negative lookahead forbidding the
// next two characters from being "}}" - so the match stops at the very first "}}" it
// finds. That is what makes "a cloze can never straddle into the next one" (source
// comment, line 39) true, and it is the single most load-bearing regex in this port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clozes } from '../../dist/checks/index.js';

test('a single cloze with a hint', () => {
  assert.deepEqual(clozes('{{c1::<b>Osteoid</b>::what?}}'), [{ number: '1', value: '<b>Osteoid</b>', hint: 'what?' }]);
});

// No "::" anywhere in the body at all -> hint is null, not "" - partition() only ever
// yields a truthy separator when it actually found one.
test('a cloze with no "::" in its body has a null hint, not an empty string', () => {
  assert.deepEqual(clozes('{{c2::<i>resorb bone matrix</i>}}'), [
    { number: '2', value: '<i>resorb bone matrix</i>', hint: null },
  ]);
});

test('leading zeros in the cloze number are preserved as a string', () => {
  assert.deepEqual(clozes('{{c01::<b>X</b>::h?}}'), [{ number: '01', value: '<b>X</b>', hint: 'h?' }]);
});

// The centrepiece behavior: two adjacent clozes, no separating text at all. A body that
// swallowed past its own "}}" would fuse these into one bogus match; the correct result
// is two independent spans.
test('a cloze cannot straddle into the next one - adjacent clozes stay separate', () => {
  assert.deepEqual(clozes('{{c1::AAA}}{{c2::BBB}}'), [
    { number: '1', value: 'AAA', hint: null },
    { number: '2', value: 'BBB', hint: null },
  ]);
});

// A single, unpaired "}" inside the body must NOT end the match - only the exact "}}"
// pair does. This is the direct behavioral test of the negative lookahead's width.
test('a lone closing brace inside the body does not end the match', () => {
  assert.deepEqual(clozes('{{c1::a } b}}'), [{ number: '1', value: 'a } b', hint: null }]);
});

// Contract §11 hazard 15: a value containing a literal "::" is silently truncated at the
// FIRST "::" - both for the value/hint split here. This is existing, intentional-by-
// construction behavior in the original, not a bug the port should route around.
test('a body containing a literal "::" truncates at the first occurrence, not the last', () => {
  assert.deepEqual(clozes('{{c1::3::1::which ratio?}}'), [{ number: '1', value: '3', hint: '1::which ratio?' }]);
});

// finditer() scans left to right and never overlaps - the returned array order is text
// order, not sorted or grouped by cloze number.
test('spans are returned in text order, including repeated numbers (ref-05 shape)', () => {
  const text =
    'The {{c1::<b>growth</b>::which?}} <b>plate</b> has:<br>' +
    '1. {{c2::<i>a</i>::which?}}<br>2. {{c2::<i>b</i>}}<br>3. {{c2::<i>c</i>}}';
  assert.deepEqual(clozes(text), [
    { number: '1', value: '<b>growth</b>', hint: 'which?' },
    { number: '2', value: '<i>a</i>', hint: 'which?' },
    { number: '2', value: '<i>b</i>', hint: null },
    { number: '2', value: '<i>c</i>', hint: null },
  ]);
});

test('no cloze anywhere returns an empty array', () => {
  assert.deepEqual(clozes('plain text, no braces at all'), []);
  assert.deepEqual(clozes(''), []);
});

// [\s\S] is "any character including newline" (Python's idiom, since bare "." excludes
// newline without re.S) - a cloze body may legitimately span multiple lines.
test('a cloze body may contain a literal newline', () => {
  assert.deepEqual(clozes('{{c1::line one\nline two::h?}}'), [
    { number: '1', value: 'line one\nline two', hint: 'h?' },
  ]);
});

// An image tag's own ">" characters must not be mistaken for anything special by the
// cloze scanner - only a literal "}}" pair ends a match, angle brackets are irrelevant.
test('an <img> tag inside a cloze value is captured whole', () => {
  assert.deepEqual(clozes('{{c1::<img src="slide.jpg">}}'), [
    { number: '1', value: '<img src="slide.jpg">', hint: null },
  ]);
});
