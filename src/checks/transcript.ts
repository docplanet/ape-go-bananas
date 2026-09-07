// The Source: quote vs. --transcript check, in full - contract §6.2. Three layers: a
// transcript file -> word-list loader, a Source-quote extractor, and a fuzzy, in-order,
// forward-only word matcher. The field-level gate that decides whether this check runs at
// all (fields.Source containing "transcript") lives in note.ts, not here - these functions
// only do the word-matching work once that gate has already said yes.
import { CUE_INDEX_RE, OPEN_QUOTE, QUOTE_GAP_RE, SOURCE_LABEL_RE, SPEAKER_RE, TIMESTAMP_RE } from './regex.js';
import { pySlice, pySplitLines } from './pystrings.js';
import { normalize, words } from './text.js';

const MIN_FRAGMENT_WORDS = 5; // shorter pieces match by accident

/**
 * The spoken words of one transcript source, run together - contract §6.2's
 * load_transcript(). Strips WEBVTT headers, cue-index lines, and TIMESTAMP lines; strips a
 * leading "Speaker: " prefix from every kept line, but ONLY when the file contains at
 * least one TIMESTAMP line anywhere (a plain-text handout passed via --transcript must
 * keep its own "Note: "/"Answer: " labels intact, or a quote containing that word could
 * never match). Multiple --transcript sources are concatenated by the caller, in the
 * order given on the command line - this function handles exactly one source's raw text.
 */
export function loadTranscript(rawText: string): string[] {
  const strippedLines = pySplitLines(rawText).map((line) => line.trim());
  const isTranscript = strippedLines.some((line) => TIMESTAMP_RE.test(line));
  const kept = strippedLines.filter(
    (line) => line !== '' && line !== 'WEBVTT' && !TIMESTAMP_RE.test(line) && !CUE_INDEX_RE.test(line),
  );
  const spoken = kept.map((line) => (isTranscript ? line.replace(SPEAKER_RE, '') : line));
  return words(normalize(spoken.join(' ')));
}

/**
 * The quoted text after "Source:", or null when the card cites something unquoted -
 * contract §6.2's source_quote(). Operates on the normalize()'d Extra field, so a
 * "<b>Source:</b> ..." markup label and a "Source: &ldquo;...&rdquo;" entity-encoded one
 * resolve identically. The closing quote is the LAST occurrence of the same quote
 * character in the remainder (rfind, not delimiter pairing) - deliberate, so an internal
 * apostrophe in the quote itself is never mistaken for the closing mark.
 */
export function sourceQuote(extra: string): string | null {
  const label = SOURCE_LABEL_RE.exec(normalize(extra));
  if (!label) return null;
  const rest = label[1].replace(/^\s+/, '');
  if (!rest || !OPEN_QUOTE.includes(rest[0])) return null; // a described source, not a quotation
  const quoteChar = rest[0];
  const closing = rest.lastIndexOf(quoteChar); // rfind: the quote may contain an apostrophe
  return closing > 0 ? rest.slice(1, closing) : rest.slice(1);
}

/**
 * Where `fragment`'s words run, in order, from `start` on - or -1. Not a substring match:
 * an exact-token, forward-only, in-order subsequence match tolerating up to a single
 * shared `slack` budget of other words interspersed anywhere among the fragment's words
 * combined (never per-gap, never reordering) - contract §6.2's find_words(), verbatim.
 */
export function findWords(fragment: string[], transcript: string[], start: number): number {
  const slack = Math.max(4, Math.floor(fragment.length / 4));
  for (let begin = start; begin < transcript.length; begin++) {
    if (transcript[begin] !== fragment[0]) continue;
    let at = begin;
    let skipped = 0;
    let ok = true;
    for (const word of fragment) {
      while (at < transcript.length && transcript[at] !== word) {
        at++;
        skipped++;
        if (skipped > slack) break;
      }
      if (skipped > slack || at >= transcript.length) {
        ok = false;
        break;
      }
      at++;
    }
    if (ok) return at;
  }
  return -1;
}

/**
 * Pieces of the card's Source quote that are not in the transcript it claims to come
 * from - contract §6.2's unsourced_quote_fragments(). The quote is split on "...", the
 * ellipsis glyph, or a "[...]" span into pieces (the parts on either side of an omission
 * or an editorial insertion); each surviving piece (>= 5 words) must be found in order,
 * never earlier than where the previous piece was found.
 */
export function unsourcedQuoteFragments(extra: string, transcript: string[]): string[] {
  const quote = sourceQuote(extra);
  if (quote === null) return [];
  const missing: string[] = [];
  let cursor = 0;
  for (const piece of quote.split(QUOTE_GAP_RE)) {
    const fragment = words(piece);
    if (fragment.length < MIN_FRAGMENT_WORDS) continue;
    const position = findWords(fragment, transcript, cursor);
    if (position < 0) {
      // Code-point slicing (not `.slice`'s UTF-16 code units), matching Python's `text[:60]`
      // - unreachable today, since `fragment` is always words()'s [a-z0-9&]-only output and
      // so never contains an astral character, but a bare `.slice` here would silently stop
      // being safe the moment that upstream guarantee ever changed.
      const text = fragment.join(' ');
      missing.push(pySlice(text, 60) + ([...text].length > 60 ? '...' : ''));
    } else {
      cursor = position;
    }
  }
  return missing;
}
