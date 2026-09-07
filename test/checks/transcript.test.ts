// Unit tests for the transcript-quote check's three layers (contract §6.2):
// loadTranscript (the field-level file -> word-list pipeline), sourceQuote (which text is
// the quote), and unsourcedQuoteFragments/findWords (the fuzzy in-order word matcher).
//
// All expected values below were hand-derived from the algorithms as given verbatim in
// the contract (and cross-checked against a live `python3 tools/check_deck.py` run for
// the "not in transcript" fixture - see differential.test.ts for the full end-to-end
// version of that same case). The full end-to-end wiring (the Source-field gate, and the
// outer repr() wrapping into rule 4's message) is exercised in differential.test.ts;
// these tests isolate each layer's own, precisely-specified behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTranscript, sourceQuote, unsourcedQuoteFragments, findWords } from '../../dist/checks/index.js';

// ---- loadTranscript ----

test('loadTranscript strips WEBVTT header, cue indices, and timestamp lines, then joins and tokenizes', () => {
  const raw = [
    'WEBVTT',
    '',
    '1',
    '00:00:01.000 --> 00:00:03.000',
    'Speaker: The outer layer here is the capsule surrounding the organ.',
    '',
    '2',
    '00:00:03.000 --> 00:00:05.000',
    'Speaker: It protects the tissue beneath from injury.',
  ].join('\n');
  assert.deepEqual(loadTranscript(raw), [
    'the', 'outer', 'layer', 'here', 'is', 'the', 'capsule', 'surrounding', 'the', 'organ',
    'it', 'protects', 'the', 'tissue', 'beneath', 'from', 'injury',
  ]);
});

// The SPEAKER pattern is applied only when at least one TIMESTAMP-matching line exists
// anywhere in the file - otherwise a handout's own "Label: " text would be eaten and a
// quote containing that word could never match. A file with no cue-timing line anywhere
// must pass every kept line through completely unchanged.
test('a non-VTT source keeps its "Label: " prefixes - the SPEAKER pattern never runs', () => {
  const raw = ['Note: This is a handout, not a lecture.', 'Answer: Osteoid is unmineralized matrix.'].join('\n');
  assert.deepEqual(loadTranscript(raw), [
    'note', 'this', 'is', 'a', 'handout', 'not', 'a', 'lecture', 'answer', 'osteoid', 'is',
    'unmineralized', 'matrix',
  ]);
});

// TIMESTAMP's fractional-second group is entirely optional, so a bare "MM:SS -->" (no
// milliseconds at all - the shape Zoom's plain-text export leaves behind) still counts as
// a cue line and still flips on speaker-prefix stripping.
test('a bare "MM:SS -->" cue line (no fractional seconds) is recognized as a timestamp', () => {
  const raw = ['00:00 --> 00:03', 'Dr. Lee: Bone is dense connective tissue.'].join('\n');
  assert.deepEqual(loadTranscript(raw), ['bone', 'is', 'dense', 'connective', 'tissue']);
});

// SPEAKER = ^[^:]{1,40}:\s - a label of exactly 40 non-colon characters still matches and
// is stripped; one character longer never matches at all (no backtracking rescues it,
// since every shorter prefix also fails to land on a colon), and the whole line - label
// included - survives as-is.
test('the speaker-label cap is exactly 40 characters: 40 strips, 41 does not', () => {
  const cue = '00:00 --> 00:03';
  const at40 = 'a'.repeat(40) + ': rest of sentence';
  const at41 = 'a'.repeat(41) + ': rest of sentence';

  assert.deepEqual(loadTranscript([cue, at40].join('\n')), ['rest', 'of', 'sentence']);
  assert.deepEqual(loadTranscript([cue, at41].join('\n')), ['a'.repeat(41), 'rest', 'of', 'sentence']);
});

// ---- sourceQuote ----

test('a straight-double-quoted Source: yields the text between the quotes, normalized', () => {
  assert.equal(sourceQuote('Source: "Quoted Text Here"'), 'quoted text here');
});

test('a straight-single-quoted Source: works the same way', () => {
  assert.equal(sourceQuote("Source: 'quoted text'"), 'quoted text');
});

test('an unquoted, described Source: is not a quotation - returns null', () => {
  assert.equal(sourceQuote('Source: Slide 12 notes'), null);
});

test('no "source:" label anywhere returns null', () => {
  assert.equal(sourceQuote('Just some extra text, no label at all.'), null);
});

test('no Source: content at all after the label returns null', () => {
  assert.equal(sourceQuote('Source:'), null);
});

// rfind (last occurrence of the opening quote character) rather than proper delimiter
// pairing - an internal apostrophe must not be mistaken for the closing double-quote.
test('an internal apostrophe does not confuse the closing double-quote search', () => {
  assert.equal(sourceQuote('Source: "it\'s fine"'), "it's fine");
});

// closing == 0 (the opening quote character never recurs elsewhere in the field): the
// original treats this as an unterminated quote and takes everything to the end.
test('an unterminated quote (no second matching quote character) runs to the end of the field', () => {
  assert.equal(sourceQuote('Source: "unterminated quote text'), 'unterminated quote text');
});

// normalize() runs before SOURCE_LABEL is searched, so curly quotes are already folded to
// straight ones - the label form using curly quotes must resolve identically.
test('curly quotes are folded to straight before the quote-open test', () => {
  assert.equal(sourceQuote('Source: “fancy quoted”'), 'fancy quoted');
});

test('an HTML-wrapped label and entity-encoded curly quotes both work identically to plain ASCII', () => {
  assert.equal(sourceQuote('<b>Source:</b> &ldquo;from markup&rdquo;'), 'from markup');
});

// ---- unsourcedQuoteFragments / findWords ----

test('a fragment whose words are not in the transcript, in order, is reported truncated at 60 chars with an ellipsis', () => {
  const transcript = loadTranscript(
    [
      '00:00:01.000 --> 00:00:03.000',
      'Speaker: The outer layer here is the capsule surrounding the organ.',
      '00:00:03.000 --> 00:00:05.000',
      'Speaker: It protects the tissue beneath from injury.',
    ].join('\n'),
  );
  const extra =
    'Source: "the outer layer here is the capsule surrounding the organ, ' +
    'and this part was never spoken at all"';
  assert.deepEqual(unsourcedQuoteFragments(extra, transcript), [
    'the outer layer here is the capsule surrounding the organ an...',
  ]);
});

test('a quote split by "..." into two pieces, both present in order, reports nothing missing', () => {
  const transcript = loadTranscript(
    [
      '00:00:01.000 --> 00:00:03.000',
      'Speaker: The outer layer here is the capsule surrounding the organ.',
      '00:00:03.000 --> 00:00:05.000',
      'Speaker: It protects the tissue beneath from injury.',
    ].join('\n'),
  );
  const extra = 'Source: "the outer layer here is the capsule ... it protects the tissue beneath from injury"';
  assert.deepEqual(unsourcedQuoteFragments(extra, transcript), []);
});

// The cursor only ever advances: a second piece whose words occur only BEFORE where the
// first piece matched cannot be found "again," even though it is present earlier in the
// transcript - the quote's pieces cannot be assembled out of order.
test('a piece whose words appear only before the cursor is reported missing, not found out of order', () => {
  const transcript = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'];
  const extra = 'Source: "gamma delta epsilon zeta eta ... alpha beta gamma delta epsilon"';
  assert.deepEqual(unsourcedQuoteFragments(extra, transcript), ['alpha beta gamma delta epsilon']);
});

// A piece yielding fewer than 5 words is skipped entirely - it never advances the cursor
// and never itself gets reported, even when it would not have been findable.
test('a piece shorter than 5 words is skipped entirely, in both directions', () => {
  const transcript = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  const extra = 'Source: "ab cd ... alpha beta gamma delta epsilon"';
  assert.deepEqual(unsourcedQuoteFragments(extra, transcript), []);
});

test('an unquoted Source: (no verifiable quote) yields no fragments at all', () => {
  assert.deepEqual(unsourcedQuoteFragments('Source: Slide 12 notes', ['whatever', 'words', 'are', 'here', 'now']), []);
});

// findWords in isolation: the slack budget is a single shared pool for the whole
// fragment, not per-gap, and the boundary is strict ">" (exactly at the budget succeeds).
test('findWords: skipping exactly the slack budget still succeeds', () => {
  const transcript = ['a', 'x', 'x', 'x', 'x', 'b', 'c']; // 4 junk words between a and b
  assert.equal(findWords(['a', 'b', 'c'], transcript, 0), 7);
});

test('findWords: skipping one more than the slack budget fails that start and returns -1', () => {
  const transcript = ['a', 'x', 'x', 'x', 'x', 'x', 'b', 'c']; // 5 junk words - one too many
  assert.equal(findWords(['a', 'b', 'c'], transcript, 0), -1);
});

test('findWords: a failed start retries at the next occurrence of the fragment\'s first word', () => {
  // First "a" (index 0) cannot reach "b" within slack; the second "a" (index 6) can.
  const transcript = ['a', 'x', 'x', 'x', 'x', 'x', 'a', 'b', 'c'];
  assert.equal(findWords(['a', 'b', 'c'], transcript, 0), 9);
});

test('findWords: the start parameter excludes every earlier occurrence', () => {
  const transcript = ['a', 'b', 'a', 'b', 'c'];
  assert.equal(findWords(['a', 'b', 'c'], transcript, 2), 5);
  assert.equal(findWords(['a', 'b', 'c'], transcript, 3), -1); // no "a" left at/after index 3
});

test('findWords: fragment not present at all returns -1', () => {
  assert.equal(findWords(['nope'], ['a', 'b', 'c'], 0), -1);
});
