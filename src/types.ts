// Shared contract between the checks, apkg, and acp modules. Keep this file
// to the note shape and the check-result shape only — anything module-specific
// belongs in that module, not here, so the three consumers don't fight over it.

/**
 * The three fields every note in this pipeline carries. Fixed to the single
 * "Custom Cloze" notetype in use throughout — see docs/research/apkg-format.md
 * and docs/research/check-deck-contract.md, both of which assume exactly these
 * three keys and nothing else.
 */
export interface NoteFields {
  Text: string;
  Extra: string;
  Source: string;
}

/**
 * An attached-media reference in the AnkiConnect addNotes sense (bytes to be
 * written into the collection's media folder, keyed by filename). This
 * pipeline normally references media inline instead, via a bare
 * <img src="filename"> in a field's HTML — see apkg-format.md §"media" — so
 * this is here for schema fidelity, not because anything currently emits it.
 * Exactly one of url/data/path carries the bytes, matching AnkiConnect itself.
 */
export interface AnkiConnectMediaRef {
  filename: string;
  url?: string;
  data?: string;
  path?: string;
}

/**
 * A single note, shaped exactly like an AnkiConnect addNotes payload entry.
 * This is the note shape deck.json arrays are made of, at every pipeline
 * stage from organize through export.
 */
export interface DeckNote {
  deckName: string;
  modelName: string;
  fields: NoteFields;
  tags: string[];
  picture?: AnkiConnectMediaRef[];
}

/**
 * One result from a structural check. `noteIndex` points into whatever
 * DeckNote[] was checked (its position in the array, not an Anki note id,
 * since a not-yet-imported note has no id yet); omit it for a deck-wide
 * finding that isn't about any single note.
 *
 * Deliberately minimal: no severity, no rule id, no fix-it payload. A check
 * module that wants those layers on top defines them itself.
 */
export interface Finding {
  message: string;
  noteIndex?: number;
}
