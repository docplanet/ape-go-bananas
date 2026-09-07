// Public API surface for the checks module. Internal file split (cloze/text/magnification/
// transcript/inventory/note/deck/render) is this module's own choice; every consumer -
// test/checks/*, and eventually the CLI/hook layer - imports only from here.
export type { Shape, ClozeSpan } from './cloze.js';
export { shapeOf, clozes } from './cloze.js';

export { normalize, words } from './text.js';

export { zoomWornAsMagnification } from './magnification.js';

export { loadTranscript, sourceQuote, unsourcedQuoteFragments, findWords } from './transcript.js';

export { stem, loadInventory } from './inventory.js';

export type { CheckNoteOptions } from './note.js';
export { checkNote } from './note.js';

export type { CheckDeckOptions, CheckDeckResult, FrequencyEntry, ForeignByNote } from './deck.js';
export { checkDeck, formatCheckReport } from './deck.js';

export type { RenderReviewOptions } from './render.js';
export { renderReview } from './render.js';
