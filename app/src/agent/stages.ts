// The stage rail and what each stage does, over whichever host is running
// the engine. Writing stages run the method through the agent and show
// the artifact behind a gate; review stages show an existing artifact; the
// audit stage runs the whole-deck auditor in a fresh session, merges its
// findings with the owner's flags, and hands them to an adjudicator; the
// writer then applies the verdicts verbatim. Nothing here decides what a
// card says; the method text and the agent do.

import {
  WRITING_STAGES,
  makeRunner,
  type AuditFinding,
  type Runner,
  type StageId,
} from '../../../dist/pipeline/index.js';
import { EngineError, type ConnectResult, type Flag, type SidecarClient } from '../engine/client.js';

export const STAGES: readonly StageId[] = ['extract', 'inventory review', 'organize', 'plan review', 'cards', 'deck preview', 'audit', 'deliver'];

export interface StageHost {
  sidecar: SidecarClient;
  courseDir(): string | null;
  deckName(): string;
  say(text: string, isError?: boolean): void;
  showView(name: 'agent' | 'deck'): void;
  /** Loads `<courseDir>/deck.json` into the deck view (checks, preview, flags). */
  openDeck(courseDir: string): Promise<void>;
  /** Exports the currently open deck. */
  exportDeck(): Promise<void>;
  /** Extracts text and page images beside every PDF that has none yet; runs before the extract stage. */
  prepareMaterials(courseDir: string): Promise<void>;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function next(stage: StageId): StageId | null {
  const i = STAGES.indexOf(stage);
  return i >= 0 && i + 1 < STAGES.length ? STAGES[i + 1]! : null;
}

export interface Stages {
  /** Called once an agent is connected; before that only the two deck stages work. */
  setConnection(conn: ConnectResult | null): void;
  run(stage: StageId): Promise<void>;
  refreshMarks(): Promise<void>;
}

export function mountStages(rail: HTMLOListElement, gate: HTMLElement, host: StageHost): Stages {
  const { sidecar } = host;
  let runner: Runner | null = null;
  /** What is running, or null. Named rather than a flag so the rail can mark it and the refusal can say which. */
  let busy: string | null = null;
  /** Stages the user asked to run again despite an artifact already existing. */
  const force = new Set<StageId>();

  // Each step is a button, and says so: the first person through this screen
  // read the list as a progress display and asked how to start the process.
  rail.innerHTML = STAGES.map(
    (s) => `<li data-stage="${s}" role="button" tabindex="0" title="Run ${esc(s)}"><span class="sname">${esc(s)}</span><span class="sstate"></span></li>`,
  ).join('');

  function setStage(name: StageId): void {
    rail.querySelectorAll<HTMLLIElement>('li').forEach((li) => li.classList.toggle('on', li.dataset.stage === name));
  }

  /**
   * A stage takes minutes -- the PDFs are read, then an agent writes -- and
   * the status line is one line that anything else can overwrite. So the step
   * itself carries the state, where it cannot be clobbered.
   */
  function setBusy(label: string | null): void {
    busy = label;
    rail.querySelectorAll<HTMLLIElement>('li').forEach((li) => li.classList.toggle('running', li.dataset.stage === label));
    rail.setAttribute('aria-busy', label === null ? 'false' : 'true');
  }

  async function refreshMarks(): Promise<void> {
    const dir = host.courseDir();
    if (!dir) return;
    try {
      const { artifacts } = await sidecar.listCourse(dir);
      const done: Record<string, boolean> = { extract: artifacts.inventory, organize: artifacts.plan, cards: artifacts.deck, 'deck preview': artifacts.deck };
      rail.querySelectorAll<HTMLLIElement>('li').forEach((li) => li.classList.toggle('done', !!done[li.dataset.stage!]));
    } catch {
      /* no folder yet */
    }
  }

  function showGate(html: string): void {
    gate.innerHTML = html;
    gate.hidden = false;
  }

  function showArtifactGate(stage: StageId, artifact: string, text: string | null): void {
    const after = next(stage);
    showGate(`<header class="bar"><span>${esc(artifact)}</span><span class="grow"></span>
      ${after ? `<button data-go="${after}">Looks right → ${esc(after)}</button>` : ''}<button data-reread="${esc(artifact)}" class="quiet">Re-read</button><button data-close="1" class="quiet">Close</button></header>
      <pre class="artifact">${text === null ? `(no ${esc(artifact)} was written — ask the agent in the chat below)` : esc(text)}</pre>`);
  }

  async function run(stage: StageId): Promise<void> {
    const dir = host.courseDir();
    if (!dir) return host.say('choose a course folder first', true);
    if (!runner) {
      if (stage === 'deck preview') return void host.openDeck(dir);
      if (stage === 'deliver') return void host.exportDeck();
      return host.say('connect an agent first', true);
    }
    // Not an error: the previous click is still working. Saying which, and
    // where to watch it, is the whole of what the person needed to know.
    if (busy) return host.say(`${busy} is still running — watch the chat on the right, or press Stop there to cancel it`);
    setStage(stage);
    host.showView('agent');
    const writing = WRITING_STAGES.find((w) => w.id === stage);
    try {
      if (writing) {
        setBusy(stage);
        if (stage === 'extract') await host.prepareMaterials(dir);
        host.say(`running ${stage}…`);
        const r = await runner.run(writing);
        host.say(r.stopReason === 'end_turn' ? `${stage} finished` : `${stage} stopped: ${r.stopReason}`, r.stopReason !== 'end_turn');
        showArtifactGate(stage, writing.artifact, r.artifactText);
      } else if (stage === 'inventory review' || stage === 'plan review') {
        const artifact = stage === 'inventory review' ? 'inventory.md' : 'plan.md';
        const text = await sidecar.readCourse(dir, artifact).then((r) => r.text, () => null);
        showArtifactGate(stage, artifact, text);
      } else if (stage === 'deck preview') {
        await host.openDeck(dir);
      } else if (stage === 'audit') {
        // Resumable: if audit.md is already beside the deck -- from an earlier
        // run, or a run this page lost to a reload -- show it and offer the
        // adjudicator rather than paying for the audit again. "Re-run" is
        // there for when the deck has changed since.
        const existing = await sidecar.readCourse(dir, 'audit.md').then((r) => r.text, () => null);
        if (existing !== null && !force.has('audit')) {
          const { flags } = await sidecar.readFlags(`${dir}/deck.json`);
          showGate(`<header class="bar"><span>audit.md (already written) · ${flags.length} flag(s) to adjudicate</span><span class="grow"></span>
            ${flags.length ? '<button data-adjudicate="1">Adjudicate</button>' : ''}<button data-rerun="audit" class="quiet">Re-run audit</button><button data-close="1" class="quiet">Close</button></header>
            <pre class="artifact">${esc(existing)}</pre>`);
          host.say('audit.md is already there — adjudicate, or re-run the audit');
          return;
        }
        force.delete('audit');
        // The method's run-sheet: an auditor who wrote none of the cards reads
        // the whole deck first; its findings and the owner's flags then go to
        // a separate adjudicator. The owner sees the report before that step.
        setBusy(stage);
        host.say('auditing the whole deck in a fresh session…');
        const a = await runner.audit();
        const deckPath = `${dir}/deck.json`;
        const { flags } = await sidecar.readFlags(deckPath);
        const merged: Flag[] = [
          ...flags,
          ...a.findings.filter((f: AuditFinding) => f.card > 0).map((f: AuditFinding) => ({ noteIndex: f.card - 1, note: `[${f.angle}] ${f.finding}`, at: new Date().toISOString() })),
        ];
        await sidecar.writeFlags(deckPath, merged);
        showGate(`<header class="bar"><span>audit.md · ${a.findings.length} finding(s), ${flags.length} owner flag(s)</span><span class="grow"></span>
          ${merged.length ? `<button data-adjudicate="1">Adjudicate ${merged.length}</button>` : ''}<button data-close="1" class="quiet">Close</button></header>
          <pre class="artifact">${a.report === null ? '(no audit.md was written)' : esc(a.report)}</pre>`);
        host.say(a.stopReason === 'end_turn' ? `audit filed ${a.findings.length} finding(s)` : `auditor stopped: ${a.stopReason}`, a.stopReason !== 'end_turn');
      } else if (stage === 'deliver') {
        await host.exportDeck();
      }
    } catch (err) {
      host.say(err instanceof EngineError ? err.message : String(err), true);
    } finally {
      setBusy(null);
      void refreshMarks();
    }
  }

  async function adjudicate(): Promise<void> {
    const dir = host.courseDir();
    if (!dir || !runner) return;
    const { flags } = await sidecar.readFlags(`${dir}/deck.json`);
    if (flags.length === 0) return host.say('nothing is flagged', true);
    if (busy) return host.say(`${busy} is still running — watch the chat on the right`);
    setBusy('adjudicate');
    host.say(`adjudicating ${flags.length} flag(s) in a fresh session…`);
    try {
      const r = await runner.adjudicate(flags);
      showGate(`<header class="bar"><span>verdicts.md</span><span class="grow"></span>
        ${r.verdicts !== null ? '<button data-apply="1">Apply verdicts</button>' : ''}<button data-close="1" class="quiet">Close</button></header>
        <pre class="artifact">${r.verdicts === null ? '(no verdicts.md was written)' : esc(r.verdicts)}</pre>`);
      host.say(r.stopReason === 'end_turn' ? 'verdicts in — review them, then apply' : `adjudicator stopped: ${r.stopReason}`, r.stopReason !== 'end_turn');
    } catch (err) {
      host.say(err instanceof EngineError ? err.message : String(err), true);
    } finally {
      setBusy(null);
    }
  }

  async function applyVerdicts(): Promise<void> {
    const dir = host.courseDir();
    if (!dir || !runner) return;
    if (busy) return host.say(`${busy} is still running — watch the chat on the right`);
    setBusy('applying verdicts');
    host.say('writer applying verdicts…');
    try {
      const r = await runner.applyVerdicts();
      host.say(r.stopReason === 'end_turn' ? 'verdicts applied — re-checking the deck' : `writer stopped: ${r.stopReason}`, r.stopReason !== 'end_turn');
      gate.hidden = true;
      // The flags were the adjudicator's input; once its verdicts are applied
      // they are resolved, and their note indexes no longer line up with a
      // deck that may have lost cards. Clear them before the reload, so the
      // deck view does not show sixteen stale flags on a clean deck.
      if (r.stopReason === 'end_turn') await sidecar.writeFlags(`${dir}/deck.json`, []).catch(() => undefined);
      await host.openDeck(dir);
    } catch (err) {
      host.say(err instanceof EngineError ? err.message : String(err), true);
    } finally {
      setBusy(null);
      void refreshMarks();
    }
  }

  rail.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-stage]');
    if (li) void run(li.dataset.stage as StageId);
  });
  rail.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-stage]');
    if (!li) return;
    e.preventDefault();
    void run(li.dataset.stage as StageId);
  });

  gate.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    const dir = host.courseDir();
    if (!b || !dir) return;
    if (b.dataset.close) gate.hidden = true;
    else if (b.dataset.go) void run(b.dataset.go as StageId);
    else if (b.dataset.reread) {
      const text = await sidecar.readCourse(dir, b.dataset.reread).then((r) => r.text, () => null);
      const pre = gate.querySelector('pre');
      if (pre) pre.textContent = text ?? `(no ${b.dataset.reread})`;
    } else if (b.dataset.adjudicate) void adjudicate();
    else if (b.dataset.apply) void applyVerdicts();
    else if (b.dataset.rerun) {
      force.add(b.dataset.rerun as StageId);
      void run(b.dataset.rerun as StageId);
    }
  });

  return {
    setConnection(conn) {
      const dir = host.courseDir();
      runner = conn && conn.session && dir ? makeRunner(sidecar, conn, dir, host.deckName) : null;
    },
    run,
    refreshMarks,
  };
}
