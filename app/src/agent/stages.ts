// The steps: the rail on the left says where a run is, the bar at the top
// of the main pane says what is next and runs it with one button. Writing
// stages run the method through the agent and show the artifact behind a
// gate; the review stages are that gate ("Looks right → organize"); the
// preview is the deck view; the audit runs the whole-deck auditor in a
// fresh session, merges its findings with the owner's flags, hands them to
// an adjudicator, and the writer applies the verdicts verbatim; deliver
// exports. Nothing here decides what a card says; the method text and the
// agent do.
//
// What is done is read from the course folder (course/list's artifacts, the
// flags, verdicts.md), so a run picks up where it was left; what was merely
// looked at this session (a review, the preview) is remembered here.

import {
  WRITING_STAGES,
  makeRunner,
  type AuditFinding,
  type Runner,
  type StageId,
} from '../../../dist/pipeline/index.js';
import { EngineError, type ConnectResult, type Flag, type SidecarClient, type SendToAnkiResult } from '../engine/client.js';

export const STAGES: readonly StageId[] = ['extract', 'inventory review', 'organize', 'plan review', 'cards', 'deck preview', 'audit', 'deliver'];

/** One line per step: what it does, shown in the bar before it runs. */
const ABOUT: Record<StageId, string> = {
  extract: 'The agent reads the material and writes inventory.md: every fact, with where it came from.',
  'inventory review': 'Read the inventory. Anything missing or wrong, tell the agent below; continue when it is right.',
  organize: 'The agent turns the inventory into plan.md: which cards, in what order.',
  'plan review': 'Read the plan; continue when it looks right.',
  cards: 'The agent writes deck.json. The structural checks run on it here.',
  'deck preview': 'Every card, rendered. Flag any that are wrong.',
  audit: 'A fresh session that wrote none of the cards reads the whole deck. Its findings and your flags go to an adjudicator; the writer applies the verdicts as written.',
  deliver: 'Export the .apkg beside your material. Double-click it to import into Anki.',
};

export interface StageHost {
  sidecar: SidecarClient;
  courseDir(): string | null;
  deckName(): string;
  say(text: string, isError?: boolean): void;
  /** Puts the agent pane (gate + chat) in the main pane. */
  showAgentView(): void;
  /** Loads `<courseDir>/deck.json` into the deck view and shows it. */
  openDeck(courseDir: string): Promise<void>;
  /** Exports the deck; the path written, or null when the shell saved it some other way (a download) or failed. */
  exportDeck(): Promise<string | null>;
  /** Puts the deck into the running Anki; null when it failed (Anki closed, most often). */
  sendToAnki(): Promise<SendToAnkiResult | null>;
  /** Extracts text and page images beside every PDF that has none yet; runs before the extract stage. */
  prepareMaterials(courseDir: string): Promise<void>;
  openSettings(): void;
  /** Whether the deck has any material to read; extract has nothing to do without it. */
  hasMaterials(): boolean;
  /** Opens the shell's way of adding files (a picker). */
  addFiles(): void;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function next(stage: StageId): StageId | null {
  const i = STAGES.indexOf(stage);
  return i >= 0 && i + 1 < STAGES.length ? STAGES[i + 1]! : null;
}

export interface Stages {
  /** Called when an agent is connected or gone; before that only the two deck stages work. */
  setConnection(conn: ConnectResult | null): void;
  run(stage: StageId): Promise<void>;
  /** Re-reads the folder and redraws the rail and the bar. */
  refresh(): Promise<void>;
}

interface Action {
  stage: StageId;
  button: string;
  hint: string;
  go: () => Promise<void>;
  secondary?: { label: string; go: () => Promise<void> };
}

export function mountStages(rail: HTMLOListElement, bar: HTMLElement, gate: HTMLElement, host: StageHost): Stages {
  const { sidecar } = host;
  let runner: Runner | null = null;
  let writerSession: string | null = null;
  /** What is running, or null. Named rather than a flag so the rail can mark it and the refusal can say which. */
  let busy: string | null = null;
  /** Stages the user asked to run again despite an artifact already existing. */
  const force = new Set<StageId>();
  // What the folder says, as of the last refresh.
  let has = { inventory: false, plan: false, deck: false, audit: false, verdicts: false, flags: 0 };
  // What happened this session and leaves no file: reviews looked at, the preview opened, the export written.
  const reviewed = new Set<StageId>();
  let previewed = false;
  let exportedTo: string | null = null;
  let sentToAnki: string | null = null; // what landed in Anki, once it has
  /** The artifact the gate is showing, if any. */
  let showing: string | null = null;
  /** A run-through is in progress: each stage starts the next until the audit. */
  let through = false;

  // Each step is a button, and says so: the first person through this screen
  // read the list as a progress display and asked how to start the process.
  rail.innerHTML = STAGES.map(
    (s) => `<li data-stage="${s}" role="button" tabindex="0" title="${esc(ABOUT[s])}"><span class="sname">${esc(s)}</span><span class="sstate"></span></li>`,
  ).join('');

  function setStage(name: StageId | null): void {
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
    renderBar();
  }

  // A later artifact implies the earlier steps: a folder with only deck.json
  // in it resumes at the preview, not at extract.
  function done(stage: StageId): boolean {
    switch (stage) {
      case 'extract':
        return has.inventory || has.plan || has.deck;
      case 'inventory review':
        return reviewed.has(stage) || has.plan || has.deck;
      case 'organize':
        return has.plan || has.deck;
      case 'plan review':
        return reviewed.has(stage) || has.deck;
      case 'cards':
        return has.deck;
      case 'deck preview':
        return has.deck && (previewed || has.audit);
      case 'audit':
        return has.audit && !(has.flags > 0);
      case 'deliver':
        return exportedTo !== null;
    }
  }

  /** What the bar offers: the first step not done, with the audit's sub-steps spelled out. */
  function action(): Action {
    const writing = (stage: StageId): Action => ({
      stage,
      button: `Run ${stage}`,
      hint: ABOUT[stage],
      go: () => run(stage),
    });
    // A review is read before it is approved: the first press opens the
    // artifact in the gate, the second is the approval and runs what follows.
    const review = (stage: StageId): Action => {
      const after = next(stage)!;
      const artifact = stage === 'inventory review' ? 'inventory.md' : 'plan.md';
      if (showing !== artifact) return { stage, button: `Read ${artifact}`, hint: ABOUT[stage], go: () => run(stage) };
      return {
        stage,
        button: `Looks right → ${after}`,
        hint: ABOUT[stage],
        go: async () => {
          reviewed.add(stage);
          await run(after);
        },
      };
    };
    if (!has.deck) {
      if (!has.plan) {
        if (!has.inventory && !host.hasMaterials()) return { stage: 'extract', button: 'Add files…', hint: 'Add the lecture\'s files first: slides as PDF, the transcript, the objectives.', go: async () => host.addFiles() };
        if (!has.inventory) return writing('extract');
        if (!reviewed.has('inventory review')) return review('inventory review');
        return writing('organize');
      }
      if (!reviewed.has('plan review')) return review('plan review');
      return writing('cards');
    }
    if (!has.audit && !previewed) return { stage: 'deck preview', button: 'Open the deck', hint: ABOUT['deck preview'], go: () => run('deck preview') };
    if (!has.audit) return { stage: 'audit', button: 'Run audit', hint: ABOUT.audit, go: () => run('audit') };
    if (has.flags > 0 && !has.verdicts)
      return {
        stage: 'audit',
        button: `Adjudicate ${has.flags} flag${has.flags === 1 ? '' : 's'}`,
        hint: 'An adjudicator that wrote none of the cards rules on each flag: approve, fix, or cut.',
        go: adjudicate,
        secondary: { label: 'Re-run audit', go: () => (force.add('audit'), run('audit')) },
      };
    if (has.flags > 0)
      return {
        stage: 'audit',
        button: 'Apply verdicts',
        hint: 'The writer applies every verdict as written -- no re-judging -- and the deck is re-checked.',
        go: applyVerdicts,
        secondary: { label: 'Re-adjudicate', go: adjudicate },
      };
    const toAnki = { label: 'Send to Anki', go: send };
    if (sentToAnki !== null)
      return {
        stage: 'deliver',
        button: 'Send again',
        hint: `Done. ${sentToAnki} — open Anki and study.`,
        go: send,
        secondary: { label: 'Export .apkg', go: () => run('deliver') },
      };
    if (exportedTo !== null)
      return {
        stage: 'deliver',
        button: 'Export again',
        hint: `Done. ${exportedTo} is beside your material — double-click it to import into Anki, or send it straight in.`,
        go: () => run('deliver'),
        secondary: toAnki,
      };
    return { stage: 'deliver', button: 'Send to Anki', hint: `${ABOUT.deliver} Anki must be open with the AnkiConnect add-on; Export writes an .apkg to import by hand instead.`, go: send, secondary: { label: 'Export .apkg', go: () => run('deliver') } };
  }

  function renderBar(): void {
    if (!host.courseDir()) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    if (busy) {
      bar.innerHTML = `<div class="nb-text"><span class="nb-k">${through ? 'Running through to audit' : 'Running'}</span><strong>${esc(busy)}…</strong><span class="nb-hint">${
        through ? 'Each stage starts the next; it stops at the audit for you. Stop cancels the turn and ends the run.' : 'Watch the agent below. Stop cancels its turn.'
      }</span></div>
        <div class="nb-actions"><button type="button" data-stop="1" class="quiet">Stop</button></div>`;
      return;
    }
    const a = action();
    const n = STAGES.indexOf(a.stage) + 1;
    const needsAgent = !runner && (WRITING_STAGES.some((w) => w.id === a.stage) || a.stage === 'audit');
    rail.querySelectorAll<HTMLLIElement>('li').forEach((li) => li.classList.toggle('next', li.dataset.stage === a.stage));
    // Run to audit: offered wherever a stage is still ahead of the audit and an agent can run it.
    const canThrough = !!runner && !needsAgent && nextAuto() !== null && !(a.stage === 'extract' && !has.inventory && !host.hasMaterials());
    bar.innerHTML = `<div class="nb-text"><span class="nb-k">${exportedTo !== null && a.stage === 'deliver' ? 'Done' : 'Next'}</span><strong>${n} · ${esc(a.stage)}</strong><span class="nb-hint">${esc(a.hint)}</span></div>
      <div class="nb-actions">${
        canThrough ? `<button type="button" data-through="1" class="quiet" title="Extract, organize, cards and audit in a row, with no stops; come back to the findings.">Run to audit</button>` : ''
      }${a.secondary ? `<button type="button" data-secondary="1" class="quiet">${esc(a.secondary.label)}</button>` : ''}${
        needsAgent ? `<button type="button" data-settings="1">Set up an agent in Settings</button>` : `<button type="button" data-go="1">${esc(a.button)}</button>`
      }</div>`;
  }

  bar.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    if (b.dataset.stop) {
      if (writerSession) void sidecar.cancel(writerSession);
      return;
    }
    if (b.dataset.settings) return host.openSettings();
    if (b.dataset.through) return void runThrough();
    const a = action();
    if (b.dataset.go) void a.go();
    else if (b.dataset.secondary && a.secondary) void a.secondary.go();
  });

  async function refresh(): Promise<void> {
    const dir = host.courseDir();
    if (!dir) {
      renderBar();
      return;
    }
    try {
      const { artifacts } = await sidecar.listCourse(dir);
      const audit = artifacts.deck ? await sidecar.readCourse(dir, 'audit.md').then(() => true, () => false) : false;
      const verdicts = artifacts.deck ? await sidecar.readCourse(dir, 'verdicts.md').then(() => true, () => false) : false;
      const flags = artifacts.deck ? await sidecar.readFlags(`${dir}/deck.json`).then((r) => r.flags.length, () => 0) : 0;
      has = { inventory: artifacts.inventory, plan: artifacts.plan, deck: artifacts.deck, audit, verdicts, flags };
    } catch {
      has = { inventory: false, plan: false, deck: false, audit: false, verdicts: false, flags: 0 };
    }
    rail.querySelectorAll<HTMLLIElement>('li').forEach((li) => li.classList.toggle('done', done(li.dataset.stage as StageId)));
    renderBar();
  }

  function showGate(html: string, artifact: string | null = null): void {
    gate.innerHTML = html;
    gate.hidden = false;
    showing = artifact;
    host.showAgentView();
    renderBar();
  }
  function hideGate(): void {
    gate.hidden = true;
    showing = null;
    renderBar();
  }

  /**
   * The artifact a stage wrote, with the way on. After a writing stage the
   * gate is the review: the button marks the review step done and runs the
   * stage after it, rather than showing the same file twice.
   */
  function showArtifactGate(stage: StageId, artifact: string, text: string | null): void {
    let after = next(stage);
    const reviewStep = after === 'inventory review' || after === 'plan review' ? after : null;
    if (reviewStep) after = next(reviewStep);
    const label = after === 'deck preview' ? 'Open the deck →' : after ? `Looks right → ${after}` : '';
    showGate(`<header class="bar"><span>${esc(artifact)}</span><span class="grow"></span>
      ${after ? `<button type="button" data-go="${after}" ${reviewStep ? `data-reviewed="${reviewStep}"` : ''}>${esc(label)}</button>` : ''}<button type="button" data-reread="${esc(artifact)}" class="quiet">Re-read</button><button type="button" data-close="1" class="quiet">Close</button></header>
      <pre class="artifact">${text === null ? `(no ${esc(artifact)} was written — ask the agent below)` : esc(text)}</pre>`, artifact);
  }

  async function run(stage: StageId): Promise<void> {
    const dir = host.courseDir();
    if (!dir) return host.say('choose a course folder first', true);
    // Not an error: the previous click is still working. Saying which, and
    // where to watch it, is the whole of what the person needed to know.
    if (busy) return host.say(`${busy} is still running — watch the agent below, or press Stop in the bar`);
    if (stage === 'extract' && !host.hasMaterials()) {
      host.say('add the lecture files first', true);
      return host.addFiles();
    }
    const writing = WRITING_STAGES.find((w) => w.id === stage);
    if ((writing || stage === 'audit') && !runner) {
      host.say('no agent is connected — set one up in Settings', true);
      return host.openSettings();
    }
    setStage(stage);
    try {
      if (writing) {
        host.showAgentView();
        hideGate();
        setBusy(stage);
        if (stage === 'extract') await host.prepareMaterials(dir);
        host.say(`running ${stage}…`);
        const r = await runner!.run(writing);
        host.say(r.stopReason === 'end_turn' ? `${stage} finished` : `${stage} stopped: ${r.stopReason}`, r.stopReason !== 'end_turn');
        showArtifactGate(stage, writing.artifact, r.artifactText);
      } else if (stage === 'inventory review' || stage === 'plan review') {
        const artifact = stage === 'inventory review' ? 'inventory.md' : 'plan.md';
        const text = await sidecar.readCourse(dir, artifact).then((r) => r.text, () => null);
        showArtifactGate(stage, artifact, text);
      } else if (stage === 'deck preview') {
        previewed = true;
        await host.openDeck(dir);
      } else if (stage === 'audit') {
        // Resumable: if audit.md is already beside the deck -- from an earlier
        // run, or a run lost to a restart -- show it and offer the adjudicator
        // rather than paying for the audit again. "Re-run" is there for when
        // the deck has changed since.
        const existing = await sidecar.readCourse(dir, 'audit.md').then((r) => r.text, () => null);
        if (existing !== null && !force.has('audit')) {
          const { flags } = await sidecar.readFlags(`${dir}/deck.json`);
          showGate(`<header class="bar"><span>audit.md (already written) · ${flags.length} flag(s) to adjudicate</span><span class="grow"></span>
            ${flags.length ? '<button type="button" data-adjudicate="1">Adjudicate</button>' : ''}<button type="button" data-rerun="audit" class="quiet">Re-run audit</button><button type="button" data-close="1" class="quiet">Close</button></header>
            <pre class="artifact">${esc(existing)}</pre>`);
          host.say('audit.md is already there — adjudicate, or re-run the audit');
          return;
        }
        force.delete('audit');
        // The method's run-sheet: an auditor who wrote none of the cards reads
        // the whole deck first; its findings and the owner's flags then go to
        // a separate adjudicator. The owner sees the report before that step.
        host.showAgentView();
        hideGate();
        setBusy(stage);
        host.say('auditing the whole deck in a fresh session…');
        const deckPath = `${dir}/deck.json`;
        // The auditor is told review.html is beside deck.json -- the run-sheet's
        // step 2, every front rendered as the student will see it. The app keeps
        // its own preview in memory, so the file is written here, just before.
        await sidecar.review(deckPath, { outPath: `${dir}/review.html` }).catch(() => undefined);
        const a = await runner!.audit();
        const { flags } = await sidecar.readFlags(deckPath);
        const merged: Flag[] = [
          ...flags,
          ...a.findings.filter((f: AuditFinding) => f.card > 0).map((f: AuditFinding) => ({ noteIndex: f.card - 1, note: `[${f.angle}] ${f.finding}`, at: new Date().toISOString() })),
        ];
        await sidecar.writeFlags(deckPath, merged);
        showGate(`<header class="bar"><span>audit.md · ${a.findings.length} finding(s), ${flags.length} owner flag(s)</span><span class="grow"></span>
          ${merged.length ? `<button type="button" data-adjudicate="1">Adjudicate ${merged.length}</button>` : ''}<button type="button" data-close="1" class="quiet">Close</button></header>
          <pre class="artifact">${a.report === null ? '(no audit.md was written)' : esc(a.report)}</pre>`);
        host.say(a.stopReason === 'end_turn' ? `audit filed ${a.findings.length} finding(s)` : `auditor stopped: ${a.stopReason}`, a.stopReason !== 'end_turn');
      } else if (stage === 'deliver') {
        setBusy(stage);
        const out = await host.exportDeck();
        if (out !== null) exportedTo = out;
        else if (exportedTo === null) exportedTo = 'the .apkg';
      }
    } catch (err) {
      host.say(err instanceof EngineError ? err.message : String(err), true);
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  /** Send to Anki: no agent runs, so it is not a busy stage; it either lands or says why not. */
  async function send(): Promise<void> {
    if (busy) return host.say(`${busy} is still running — watch the agent below`);
    host.say('sending to Anki…');
    const r = await host.sendToAnki();
    if (r === null) return renderBar();
    sentToAnki = `${r.added} of ${r.total} card${r.total === 1 ? '' : 's'} in ${r.decks.join(', ')}`;
    renderBar();
  }

  /** The next stage a run-through would start, or null when it is the person's turn: the audit is written, or there is nothing to extract from. */
  function nextAuto(): StageId | null {
    if (!has.inventory) return host.hasMaterials() ? 'extract' : null;
    if (!has.plan) return 'organize';
    if (!has.deck) return 'cards';
    if (!has.audit) return 'audit';
    return null;
  }

  /**
   * Run through to the audit: the writing stages and the audit in a row,
   * with no stop at the read-and-confirm gates -- for the person who has
   * been through the steps enough times and wants to come back to findings.
   * It ends where judgment starts, with the audit on screen and adjudication
   * waiting, or at the first stage that wrote nothing.
   */
  async function runThrough(): Promise<void> {
    if (busy) return host.say(`${busy} is still running — watch the agent below`);
    if (!runner) {
      host.say('no agent is connected — set one up in Settings', true);
      return host.openSettings();
    }
    through = true;
    renderBar();
    try {
      for (;;) {
        await refresh();
        const stage = nextAuto();
        if (stage === null) break;
        if (stage === 'organize') reviewed.add('inventory review');
        if (stage === 'cards') reviewed.add('plan review');
        await run(stage);
        await refresh();
        if (!done(stage) && !(stage === 'audit' && has.audit)) {
          host.say(`run-through stopped: ${stage} wrote nothing`, true);
          return;
        }
      }
      host.say(has.audit ? 'run-through done — the audit is ready to read' : 'run-through done');
    } finally {
      through = false;
      renderBar();
    }
  }

  async function adjudicate(): Promise<void> {
    const dir = host.courseDir();
    if (!dir || !runner) return;
    const { flags } = await sidecar.readFlags(`${dir}/deck.json`);
    if (flags.length === 0) return host.say('nothing is flagged', true);
    if (busy) return host.say(`${busy} is still running — watch the agent below`);
    host.showAgentView();
    hideGate();
    setBusy('adjudicate');
    host.say(`adjudicating ${flags.length} flag(s) in a fresh session…`);
    try {
      const r = await runner.adjudicate(flags);
      showGate(`<header class="bar"><span>verdicts.md</span><span class="grow"></span>
        ${r.verdicts !== null ? '<button type="button" data-apply="1">Apply verdicts</button>' : ''}<button type="button" data-close="1" class="quiet">Close</button></header>
        <pre class="artifact">${r.verdicts === null ? '(no verdicts.md was written)' : esc(r.verdicts)}</pre>`);
      host.say(r.stopReason === 'end_turn' ? 'verdicts in — review them, then apply' : `adjudicator stopped: ${r.stopReason}`, r.stopReason !== 'end_turn');
    } catch (err) {
      host.say(err instanceof EngineError ? err.message : String(err), true);
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  async function applyVerdicts(): Promise<void> {
    const dir = host.courseDir();
    if (!dir || !runner) return;
    if (busy) return host.say(`${busy} is still running — watch the agent below`);
    host.showAgentView();
    hideGate();
    setBusy('applying verdicts');
    host.say('writer applying verdicts…');
    try {
      const r = await runner.applyVerdicts();
      host.say(r.stopReason === 'end_turn' ? 'verdicts applied — re-checking the deck' : `writer stopped: ${r.stopReason}`, r.stopReason !== 'end_turn');
      // The flags were the adjudicator's input; once its verdicts are applied
      // they are resolved, and their note indexes no longer line up with a
      // deck that may have lost cards. Clear them before the reload, so the
      // deck view does not show sixteen stale flags on a clean deck.
      if (r.stopReason === 'end_turn') await sidecar.writeFlags(`${dir}/deck.json`, []).catch(() => undefined);
      previewed = true;
      await host.openDeck(dir);
    } catch (err) {
      host.say(err instanceof EngineError ? err.message : String(err), true);
    } finally {
      setBusy(null);
      await refresh();
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
    if (b.dataset.close) hideGate();
    else if (b.dataset.go) {
      if (b.dataset.reviewed) reviewed.add(b.dataset.reviewed as StageId);
      void run(b.dataset.go as StageId);
    } else if (b.dataset.reread) {
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
      writerSession = conn?.session?.sessionId ?? null;
      renderBar();
    },
    run,
    refresh,
  };
}
