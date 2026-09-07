// Field-text transforms needed for the `notes` table -- docs/research/apkg-format.md
// §6. Two independent concerns live here because they share one regex: which
// HTML tags carry a filename worth keeping (img/audio/video/object/source's
// src|data attribute) versus every other tag, which is discarded outright.
//
// This is a deliberate, narrower reimplementation of Anki's own
// strip_html_preserving_media_filenames / strip_html (rslib/src/text.rs), not
// a general HTML parser -- sufficient for this pipeline's authored HTML
// (bold/italic/underline/br/img, occasional entities), not for arbitrary
// third-party markup.
import { createHash } from 'node:crypto';

// Matches one <img|audio|video|object|source ...> tag and captures whichever
// of src="X" / src='X' / src=X (unquoted) / data="X" it carries. Anki's own
// version accepts either attribute name on any of these five tag names
// (verified from source, apkg-format.md §6); this mirrors that rather than
// pairing specific attributes to specific tags.
const MEDIA_TAG_RE =
  /<(?:img|audio|video|object|source)\b[^>]*?\b(?:src|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;

/**
 * Replaces every media tag with `replacer(filename)`; every other tag is left
 * untouched by this pass (stripped later, see stripRemainingTags). Shared by
 * stripHtmlPreservingMediaFilenames (replaces with " filename ") and
 * extractMediaFilenames (replaces with the tag itself, just to collect the
 * name) so both call sites agree on exactly what counts as a media
 * reference -- one regex, not two copies that could drift apart.
 */
function replaceMediaTags(html: string, replacer: (filename: string) => string): string {
  // Fresh RegExp per call: a shared module-level /g instance would carry
  // .lastIndex state across calls, which is a real correctness bug given
  // this function is also called for extraction inside a loop.
  const re = new RegExp(MEDIA_TAG_RE.source, MEDIA_TAG_RE.flags);
  return html.replace(re, (_whole, dq: string | undefined, sq: string | undefined, bare: string | undefined) => {
    return replacer(dq ?? sq ?? bare ?? '');
  });
}

const COMMENT_RE = /<!--[\s\S]*?-->/g;
const STYLE_BLOCK_RE = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const SCRIPT_BLOCK_RE = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const ANY_TAG_RE = /<[^>]*>/g;

// Comments and <style>/<script> blocks are removed *with their contents*;
// any other tag is removed on its own, leaving surrounding text alone --
// matches strip_html_preserving_entities's documented behavior (doc §6).
function stripRemainingTags(html: string): string {
  return html.replace(COMMENT_RE, '').replace(STYLE_BLOCK_RE, '').replace(SCRIPT_BLOCK_RE, '').replace(ANY_TAG_RE, '');
}

// A deliberately small, hand-verified table -- not a full HTML5 named-entity
// list (that would need a dependency or a few thousand hand-copied rows to
// replicate htmlescape::decode_html exactly). Covers what this pipeline's
// own authored HTML actually uses; an entity outside this table is left as
// literal text rather than guessed at. Only "amp" is exercised by the test
// suite (notes.test.ts's H&amp;E case) -- the rest are included because
// lecture-slide HTML routinely carries them, not because any test pins them.
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  deg: '°',
  micro: 'µ',
  times: '×',
  divide: '÷',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  mu: 'μ',
  copy: '©',
  reg: '®',
  trade: '™',
};

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;

// decode_entities: only runs the (comparatively expensive) replace when a
// '&' is even present, then folds any decoded U+00A0 to a plain space --
// doc §6, verified against a real H&amp;E note's stored sfld at the
// codepoint level, not just visually.
function decodeEntities(html: string): string {
  if (!html.includes('&')) return html;
  const decoded = html.replace(ENTITY_RE, (whole: string, body: string) => {
    if (body.charCodeAt(0) === 0x23 /* '#' */) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const codePoint = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body];
    return named ?? whole;
  });
  return decoded.replace(/ /g, ' ');
}

/**
 * strip_html_preserving_media_filenames, then strip_html -- doc §6, the
 * exact function that produces both `sfld` and the csum input. In order:
 * 1. Every media tag -> " <filename> " (filename kept, doctest-verified
 *    shape: "<img src=foo.jpg>" -> " foo.jpg ").
 * 2. Every remaining tag (and comments/style/script) -> removed, no
 *    replacement.
 * 3. HTML entities decoded, then a literal U+00A0 -> plain space.
 */
export function stripHtmlPreservingMediaFilenames(html: string): string {
  const withMediaKept = replaceMediaTags(html, (filename) => ` ${filename} `);
  return decodeEntities(stripRemainingTags(withMediaKept));
}

/**
 * Every filename referenced by a media tag in `html`, entity-decoded then
 * NFC-normalized (doc §3: field text is typically typed/pasted as NFC, so
 * normalizing here is what keeps a later disk lookup from mismatching an
 * NFD-returned directory entry on filesystems that normalize on read).
 * Entity-decoding first matters whenever a filename's own attribute value
 * carries a literal "&amp;"/"&lt;"/etc.: stripHtmlPreservingMediaFilenames
 * (which produces `sfld`/`csum` for the very same tag) decodes entities as
 * part of its own pipeline, so this has to as well, or the two disagree
 * about what the filename even is -- this function would return
 * "a&amp;b.jpg" while sfld/csum reflect "a&b.jpg", and media.ts would then
 * look up a file under a name no real file on disk is ever named. Order is
 * first-occurrence, duplicates included -- callers that need a deduplicated,
 * ordered set (media.ts) do that themselves so this stays a pure extractor.
 */
export function extractMediaFilenames(html: string): string[] {
  const found: string[] = [];
  replaceMediaTags(html, (filename) => {
    if (filename) found.push(decodeEntities(filename).normalize('NFC'));
    return filename;
  });
  return found;
}

// normalize_field's invalid_char_for_field: every ASCII control character
// except \n (0x0A) and \t (0x09) -- doc §6's "Control characters" section.
// This is what guarantees a field's own text can never smuggle in a stray
// 0x1F and corrupt the flds join.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

export function normalizeFieldText(text: string): string {
  return text.replace(CONTROL_CHAR_RE, '');
}

/**
 * field_checksum: first 4 bytes of the field's SHA-1 digest, read
 * big-endian -- doc §6, verified two ways (a real note's stored csum, and
 * independently against `openssl sha1`; see test/apkg/notes.test.ts's own
 * header for the third-implementation cross-check this suite did).
 * Import lazily-shaped: callers pass the already-html-stripped text (the
 * same string used for `sfld` when sortf is field 0, as it always is for
 * Custom Cloze -- doc §6's general rule is csum is always field 0,
 * regardless of sortf, but the two coincide here).
 */
export function fieldChecksum(strippedFieldText: string): number {
  return createHash('sha1').update(strippedFieldText, 'utf8').digest().readUInt32BE(0);
}
