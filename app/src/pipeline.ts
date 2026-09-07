// The pipeline as screens (APP.md): each stage hands the agent the bundled
// method file, the course folder and its materials, and asks for that
// step's artifact beside them; each review gate shows the artifact and
// waits. Nothing here says what a card is -- the method text does. The
// adjudicator (audit) is a fresh session on the same connection that has
// written none of the cards, and the writer applies its verdicts verbatim.
import { sidecar, SidecarError, type ConnectResult, type ContentBlock, type CourseFile, type Flag } from './sidecar';

export type StageId = 'extract' | 'inventory review' | 'organize' | 'plan review' | 'cards' | 'deck preview' | 'audit' | 'deliver';

interface WritingStage {
  id: StageId;
  method: string; // method file name
  artifact: string; // what the stage writes beside the material
  ask: string; // the one app-side sentence: which folder, which artifact
}

export const WRITING_STAGES: WritingStage[] = [
  { id: 'extract', method: '1-extract.md', artifact: 'inventory.md', ask: 'Run this step on the course folder below and write inventory.md beside the material.' },
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

function describe(files: CourseFile[]): string {
  return files.map((f) => `- ${f.relPath} (${f.kind}, ${(f.bytes / 1024).toFixed(0)} KB)`).join('\n');
}

/** The prompt for a writing stage: method as the system block, the ask, the listing, then the materials as links. */
export async function stageBlocks(stage: WritingStage, courseDir: string, deckName: string): Promise<ContentBlock[]> {
  const [method, course] = await Promise.all([sidecar.readMethod(stage.method), sidecar.listCourse(courseDir)]);
  const materials = course.files.filter((f) => f.kind !== 'other');
  // The method asks the user for the deck name and refuses to infer it
  // (a live run without one wrote "Deck: not supplied"); the app collects it.
  const deckLine = deckName ? `Deck: ${deckName}` : 'Deck: not supplied by the user';
  const blocks: ContentBlock[] = [
    { type: 'resource', resource: { uri: 'ape://system', text: method.text, mimeType: 'text/markdown' } },
    { type: 'text', text: `${stage.ask}\n\n${deckLine}\nCourse folder: ${courseDir}\n\nMaterials:\n${describe(materials) || '(none)'}` },
  ];
  for (const f of materials) {
    if ((f.kind === 'pdf' || f.kind === 'image' || f.kind === 'text') && f.bytes <= ATTACH_LIMIT) {
      blocks.push({ type: 'resource_link', uri: fileUri(courseDir, f.relPath), name: f.relPath, mimeType: f.mimeType });
    }
  }
  return blocks;
}

export interface AuditFinding {
  card: number; // 1-based; 0 for a deck-wide (coverage) finding
  angle: 'truth' | 'fluency' | 'coverage' | 'style' | string;
  finding: string;
}

/** The auditor's prompt: the deck-auditor brief as the system block, the step-3 method for its reference cards, the deck. A fresh session that wrote none of the cards. */
export async function auditBlocks(courseDir: string): Promise<ContentBlock[]> {
  const [brief, method, deck] = await Promise.all([sidecar.readMethod('4-audit.md'), sidecar.readMethod('3-cards.md'), sidecar.readCourse(courseDir, 'deck.json')]);
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
export async function adjudicateBlocks(courseDir: string, flags: Flag[]): Promise<ContentBlock[]> {
  const [method, deck] = await Promise.all([sidecar.readMethod('3-cards.md'), sidecar.readCourse(courseDir, 'deck.json')]);
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
export async function applyVerdictsBlocks(courseDir: string): Promise<ContentBlock[]> {
  const verdicts = await sidecar.readCourse(courseDir, 'verdicts.md');
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

export function makeRunner(conn: ConnectResult, courseDir: string, deckName: () => string): Runner {
  const writer = conn.session!.sessionId;
  return {
    async run(stage) {
      const blocks = await stageBlocks(stage, courseDir, deckName());
      const { stopReason } = await sidecar.prompt(writer, blocks);
      let artifactText: string | null = null;
      try {
        artifactText = (await sidecar.readCourse(courseDir, stage.artifact)).text;
      } catch (err) {
        if (!(err instanceof SidecarError)) throw err;
      }
      return { stopReason, artifactText };
    },
    async audit() {
      const fresh = await sidecar.newSession(conn.connectionId);
      const { stopReason } = await sidecar.prompt(fresh.session.sessionId, await auditBlocks(courseDir));
      const report = await sidecar.readCourse(courseDir, 'audit.md').then((r) => r.text, () => null);
      let findings: AuditFinding[] = [];
      try {
        const raw = JSON.parse((await sidecar.readCourse(courseDir, 'audit.json')).text) as unknown;
        if (Array.isArray(raw)) findings = raw.filter((f): f is AuditFinding => typeof f === 'object' && f !== null && typeof (f as AuditFinding).finding === 'string');
      } catch {
        /* no machine-readable findings: the report still shows */
      }
      return { stopReason, report, findings };
    },
    async adjudicate(flags) {
      const fresh = await sidecar.newSession(conn.connectionId);
      const blocks = await adjudicateBlocks(courseDir, flags);
      const { stopReason } = await sidecar.prompt(fresh.session.sessionId, blocks);
      let verdicts: string | null = null;
      try {
        verdicts = (await sidecar.readCourse(courseDir, 'verdicts.md')).text;
      } catch (err) {
        if (!(err instanceof SidecarError)) throw err;
      }
      return { stopReason, verdicts };
    },
    async applyVerdicts() {
      return sidecar.prompt(writer, await applyVerdictsBlocks(courseDir));
    },
  };
}
