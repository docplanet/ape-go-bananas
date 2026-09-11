// render_review.py, ported - docs/research/render-review-and-conventions.md Part 1. Turns
// a deck.json into one self-contained HTML review page: every note's front faces (one per
// distinct cloze ordinal), its single shared back face, and its Extra block, with images
// resolved against a media directory so a staged slide renders without opening Anki.
//
// The five PAGE_PART_N constants below are the exact literal segments of render_review.py's
// own %-format template, split at its five placeholders (title deck, title count, h1 deck,
// sub count, articles) and with its "%%" escape already folded to a literal "%" - extracted
// mechanically from the Python source (not hand-transcribed) so this file is provably
// byte-identical to the original's CSS/script/markup shell. See render-review.test.ts for
// the live differential proof against `python3 tools/render_review.py`.
import type { DeckNote } from '../types.js';
import { clozes } from './cloze.js';
import { RENDER_IMAGE_SRC_RE } from './regex.js';
import { htmlEscape, pyOsPathJoin } from './pystrings.js';

// A separate CLOZE regex from check_deck.py's own (same pattern, same "stops at the first
// }}" technique) - the two files do not share a module in the original, and render()'s own
// substitution logic (blank-vs-reveal) is specific to this file, not to clozes()/note.ts.
const RENDER_CLOZE_RE = /\{\{c(\d+)::((?:(?!\}\})[\s\S])*)\}\}/g;

/** The card text with cloze `blank` shown as its [hint] (or a bare ellipsis if that
 *  occurrence carries none) and every OTHER cloze revealed. Blanking is per-occurrence,
 *  not per-ordinal: a shared-hint ref-05 list blanks every occurrence of that ordinal at
 *  once, each with its own hint or lack of one - never borrowing item 1's hint. */
function renderFace(text: string, blank: string | null): string {
  return text.replace(RENDER_CLOZE_RE, (_match, number: string, body: string) => {
    const sep = body.indexOf('::');
    const value = sep === -1 ? body : body.slice(0, sep);
    const hint = sep === -1 ? null : body.slice(sep + 2);
    if (number === blank) {
      return `<span class="blank">[${hint !== null ? hint : '&hellip;'}]</span>`;
    }
    return `<span class="cloze">${value}</span>`;
  });
}

/** Points a bare media filename at the collection so the browser can render it. The
 *  captured filename class excludes ":" entirely, so anything already absolute (a URL, a
 *  data: URI, an already-built file: URL) fails to match past the colon and is left
 *  completely untouched - a side effect of the character class, not a scheme check, but
 *  one the port must reproduce exactly (docs/research §1.5). */
function localImages(markup: string, mediaDir: string, resolve?: (filename: string) => string | undefined): string {
  return markup.replace(RENDER_IMAGE_SRC_RE, (_match, prefix: string, filename: string) => {
    return `${prefix}"file://${resolve?.(filename) ?? pyOsPathJoin(mediaDir, filename)}"`;
  });
}

export interface RenderReviewOptions {
  /** Used verbatim via a plain join, no expanduser/absolutize - like ANKI_MEDIA itself. */
  mediaDir?: string;
  /**
   * Where an image actually is, when the deck carries its own media list
   * (the app's decks do): consulted first; undefined falls back to the
   * mediaDir join above. Not part of render_review.py's contract.
   */
  resolveMedia?: (filename: string) => string | undefined;
}

const PAGE_PART_0 = '<!doctype html><meta charset="utf-8"><title>';
const PAGE_PART_1 = ' &mdash; ';
const PAGE_PART_2 =
  ' notes</title>\n<style>:root{color-scheme:dark}\nbody{font-family:Menlo,ui-monospace,monospace;background:#333B45;color:#D7DEE9;margin:0;padding:24px 16px 80px;line-height:1.55}\n.wrap{max-width:900px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}\n.sub{color:#839496;font-size:13px;margin-bottom:20px}\narticle{background:#2c343d;border-radius:8px;padding:14px 16px;margin:0 0 12px}\n.idx{color:#6b7883;font-size:11px;margin-bottom:8px}.face{margin:6px 0;font-size:17px}\n.cn{color:#6b7883;font-size:11px;margin-right:10px;vertical-align:2px}\nb{color:#C695C6}i{color:IndianRed;font-style:normal}u{color:#5EB3B3}\n.cloze{font-weight:bold;color:MediumSeaGreen}.blank{color:#E8C07D;font-weight:bold}\n.extra{color:#9aa7b4;font-size:13px;border-top:1px solid #3d4753;margin-top:10px;padding-top:8px;display:none}\nimg{max-width:100%;border-radius:6px;margin:8px 0}\nbody.x .extra{display:block}body.f .backs{display:none}body.b .fronts{display:none}\nbar{position:fixed;bottom:0;left:0;right:0;background:#252c34;border-top:1px solid #3d4753;padding:10px;display:flex;gap:8px;justify-content:center}\nbutton{background:#3b4654;color:#D7DEE9;border:1px solid #51606e;border-radius:6px;padding:6px 14px;font-family:inherit;font-size:13px;cursor:pointer}\nbutton.on{background:#5EB3B3;color:#1d2329}</style>\n<div class="wrap"><h1>';
const PAGE_PART_3 = '</h1>\n<div class="sub">';
const PAGE_PART_4 =
  ' notes &middot; <b>subject</b> &middot; <u>facet</u> &middot; <i>value</i> &middot; <span class="blank">[hint]</span></div>\n';
const PAGE_PART_5 =
  '</div>\n<bar><button id="bf" class="on">Fronts</button><button id="bb">Backs</button><button id="bx">Extras</button></bar>\n<script>const B=document.body;B.className=\'f\';\nfunction m(x){B.classList.remove(\'f\',\'b\');B.classList.add(x);\nbf.classList.toggle(\'on\',x===\'f\');bb.classList.toggle(\'on\',x===\'b\')}\nbf.onclick=()=>m(\'f\');bb.onclick=()=>m(\'b\');\nbx.onclick=()=>{bx.classList.toggle(\'on\',B.classList.toggle(\'x\'))};</script>\n';

export function renderReview(notes: DeckNote[], opts: RenderReviewOptions = {}): string {
  const mediaDir = opts.mediaDir ?? '';
  const resolveMedia = opts.resolveMedia;

  const articles = notes.map((note, i) => {
    const position = i + 1;
    const fields = note.fields;
    const text = fields.Text;
    const numbers = [...new Set(clozes(text).map((s) => s.number))].sort((a, b) => Number(a) - Number(b));
    const fronts = numbers
      .map((n) => `<div class="face"><span class="cn">c${n}</span>${localImages(renderFace(text, n), mediaDir, resolveMedia)}</div>`)
      .join('');
    const backs = `<div class="face">${localImages(renderFace(text, null), mediaDir, resolveMedia)}</div>`;
    const extra = fields.Extra ?? '';
    return (
      `<article><div class="idx">${position} &middot; ${htmlEscape(fields.Source ?? '')}</div>` +
      `<div class="fronts">${fronts}</div><div class="backs">${backs}</div>` +
      `<div class="extra">${localImages(extra, mediaDir, resolveMedia)}</div></article>`
    );
  });

  // Named deviation - do not "fix" this back to snake_case. render_review.py itself reads
  // `data[0].get("deck_name", "")` (see render-review-and-conventions.md §1.3.1), but every
  // documented deck.json note - the DeckNote type included - carries AnkiConnect's own
  // camelCase `deckName`, which the Python original never reads at all. Against the one
  // input shape this pipeline actually produces, the original's snake_case read is dead
  // code: it always renders a blank header. Replicating "always blank" would make this port
  // WORSE than the tool it replaces for every real caller, so this reads `deckName` on
  // purpose. Verified in test/checks/render-review.test.ts, whose own header names this
  // exact inconsistency and compensates by injecting a matching snake_case `deck_name` onto
  // the Python-side payload for every case, so the differential comparison stays meaningful
  // on everything else without ever being able to re-surface this one intentional gap.
  const deck = htmlEscape(notes.length > 0 ? notes[0].deckName ?? '' : '');
  const n = notes.length;

  return (
    PAGE_PART_0 +
    deck +
    PAGE_PART_1 +
    n +
    PAGE_PART_2 +
    deck +
    PAGE_PART_3 +
    n +
    PAGE_PART_4 +
    articles.join('\n') +
    PAGE_PART_5
  );
}
