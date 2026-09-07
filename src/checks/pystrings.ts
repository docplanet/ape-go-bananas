// Python string-semantics shims. check_deck.py and render_review.py lean on a handful of
// Python-specific string behaviors (repr() quote selection, splitlines()'s wider line-break
// set, split()'s no-empty-tokens rule, rstrip(char) stripping every trailing occurrence,
// strip()'s wider whitespace set, os.path.join's absolute-segment-wins rule, string slicing
// by code point rather than UTF-16 code unit, and html.(un)escape's exact entity set) that
// do not fall out of the obvious JS equivalent. Isolated here so every call site in the port
// is provably using the replicated behavior, not a native JS method that looks equivalent
// but silently diverges on an edge case - see docs/research/check-deck-contract.md §11 for
// the hazard each one is standing in for.
import { HTML5_ENTITIES } from './html-entities.js';

// Python's str.isprintable(): false for every character in Unicode category Cc (control),
// Cf (format, e.g. U+200B ZERO WIDTH SPACE, U+FEFF BOM), Cs (surrogate), Co (private use),
// Cn (unassigned), Zl/Zp (line/paragraph separator), or Zs (space separator) OTHER than the
// ASCII space U+0020 itself - which Python special-cases back to printable. repr() escapes
// exactly this set (see pyRepr below); everything else is passed through untouched.
const NONPRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/**
 * Python's repr() for a plain string, per contract §11 hazard 6: single-quoted by default;
 * switches to double-quoted only when the string contains a `'` but no `"`; otherwise falls
 * back to single-quoted with internal `'` backslash-escaped. Backslashes and control
 * characters are backslash-escaped; ordinary printable non-ASCII characters are not touched,
 * but a non-printable one (U+00A0 NBSP, U+00AD soft hyphen, U+200B ZWSP, ...) is - Python's
 * own `\xNN`/`\uNNNN`/`\UNNNNNNNN` width rule, chosen by the code point's own magnitude, not
 * by whether it happens to be BMP.
 */
export function pyRepr(value: string): string {
  const hasSingle = value.includes("'");
  const hasDouble = value.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";
  let out = quote;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\') {
      out += '\\\\';
    } else if (ch === quote) {
      out += '\\' + quote;
    } else if (ch === '\n') {
      out += '\\n';
    } else if (ch === '\r') {
      out += '\\r';
    } else if (ch === '\t') {
      out += '\\t';
    } else if (code < 0x20 || code === 0x7f) {
      out += '\\x' + code.toString(16).padStart(2, '0');
    } else if (ch !== ' ' && NONPRINTABLE_RE.test(ch)) {
      if (code < 0x100) out += '\\x' + code.toString(16).padStart(2, '0');
      else if (code < 0x10000) out += '\\u' + code.toString(16).padStart(4, '0');
      else out += '\\U' + code.toString(16).padStart(8, '0');
    } else {
      out += ch;
    }
  }
  return out + quote;
}

/**
 * Python's repr() of a list of plain strings - rules 18/19's `{numbers}` placeholder.
 * The elements here are always bare digit strings (never containing a quote themselves),
 * so pyRepr never needs its quote-switching logic in practice, but it is still the
 * correct primitive to reuse rather than hand-rolling a narrower quoting rule.
 */
export function pyListRepr(items: string[]): string {
  return '[' + items.map(pyRepr).join(', ') + ']';
}

/**
 * Python's str.split() with no arguments: splits on runs of whitespace, and - unlike a
 * naive JS `.split(/\s+/)` - never produces a leading/trailing empty token for
 * leading/trailing whitespace in the source (contract §11 hazard 9).
 */
export function pySplit(text: string): string[] {
  const trimmed = text.trim();
  return trimmed === '' ? [] : trimmed.split(/\s+/);
}

/** Python's str.rstrip(char): strips every trailing occurrence of `char`, not just one. */
export function pyRStrip(text: string, char: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === char) end--;
  return text.slice(0, end);
}

// Every code point str.isspace() (and therefore argument-less str.strip()) treats as
// whitespace - the full 29-character set, confirmed against this project's own python3
// (`[i for i in range(0x110000) if chr(i).isspace()]`) rather than transcribed from memory.
// Notably wider than JS's own \s (includes \x1c-\x1f, U+0085, U+3000, ...) and notably NOT
// including U+FEFF, which JS's \s treats as whitespace but Python's isspace() does not.
const PY_WHITESPACE_CLASS =
  '\\t\\n\\x0b\\x0c\\r\\x1c\\x1d\\x1e\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_STRIP_LEADING_RE = new RegExp(`^[${PY_WHITESPACE_CLASS}]+`);
const PY_STRIP_TRAILING_RE = new RegExp(`[${PY_WHITESPACE_CLASS}]+$`);

/** Python's str.strip() with no arguments: trims Python's own whitespace set from both
 *  ends, which is neither a strict subset nor superset of JS's `.trim()` (contract §11 -
 *  JS's `.trim()` also strips U+FEFF, which Python's does not; Python's also strips
 *  U+001C-U+001F, which JS's does not). */
export function pyStrip(text: string): string {
  return text.replace(PY_STRIP_LEADING_RE, '').replace(PY_STRIP_TRAILING_RE, '');
}

/** Python's `text[:n]`: a prefix slice counted in code points, not UTF-16 code units - a
 *  naive JS `.slice(0, n)` cuts mid-surrogate-pair for any text containing an astral
 *  character (emoji, mathematical alphanumerics, ...) before position n, both shifting the
 *  cut point and risking a lone surrogate in the output. */
export function pySlice(text: string, end: number): string {
  return [...text].slice(0, end).join('');
}

/** Python's os.path.join(a, b) (POSIX semantics - the only platform this pipeline targets):
 *  plain concatenation with a "/" separator EXCEPT that an absolute `b` (one starting with
 *  "/") discards `a` entirely and is returned verbatim (contract §11 hazard 4) - Node's own
 *  path.join has no such special case and would instead produce a nonsensical nested path.
 *  Shared by note.ts's media-existence check and render.ts's media-src resolution, which
 *  independently hit the identical hazard on the identical kind of input (a `src` value). */
export function pyOsPathJoin(a: string, b: string): string {
  if (b.startsWith('/')) return b;
  if (a === '' || a.endsWith('/')) return a + b;
  return `${a}/${b}`;
}

/**
 * Python's str.splitlines(): splits on a wider set of line boundaries than `\n`/`\r\n`
 * (also \v, \f, \x1c-\x1e, NEL, U+2028, U+2029 - contract §11 hazard 8), and - unlike a
 * plain regex .split() - never emits a trailing empty element for a source that ends
 * exactly on a boundary.
 */
export function pySplitLines(text: string): string[] {
  const boundary = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;
  const lines: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(text)) !== null) {
    lines.push(text.slice(last, m.index));
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    lines.push(text.slice(last));
  }
  return lines;
}

// Named-reference lookup, built once from html-entities.ts's generated, complete HTML5
// table (2231 names - Python's `html.entities.html5`, not a hand-picked subset: a table
// covering only "the entities this project's fixtures happen to use" is exactly what let a
// 36-entry version through code review while silently mis-decoding every deck that used a
// Greek letter, an arrow, an uppercase name, or a non-semicolon legacy form - see the
// generated file's own header). A Map, not the plain object it was generated as, so a
// lookup can never accidentally hit something inherited from Object.prototype (a body of
// literally "constructor" or "toString" would otherwise resolve to a function, not
// `undefined`) - `in`/bracket access on a bare object literal carries that risk, `Map#get`
// does not.
const NAMED_ENTITY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(HTML5_ENTITIES));

// html.unescape's own numeric-charref special cases, transcribed from CPython's
// html/__init__.py (itself citing the WHATWG "numeric character reference end state":
// https://html.spec.whatwg.org/multipage/parsing.html#numeric-character-reference-end-state)
// and cross-checked against this project's own python3 (`html._invalid_charrefs`,
// `html._invalid_codepoints`) rather than hand-copied from spec prose alone.
//
// The Windows-1252 remap for the C1 control range (0x80-0x9F) plus the two special-cased
// ASCII points (NUL -> U+FFFD, CR -> itself) that the numeric-charref algorithm applies
// before falling through to the generic surrogate/out-of-range/noncharacter rules below.
const INVALID_CHARREFS: ReadonlyMap<number, string> = new Map([
  [0x00, '\ufffd'], [0x0d, '\r'],
  [0x80, '\u20ac'], [0x81, '\u0081'], [0x82, '\u201a'], [0x83, '\u0192'],
  [0x84, '\u201e'], [0x85, '\u2026'], [0x86, '\u2020'], [0x87, '\u2021'],
  [0x88, '\u02c6'], [0x89, '\u2030'], [0x8a, '\u0160'], [0x8b, '\u2039'],
  [0x8c, '\u0152'], [0x8d, '\u008d'], [0x8e, '\u017d'], [0x8f, '\u008f'],
  [0x90, '\u0090'], [0x91, '\u2018'], [0x92, '\u2019'], [0x93, '\u201c'],
  [0x94, '\u201d'], [0x95, '\u2022'], [0x96, '\u2013'], [0x97, '\u2014'],
  [0x98, '\u02dc'], [0x99, '\u2122'], [0x9a, '\u0161'], [0x9b, '\u203a'],
  [0x9c, '\u0153'], [0x9d, '\u009d'], [0x9e, '\u017e'], [0x9f, '\u0178'],
]);

// Control characters and Unicode noncharacters: the numeric-charref algorithm maps these to
// the EMPTY STRING, not U+FFFD - that fallback is reserved for a genuinely out-of-range
// value or a surrogate (handled separately in decodeNumericCharRef below).
const INVALID_CODEPOINTS: ReadonlySet<number> = new Set([
  0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8, 0xb,
  0xe, 0xf, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19,
  0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x7f,
  0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b,
  0x8c, 0x8d, 0x8e, 0x8f, 0x90, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97,
  0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f,
  0xfdd0, 0xfdd1, 0xfdd2, 0xfdd3, 0xfdd4, 0xfdd5, 0xfdd6, 0xfdd7, 0xfdd8,
  0xfdd9, 0xfdda, 0xfddb, 0xfddc, 0xfddd, 0xfdde, 0xfddf, 0xfde0, 0xfde1,
  0xfde2, 0xfde3, 0xfde4, 0xfde5, 0xfde6, 0xfde7, 0xfde8, 0xfde9, 0xfdea,
  0xfdeb, 0xfdec, 0xfded, 0xfdee, 0xfdef,
  0xfffe, 0xffff, 0x1fffe, 0x1ffff, 0x2fffe, 0x2ffff, 0x3fffe, 0x3ffff,
  0x4fffe, 0x4ffff, 0x5fffe, 0x5ffff, 0x6fffe, 0x6ffff, 0x7fffe, 0x7ffff,
  0x8fffe, 0x8ffff, 0x9fffe, 0x9ffff, 0xafffe, 0xaffff, 0xbfffe, 0xbffff,
  0xcfffe, 0xcffff, 0xdfffe, 0xdffff, 0xefffe, 0xeffff, 0xffffe, 0xfffff,
  0x10fffe, 0x10ffff,
]);

// Python's `html._charref`: "&" then either a numeric reference (decimal or hex, trailing
// ";" optional) or a run of up to 32 characters that are none of tab/LF/FF/space/"<"/"&"/
// "#"/";" (trailing ";" again optional) - deliberately NOT "letters only": this is what lets
// `&amp` (no ";") and `&notit;` (a real prefix, "not;", plus leftover "it;") both reach
// decodeNamedCharRef below, which the old 36-entry table's `[a-zA-Z][a-zA-Z0-9]*;`-shaped
// regex could never match at all.
const ENTITY_RE = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g;

function decodeNumericCharRef(body: string): string {
  const isHex = body[1] === 'x' || body[1] === 'X';
  const digits = isHex ? body.slice(2) : body.slice(1);
  const num = parseInt(digits.endsWith(';') ? digits.slice(0, -1) : digits, isHex ? 16 : 10);
  const invalid = INVALID_CHARREFS.get(num);
  if (invalid !== undefined) return invalid;
  if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return '\ufffd';
  if (INVALID_CODEPOINTS.has(num)) return '';
  return String.fromCodePoint(num);
}

/** Python's `_replace_charref`'s named-reference branch: an exact match first, then the
 *  LONGEST matching PREFIX of the captured run (tried from full length down to 2 characters
 *  - never shorter, matching Python's `range(len(s)-1, 1, -1)` exactly), with whatever
 *  wasn't part of that prefix appended back on raw. This is what turns `&notit;` into
 *  `\u00acit;` (prefix `not;` -> "\u00ac", plus the leftover `it;`) rather than leaving it
 *  untouched or (worse) matching some unrelated shorter name. No match at any length: the
 *  original text, "&" and all, is returned unchanged - a syntactically entity-shaped run
 *  that names nothing is not an error, just inert. */
function decodeNamedCharRef(body: string): string {
  const exact = NAMED_ENTITY_MAP.get(body);
  if (exact !== undefined) return exact;
  for (let x = body.length - 1; x > 1; x--) {
    const prefix = NAMED_ENTITY_MAP.get(body.slice(0, x));
    if (prefix !== undefined) return prefix + body.slice(x);
  }
  return '&' + body;
}

/**
 * Python's html.unescape, ported call-for-call from CPython's html/__init__.py - not an
 * approximation of it. Critical-severity finding: a 36-entry hand table with a
 * named-entities-only, semicolon-required, lowercase-only regex diverged from this on
 * ordinary course material in six distinct ways (missing Greek letters/arrows/typographic
 * entities entirely, wrong nbsp codepoint, no longest-prefix/no-semicolon fallback,
 * case-sensitivity, and wrong numeric edge cases) - including flipping a clean deck's exit
 * code to 1 on nothing more exotic than a trailing `&ensp;`. See html-entities.ts for the
 * named-reference table and decodeNamedCharRef/decodeNumericCharRef above for the two
 * branches of `_replace_charref`.
 */
export function htmlUnescape(text: string): string {
  if (!text.includes('&')) return text; // Python's own fast path - also skips a no-op regex pass
  return text.replace(ENTITY_RE, (_match, body: string) =>
    body[0] === '#' ? decodeNumericCharRef(body) : decodeNamedCharRef(body),
  );
}

/** Python's html.escape(s, quote=True): order matters - & must be escaped first. */
export function htmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
