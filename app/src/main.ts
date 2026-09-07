// PLACEHOLDER SHELL. The layout (stage rail / provider picker / chat pane /
// deck preview) is APP.md's one-window shape drawn in the plainest way so
// the plumbing can be exercised end to end. The real screens come from
// Claude Design and drop in over this file; sidecar.ts, providers.ts,
// preview.ts and chat.ts are the seams they call into.
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { sidecar, SidecarError, type ConnectResult, type Flag } from './sidecar';
import { mountPreview } from './preview';
import { mountPicker } from './providers';
import { mountChat } from './chat';
import { WRITING_STAGES, makeRunner, type Runner, type StageId } from './pipeline';

const STAGES = ['extract', 'inventory review', 'organize', 'plan review', 'cards', 'deck preview', 'audit', 'deliver'] as const;

const app = document.getElementById('app')!;
app.innerHTML = `
  <aside class="rail">
    <h1>A.P.E.</h1>
    <div class="course"><div class="muted">Course folder</div><div id="coursedir" class="path">none</div><button id="pickdir">Choose…</button>
      <div class="muted" style="margin-top:8px">Deck name</div><input id="deckname-in" placeholder="Course::Lecture 3" autocomplete="off"></div>
    <ol class="stages">${STAGES.map((s) => `<li data-stage="${s}">${s}</li>`).join('')}</ol>
    <nav class="views"><button data-view="agent">Agent</button><button data-view="deck">Deck</button></nav>
    <div class="status" id="status">starting engine…</div>
  </aside>
  <main class="main">
    <section id="view-agent" class="view">
      <section id="gate" class="gate hidden"></section>
      <section id="agent-host" class="view"></section>
    </section>
    <section id="view-deck" class="view hidden">
      <section class="drop" id="drop">
        <p>Drop a <code>deck.json</code> (or the folder holding one) here</p>
        <button id="open">Open…</button>
      </section>
      <section class="work hidden" id="work">
        <header class="bar"><span id="deckname"></span><span class="grow"></span><button id="export">Export .apkg</button></header>
        <div class="split">
          <div class="preview" id="preview"></div>
          <div class="side">
            <h2>Checks</h2><pre id="report"></pre>
            <h2>Flags <small id="flagcount"></small></h2><ul id="flags"></ul>
          </div>
        </div>
      </section>
    </section>
  </main>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status');
let courseDir: string | null = null;
let dataDir: string | null = null;
let chat: ReturnType<typeof mountChat> | null = null;
let runner: Runner | null = null;
let running = false;

function setStage(name: (typeof STAGES)[number]) {
  document.querySelectorAll<HTMLLIElement>('.stages li').forEach((li) => li.classList.toggle('on', li.dataset.stage === name));
}
function say(text: string, isError = false) {
  status.textContent = text;
  status.classList.toggle('error', isError);
}
function showView(name: 'agent' | 'deck') {
  $('view-agent').classList.toggle('hidden', name !== 'agent');
  $('view-deck').classList.toggle('hidden', name !== 'deck');
}
document.querySelector('.views')!.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-view]');
  if (b) showView(b.dataset.view as 'agent' | 'deck');
});

function setCourseDir(dir: string) {
  courseDir = dir;
  $('coursedir').textContent = dir;
  void refreshStageMarks();
}
$('pickdir').onclick = async () => {
  const picked = await open({ directory: true, multiple: false });
  if (typeof picked === 'string') setCourseDir(picked);
};

// ---- agent view --------------------------------------------------------------

function showPicker() {
  if (!dataDir) return;
  chat = null;
  runner = null;
  mountPicker($('agent-host'), dataDir, () => courseDir, {
    say,
    onConnected(result: ConnectResult) {
      if (!result.session || !courseDir) {
        say('connected but no session', true);
        return;
      }
      chat = mountChat($('agent-host'), result, say);
      runner = makeRunner(result, courseDir, () => $<HTMLInputElement>('deckname-in').value.trim());
      say(`${result.agent?.name ?? result.provider} ready — pick a stage on the left`);
      void refreshStageMarks();
    },
  });
}

// ---- stages ------------------------------------------------------------------

const ORDER: StageId[] = [...STAGES];
function next(stage: StageId): StageId | null {
  const i = ORDER.indexOf(stage);
  return i >= 0 && i + 1 < ORDER.length ? ORDER[i + 1]! : null;
}

async function refreshStageMarks() {
  if (!courseDir) return;
  try {
    const { artifacts } = await sidecar.listCourse(courseDir);
    const done: Record<string, boolean> = { extract: artifacts.inventory, organize: artifacts.plan, cards: artifacts.deck, 'deck preview': artifacts.deck };
    document.querySelectorAll<HTMLLIElement>('.stages li').forEach((li) => li.classList.toggle('done', !!done[li.dataset.stage!]));
  } catch {
    /* no folder yet */
  }
}

function gate(html: string) {
  const g = $('gate');
  g.innerHTML = html;
  g.classList.remove('hidden');
}
function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

async function showArtifactGate(stage: StageId, artifact: string, text: string | null) {
  const after = next(stage);
  gate(`<header class="bar"><span>${esc(artifact)}</span><span class="grow"></span>
      ${after ? `<button data-go="${after}">Looks right → ${esc(after)}</button>` : ''}<button data-reread="${esc(artifact)}" class="quiet">Re-read</button><button data-close="1" class="quiet">Close</button></header>
      <pre class="artifact">${text === null ? `(no ${esc(artifact)} was written — ask the agent in the chat below)` : esc(text)}</pre>`);
}

async function runStage(stage: StageId) {
  if (!courseDir) return say('choose a course folder first', true);
  if (!runner) {
    if (stage === 'deck preview') return void openDeck(`${courseDir}/deck.json`);
    if (stage === 'deliver') return void exportDeck(`${courseDir}/deck.json`);
    return say('connect an agent first', true);
  }
  if (running) return say('a stage is already running', true);
  setStage(stage);
  showView('agent');
  const writing = WRITING_STAGES.find((w) => w.id === stage);
  try {
    if (writing) {
      running = true;
      say(`running ${stage}…`);
      const r = await runner.run(writing);
      say(r.stopReason === 'end_turn' ? `${stage} finished` : `${stage} stopped: ${r.stopReason}`, r.stopReason !== 'end_turn');
      await showArtifactGate(stage, writing.artifact, r.artifactText);
    } else if (stage === 'inventory review' || stage === 'plan review') {
      const artifact = stage === 'inventory review' ? 'inventory.md' : 'plan.md';
      const text = await sidecar.readCourse(courseDir, artifact).then((r) => r.text, () => null);
      await showArtifactGate(stage, artifact, text);
    } else if (stage === 'deck preview') {
      await openDeck(`${courseDir}/deck.json`);
    } else if (stage === 'audit') {
      const { flags } = await sidecar.readFlags(`${courseDir}/deck.json`);
      if (flags.length === 0) return say('no flags to adjudicate — flag cards in the deck preview first', true);
      running = true;
      say(`adjudicating ${flags.length} flag(s) in a fresh session…`);
      const r = await runner.adjudicate(flags);
      gate(`<header class="bar"><span>verdicts.md</span><span class="grow"></span><button data-apply="1">Apply verdicts verbatim</button><button data-close="1" class="quiet">Close</button></header>
        <pre class="artifact">${r.verdicts === null ? '(no verdicts.md was written)' : esc(r.verdicts)}</pre>`);
      say(r.stopReason === 'end_turn' ? 'verdicts ready' : `adjudicator stopped: ${r.stopReason}`, r.stopReason !== 'end_turn');
    } else if (stage === 'deliver') {
      await exportDeck(`${courseDir}/deck.json`);
    }
  } catch (err) {
    say(err instanceof SidecarError ? err.message : String(err), true);
  } finally {
    running = false;
    void refreshStageMarks();
  }
}

document.querySelector('.stages')!.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-stage]');
  if (li) void runStage(li.dataset.stage as StageId);
});

$('gate').addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!b || !courseDir) return;
  if (b.dataset.close) $('gate').classList.add('hidden');
  else if (b.dataset.go) void runStage(b.dataset.go as StageId);
  else if (b.dataset.reread) {
    const text = await sidecar.readCourse(courseDir, b.dataset.reread).then((r) => r.text, () => null);
    const pre = $('gate').querySelector('pre');
    if (pre) pre.textContent = text ?? `(no ${b.dataset.reread})`;
  } else if (b.dataset.apply && runner) {
    running = true;
    say('writer applying verdicts…');
    try {
      const r = await runner.applyVerdicts();
      say(r.stopReason === 'end_turn' ? 'verdicts applied — re-checking the deck' : `writer stopped: ${r.stopReason}`, r.stopReason !== 'end_turn');
      $('gate').classList.add('hidden');
      await openDeck(`${courseDir}/deck.json`);
    } catch (err) {
      say(err instanceof SidecarError ? err.message : String(err), true);
    } finally {
      running = false;
    }
  }
});

// ---- deck view (unchanged from the first slice) ------------------------------

let deckPath: string | null = null;
let flags: Flag[] = [];
let preview: ReturnType<typeof mountPreview> | null = null;

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
function renderFlags() {
  $('flagcount').textContent = flags.length ? `(${flags.length})` : '';
  $('flags').innerHTML = flags
    .map((f, i) => `<li>#${f.noteIndex + 1} ${f.note ? `— ${escapeHtml(f.note)}` : ''} <button data-unflag="${i}">×</button></li>`)
    .join('');
  preview?.markFlagged(flags.map((f) => f.noteIndex));
}
async function persistFlags() {
  if (deckPath) await sidecar.writeFlags(deckPath, flags);
}
async function openDeck(path: string) {
  const candidate = path.endsWith('.json') ? path : `${path.replace(/\/$/, '')}/deck.json`;
  showView('deck');
  setStage('deck preview');
  say(`loading ${candidate}`);
  try {
    const [loaded, check, review, stored] = await Promise.all([sidecar.load(candidate), sidecar.check(candidate), sidecar.review(candidate), sidecar.readFlags(candidate)]);
    deckPath = candidate;
    flags = stored.flags;
    $('deckname').textContent = `${loaded.notes[0]?.deckName ?? '(no deck name)'} · ${loaded.count} notes`;
    $('report').textContent = (check.mediaNote ? `${check.mediaNote}\n` : '') + check.report;
    $('report').classList.toggle('clean', check.clean);
    $('drop').classList.add('hidden');
    $('work').classList.remove('hidden');
    preview = mountPreview($('preview'), review.html, (noteIndex) => {
      const note = window.prompt(`Flag card #${noteIndex + 1}. What is wrong?`) ?? '';
      flags.push({ noteIndex, note, at: new Date().toISOString() });
      renderFlags();
      void persistFlags();
    });
    renderFlags();
    say(check.clean ? 'checks clean' : `${check.result.findings.length} finding(s)`, !check.clean);
  } catch (err) {
    say(err instanceof SidecarError ? `${err.message} (code ${err.code})` : String(err), true);
  }
}
$('open').onclick = async () => {
  const picked = await open({ multiple: false, filters: [{ name: 'deck.json', extensions: ['json'] }] });
  if (typeof picked === 'string') await openDeck(picked);
};
$('flags').onclick = (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-unflag]');
  if (!btn) return;
  flags.splice(Number(btn.dataset.unflag), 1);
  renderFlags();
  void persistFlags();
};
async function exportDeck(path: string) {
  setStage('deliver');
  try {
    const out = await sidecar.export(path);
    say(`wrote ${out.outPath}` + (out.unresolvedMedia.length ? ` (missing media: ${out.unresolvedMedia.join(', ')})` : ''), out.unresolvedMedia.length > 0);
  } catch (err) {
    say(err instanceof SidecarError ? err.message : String(err), true);
  }
}
$('export').onclick = () => {
  if (deckPath) void exportDeck(deckPath);
};
void getCurrentWebview().onDragDropEvent((event) => {
  const drop = $('drop');
  if (event.payload.type === 'over') drop.classList.add('hover');
  else drop.classList.remove('hover');
  if (event.payload.type === 'drop' && event.payload.paths[0]) {
    const p = event.payload.paths[0];
    if (p.endsWith('.json')) void openDeck(p);
    else setCourseDir(p);
  }
});

// ---- start -------------------------------------------------------------------

(async () => {
  try {
    const s = await sidecar.status();
    if (!s.running) {
      say(s.error ?? 'engine not running', true);
      return;
    }
    const info = await sidecar.ping();
    dataDir = s.data_dir;
    say(`engine ${info.version} on node ${info.node}`);
    if (s.initial_deck) {
      setCourseDir(s.initial_deck.replace(/\/[^/]+$/, ''));
      await openDeck(s.initial_deck);
    }
    showPicker();
  } catch (err) {
    say(String(err), true);
  }
})();

export { chat };
