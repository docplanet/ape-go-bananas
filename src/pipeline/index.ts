// The pipeline as prompts and a runner -- docs/APP.md: each stage hands the
// agent the bundled method file, the course folder and its materials, and
// asks for that step's artifact beside them; the adjudicator is a fresh
// session that wrote none of the cards, and the writer applies its verdicts
// verbatim. Nothing here says what a card is; the method text does.
//
// Over an injected client, so the desktop app (app/, through Tauri) and the
// browser page (site/, through the bridge) run the same stages with the same
// prompts. It began as app/src/pipeline.ts; the app kept a copy for a while,
// by a rule that it imports nothing from the engine at build time, and the
// copy silently missed `companions` and `describeExtracted` -- so the rule
// went, and there is one pipeline (docs/APP.md, "Where it lives").

import type { ContentBlock } from '../acp/protocol.js';
import type { Flag } from '../sidecar/methods.js';

export type { ContentBlock, Flag };

/** What a course folder listing looks like to the prompts: course/list's `files`. */
export interface CourseFileLike {
  relPath: string;
  kind: string;
  bytes: number;
  mimeType: string;
}

/** What the page extracted from one source file, beside it: course/list's `extracted`. */
export interface ExtractedLike {
  source: string; // relPath of the PDF
  text: string | null; // relPath of text.md, when written
  images: string[]; // relPaths of the page images, in page order
}

/** The subset of the sidecar surface the stages need, however it is reached. */
export interface PipelineClient {
  readMethod(name: string): Promise<{ text: string }>;
  listCourse(path: string): Promise<{ files: CourseFileLike[]; extracted?: ExtractedLike[] }>;
  readCourse(path: string, name: string): Promise<{ text: string }>;
  newSession(connectionId: string): Promise<{ session: { sessionId: string } }>;
  prompt(sessionId: string, blocks: ContentBlock[]): Promise<{ stopReason: string }>;
  /**
   * True for a failure the sidecar reported (a JSON-RPC error such as an
   * artifact not being there yet), which the runner tolerates; anything
   * else is a bug and is rethrown.
   */
  isRpcError(err: unknown): boolean;
}

/** An open agent connection with its writer session: agent/connect's result. */
export interface ConnectionLike {
  connectionId: string;
  session: { sessionId: string } | null;
}

export type StageId = 'extract' | 'inventory review' | 'organize' | 'plan review' | 'cards' | 'deck preview' | 'audit' | 'deliver';

interface WritingStage {
  id: StageId;
  method: string; // method file name
  artifact: string; // what the stage writes beside the material
  ask: string; // the one app-side sentence: which folder, which artifact
  companions?: string[]; // other method-repo files this step refers to by name; attached so the agent never searches for them
}

export const WRITING_STAGES: WritingStage[] = [
  { id: 'extract', method: '1-extract.md', artifact: 'inventory.md', ask: 'Run this step on the course folder below and write inventory.md beside the material.', companions: ['SETUP.md'] },
  { id: 'organize', method: '2-organize.md', artifact: 'plan.md', ask: 'Run this step on the course folder below: inventory.md is already there; write plan.md beside it.' },
  {
    id: 'cards',
    method: '3-cards.md',
    artifact: 'deck.json',
    ask: 'Run this step on the course folder below: plan.md and inventory.md are already there. Write deck.json beside them and stop there -- this app runs the structural checks and renders the review itself, and nothing is inserted into Anki from here.',
  },
];

const ATTACH_LIMIT = 20 * 1024 * 1024; // embedded attachments above this are listed by path only

function fileUri(dir: string, rel: string): string {
  return `file://${encodeURI(`${dir.replace(/\/$/, '')}/${rel}`)}`;
}

function describe(files: CourseFileLike[]): string {
  return files.map((f) => `- ${f.relPath} (${f.kind}, ${(f.bytes / 1024).toFixed(0)} KB)`).join('\n');
}

/**
 * The paragraph that stops the agent probing for PDF tooling: what the page
 * already extracted, where it is, and that nothing needs converting. Empty
 * when nothing was extracted, so a folder of plain text reads as before.
 */
export function describeExtracted(extracted: ExtractedLike[]): string {
  const lines = extracted
    .filter((e) => e.text !== null || e.images.length > 0)
    .map((e) => {
      const parts: string[] = [];
      if (e.text) parts.push(`${e.text} (the text of every page, under "## Page N" headings)`);
      if (e.images.length > 0) parts.push(e.images.length === 1 ? `one page image, ${e.images[0]}` : `${e.images.length} page images, ${e.images[0]} … ${e.images[e.images.length - 1]}`);
      return `- ${e.source} → ${parts.join('; ')}`;
    });
  if (lines.length === 0) return '';
  return `\n\nAlready extracted beside the material by this app, with no tools:\n${lines.join('\n')}\nRead those instead of converting the source; do not look for pdftotext, pypdf or any other tooling. The text can carry stray spaces inside words where the PDF's fonts have odd widths ("c opied"); for exact wording, the page image is the authority.`;
}

/** The prompt for a writing stage: method as the system block, the ask, the listing, then the materials as links. */
export async function stageBlocks(client: PipelineClient, stage: WritingStage, courseDir: string, deckName: string): Promise<ContentBlock[]> {
  const [method, course] = await Promise.all([client.readMethod(stage.method), client.listCourse(courseDir)]);
  // A bridge started before SETUP.md was fetched, or APE_METHOD_DIR pointing at a
  // bare method/ checkout, has no companion to give: the stage runs without it
  // rather than failing on a file the agent can live without.
  const extras = (await Promise.all((stage.companions ?? []).map((name) => client.readMethod(name).then((r) => ({ name, text: r.text }), () => null)))).filter((e) => e !== null);
  const materials = course.files.filter((f) => f.kind !== 'other');
  // The method asks the user for the deck name and refuses to infer it
  // (a live run without one wrote "Deck: not supplied"); the app collects it.
  const deckLine = deckName ? `Deck: ${deckName}` : 'Deck: not supplied by the user';
  const attached = extras.length > 0 ? `\n\n${extras.map((e) => e.name).join(', ')} from the method repository ${extras.length === 1 ? 'is' : 'are'} attached below; do not search the file system for ${extras.length === 1 ? 'it' : 'them'}.` : '';
  const extracted = course.extracted ?? [];
  const blocks: ContentBlock[] = [
    { type: 'resource', resource: { uri: 'ape://system', text: method.text, mimeType: 'text/markdown' } },
    { type: 'text', text: `${stage.ask}${attached}\n\n${deckLine}\nCourse folder: ${courseDir}\n\nMaterials:\n${describe(materials) || '(none)'}${describeExtracted(extracted)}` },
    ...extras.map((e): ContentBlock => ({ type: 'resource', resource: { uri: `ape://method/${e.name}`, text: e.text, mimeType: 'text/markdown' } })),
  ];
  for (const f of materials) {
    if ((f.kind === 'pdf' || f.kind === 'image' || f.kind === 'text') && f.bytes <= ATTACH_LIMIT) {
      blocks.push({ type: 'resource_link', uri: fileUri(courseDir, f.relPath), name: f.relPath, mimeType: f.mimeType });
    }
  }
  // The extracted text is linked, not inlined: the agent reads it when it
  // gets there, and a 60-page lecture is not paid for twice in one prompt.
  for (const e of extracted) {
    if (e.text) blocks.push({ type: 'resource_link', uri: fileUri(courseDir, e.text), name: e.text, mimeType: 'text/markdown' });
  }
  return blocks;
}

export interface AuditFinding {
  card: number; // 1-based; 0 for a deck-wide (coverage) finding
  angle: 'truth' | 'fluency' | 'coverage' | 'style' | string;
  finding: string;
}

/** The auditor's prompt: the deck-auditor brief as the system block, the step-3 method for its reference cards, the deck. A fresh session that wrote none of the cards. */
export async function auditBlocks(client: PipelineClient, courseDir: string): Promise<ContentBlock[]> {
  const [brief, method, deck] = await Promise.all([client.readMethod('4-audit.md'), client.readMethod('3-cards.md'), client.readCourse(courseDir, 'deck.json')]);
  return [
    { type: 'resource', resource: { uri: 'ape://system', text: brief.text, mimeType: 'text/markdown' } },
    {
      type: 'text',
      text: `Audit the deck in the course folder below. The seven reference cards your brief tells you to read first are at the top of the attached step-3 method; review.html is already rendered beside deck.json, so do not run render_review.py. Cards are numbered from 1 in deck.json array order. Write your findings to audit.md beside the deck -- all four angles of your brief -- and ALSO write audit.json beside it: a JSON array of objects { "card": <number>, "angle": "truth"|"fluency"|"coverage"|"style", "finding": "<one or two sentences>" }, one per finding that names a specific card (a coverage finding with no card uses "card": 0). Edit nothing else.\n\nCourse folder: ${courseDir}`,
    },
    { type: 'resource', resource: { uri: 'ape://method/3-cards.md', text: method.text, mimeType: 'text/markdown' } },
    { type: 'resource', resource: { uri: fileUri(courseDir, 'deck.json'), text: deck.text, mimeType: 'application/json' } },
  ];
}

/** The adjudicator's prompt: method 3, the deck, the flags -- and a verdict per flag, written beside the deck. */
export async function adjudicateBlocks(client: PipelineClient, courseDir: string, flags: Flag[]): Promise<ContentBlock[]> {
  const [method, deck] = await Promise.all([client.readMethod('3-cards.md'), client.readCourse(courseDir, 'deck.json')]);
  const list = flags.map((f, i) => `${i + 1}. card #${f.noteIndex + 1}: ${f.note || '(no note -- the reviewer flagged it without saying why; judge the card on the method alone)'}`).join('\n');
  return [
    { type: 'resource', resource: { uri: 'ape://system', text: method.text, mimeType: 'text/markdown' } },
    {
      type: 'text',
      text: `You are the adjudicator for a deck you did not write. You wrote none of these cards. For each flag below, read the card in deck.json (cards are numbered from 1 in array order) against the method above and the sources in the course folder, and return exactly one verdict per flag: "approve" with one sentence saying why the card stands as written, "fix" with the complete corrected Text/Extra/Source fields, or "cut" if the card should not exist. Write the verdicts to verdicts.md beside deck.json, numbered like the flags, and nothing else.\n\nCourse folder: ${courseDir}\n\nFlags:\n${list}`,
    },
    { type: 'resource', resource: { uri: fileUri(courseDir, 'deck.json'), text: deck.text, mimeType: 'application/json' } },
  ];
}

/** The writer applies the adjudicator's verdicts verbatim -- the standing rule, as wiring. */
export async function applyVerdictsBlocks(client: PipelineClient, courseDir: string): Promise<ContentBlock[]> {
  const verdicts = await client.readCourse(courseDir, 'verdicts.md');
  return [
    {
      type: 'text',
      text: `An adjudicator who wrote none of the cards has ruled on the flagged ones. Apply every "fix" verdict below to deck.json exactly as written -- do not re-judge, soften, or improve on them -- remove every card with a "cut" verdict, and leave every "approve" card as it is. Keep the array order of surviving cards. Rewrite deck.json in place and stop.\n\nCourse folder: ${courseDir}\n\n${verdicts.text}`,
    },
  ];
}

export interface Runner {
  run(stage: WritingStage): Promise<{ stopReason: string; artifactText: string | null }>;
  /** The whole-deck read the method's run-sheet calls step 3: a fresh session files findings; nothing is edited. */
  audit(): Promise<{ stopReason: string; report: string | null; findings: AuditFinding[] }>;
  adjudicate(flags: Flag[]): Promise<{ stopReason: string; verdicts: string | null }>;
  applyVerdicts(): Promise<{ stopReason: string }>;
}

export function makeRunner(client: PipelineClient, conn: ConnectionLike, courseDir: string, deckName: () => string): Runner {
  const writer = conn.session!.sessionId;
  return {
    async run(stage) {
      const blocks = await stageBlocks(client, stage, courseDir, deckName());
      const { stopReason } = await client.prompt(writer, blocks);
      let artifactText: string | null = null;
      try {
        artifactText = (await client.readCourse(courseDir, stage.artifact)).text;
      } catch (err) {
        if (!client.isRpcError(err)) throw err;
      }
      return { stopReason, artifactText };
    },
    async audit() {
      const fresh = await client.newSession(conn.connectionId);
      const { stopReason } = await client.prompt(fresh.session.sessionId, await auditBlocks(client, courseDir));
      const report = await client.readCourse(courseDir, 'audit.md').then((r) => r.text, () => null);
      let findings: AuditFinding[] = [];
      try {
        const raw = JSON.parse((await client.readCourse(courseDir, 'audit.json')).text) as unknown;
        if (Array.isArray(raw)) findings = raw.filter((f): f is AuditFinding => typeof f === 'object' && f !== null && typeof (f as AuditFinding).finding === 'string');
      } catch {
        /* no machine-readable findings: the report still shows */
      }
      return { stopReason, report, findings };
    },
    async adjudicate(flags) {
      const fresh = await client.newSession(conn.connectionId);
      const blocks = await adjudicateBlocks(client, courseDir, flags);
      const { stopReason } = await client.prompt(fresh.session.sessionId, blocks);
      let verdicts: string | null = null;
      try {
        verdicts = (await client.readCourse(courseDir, 'verdicts.md')).text;
      } catch (err) {
        if (!client.isRpcError(err)) throw err;
      }
      return { stopReason, verdicts };
    },
    async applyVerdicts() {
      return client.prompt(writer, await applyVerdictsBlocks(client, courseDir));
    },
  };
}
