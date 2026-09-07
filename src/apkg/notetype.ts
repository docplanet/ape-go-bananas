// Builds one entry of the `models` JSON blob (col.models) for the Custom
// Cloze notetype -- docs/research/apkg-format.md §5d. Field/template
// content comes from notetype-source.ts (transcribed verbatim from
// anki/custom-cloze.json, never retyped by hand); this file only supplies
// the schema-11 struct shape and the per-export values (id, mod) around it.
//
// Key inclusion follows the doc's required-vs-optional table, read from
// rslib/src/notetype/schema11.rs: every required key is present; optional
// keys are included only where the doc says a real file carries them
// (flds' sticky/rtl/font/size, tmpls' bqfmt/bafmt/did/bfont/bsize, the
// req placeholder) and omitted where the doc says to omit
// (originalStockKind, originalId).
//
// Top-level `did` is the exception the doc got wrong: it reads as optional
// because rslib deserializes it with `default_on_invalid`, but that attribute
// tolerates a bad *value*, not an absent *key*. Without it Anki aborts the
// entire import with `decoding models: missing field 'did'`. See below.
//
// latexPre/latexPost are the one place this file knowingly does not follow
// doc §5d's recommendation ("include the standard boilerplate anyway --
// harmless, matches every real file"): they're left at the schema's own
// optional default, "". Checked, not assumed: anki/custom-cloze.json (this
// notetype's actual, cited source of truth, transcribed into
// notetype-source.ts) is an AnkiConnect `createModel` payload, and that
// action's params have no latexPre/latexPost key at all -- Anki fills in
// whatever its own internal default is when the model is created, and
// nothing this project has captured records what that string actually is.
// "" is schema-valid regardless (`#[serde(default)]`, per the doc) and
// inert for every card this pipeline currently authors -- Custom Cloze's
// own qfmt/afmt (notetype-source.ts) never invoke LaTeX rendering. It would
// stop being inert only if a future note's Text/Extra/Source field itself
// contained literal `[latex]`/`[$]`/`[$$]` markup, since Anki's renderer
// scans rendered field content for that regardless of notetype -- worth
// knowing if that ever changes, not a reason "" is fine on its own.

import {
  CUSTOM_CLOZE_MODEL_NAME,
  CUSTOM_CLOZE_FIELD_NAMES,
  CUSTOM_CLOZE_CSS,
  CUSTOM_CLOZE_TEMPLATE_NAME,
  CUSTOM_CLOZE_QFMT,
  CUSTOM_CLOZE_AFMT,
} from './notetype-source.js';

// Real values for a live Custom Cloze notetype's field config -- doc §5d.
const FIELD_FONT = 'Liberation Sans';
const FIELD_SIZE = 20;

export interface NotetypeField {
  name: string;
  ord: number;
  sticky: boolean;
  rtl: boolean;
  font: string;
  size: number;
}

export interface NotetypeTemplate {
  name: string;
  ord: number;
  qfmt: string;
  afmt: string;
  bqfmt: string;
  bafmt: string;
  did: null;
  bfont: string;
  bsize: number;
}

export interface Notetype {
  id: number;
  name: string;
  type: number;
  mod: number;
  usn: number;
  sortf: number;
  // Required-but-nullable: `default_on_invalid` tolerates a bad value, not a
  // missing key. Verified by importing into a disposable Anki 26.5 collection,
  // which rejects the package outright when this key is absent.
  did: null;
  tmpls: NotetypeTemplate[];
  flds: NotetypeField[];
  css: string;
  latexPre: string;
  latexPost: string;
  latexsvg: boolean;
  req: [number, string, number[]][];
}

/**
 * @param modelId this file's chosen id for the notetype (any value unique
 *   within the file -- doc §8).
 * @param modSeconds "now" at export time, in seconds (doc §5's timestamp
 *   convention: `mod` columns/keys are seconds, unlike col.mod/col.scm).
 */
export function buildCustomClozeModel(modelId: number, modSeconds: number): Notetype {
  return {
    id: modelId,
    name: CUSTOM_CLOZE_MODEL_NAME,
    type: 1, // NotetypeKind::Cloze -- 0 would be Standard (doc §5d, verified from source)
    mod: modSeconds,
    usn: -1,
    sortf: 0, // field index 0 = Text
    did: null,
    tmpls: [
      {
        name: CUSTOM_CLOZE_TEMPLATE_NAME,
        ord: 0,
        qfmt: CUSTOM_CLOZE_QFMT,
        afmt: CUSTOM_CLOZE_AFMT,
        bqfmt: '',
        bafmt: '',
        did: null,
        bfont: '',
        bsize: 0,
      },
    ],
    flds: CUSTOM_CLOZE_FIELD_NAMES.map((name, ord) => ({
      name,
      ord,
      sticky: false,
      rtl: false,
      font: FIELD_FONT,
      size: FIELD_SIZE,
    })),
    css: CUSTOM_CLOZE_CSS,
    // Knowingly not the doc's recommended boilerplate -- see the file
    // header for why "" is what this project can actually stand behind.
    latexPre: '',
    latexPost: '',
    latexsvg: false,
    // Ignored entirely for a cloze notetype by card generation (doc §5d,
    // verified from rslib/src/notetype/cardgen.rs) -- carried anyway
    // because every real cloze notetype sampled still has it.
    req: [[0, 'any', [0]]],
  };
}
