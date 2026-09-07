// PLACEHOLDER SHELL. The layout below (stage rail / chat pane / preview
// pane / drop target) is APP.md's one-window shape drawn in the plainest
// possible way so the plumbing can be exercised end to end. The real screens
// are to be produced in Claude Design and dropped in over this file; keep
// sidecar.ts and preview.ts as the seams they call into.
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { sidecar, SidecarError, type Flag } from './sidecar';
import { mountPreview } from './preview';

const STAGES = ['extract', 'inventory review', 'organize', 'plan review', 'cards', 'deck preview', 'audit', 'deliver'] as const;

const app = document.getElementById('app')!;
app.innerHTML = `
  <aside class="rail">
    <h1>A.P.E.</h1>
    <ol class="stages">${STAGES.map((s) => `<li data-stage="${s}">${s}</li>`).join('')}</ol>
    <div class="status" id="status">starting engine…</div>
  </aside>
  <main class="main">
    <section class="drop" id="drop">
      <p>Drop a <code>deck.json</code> (or the folder holding one) here</p>
      <button id="open">Open…</button>
      <p class="hint">Extract → organize → cards need the agent bridge (next slice). Deck preview, checks, flags and export work now.</p>
    </section>
    <section class="work hidden" id="work">
      <header class="bar">
        <span id="deckname"></span>
        <span class="grow"></span>
        <button id="export">Export .apkg</button>
      </header>
      <div class="split">
        <div class="preview" id="preview"></div>
        <div class="side">
          <h2>Checks</h2>
          <pre id="report"></pre>
          <h2>Flags <small id="flagcount"></small></h2>
          <ul id="flags"></ul>
          <h2>Chat</h2>
          <div class="chat"><p class="muted">Agent chat lands with the ACP bridge. The flag list above is what it will receive.</p></div>
        </div>
      </div>
    </section>
  </main>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status');

function setStage(name: (typeof STAGES)[number]) {
  document.querySelectorAll<HTMLLIElement>('.stages li').forEach((li) => li.classList.toggle('on', li.dataset.stage === name));
}

function say(text: string, isError = false) {
  status.textContent = text;
  status.classList.toggle('error', isError);
}

let deckPath: string | null = null;
let flags: Flag[] = [];
let preview: ReturnType<typeof mountPreview> | null = null;

function renderFlags() {
  $('flagcount').textContent = flags.length ? `(${flags.length})` : '';
  $('flags').innerHTML = flags
    .map((f, i) => `<li>#${f.noteIndex + 1} ${f.note ? `— ${escapeHtml(f.note)}` : ''} <button data-unflag="${i}">×</button></li>`)
    .join('');
  preview?.markFlagged(flags.map((f) => f.noteIndex));
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

async function persistFlags() {
  if (!deckPath) return;
  await sidecar.writeFlags(deckPath, flags);
}

async function openDeck(path: string) {
  // A dropped folder means "the deck.json inside it" -- the artifact layout
  // APP.md fixes (deck.json beside inventory.md and plan.md).
  const candidate = path.endsWith('.json') ? path : `${path.replace(/\/$/, '')}/deck.json`;
  setStage('deck preview');
  say(`loading ${candidate}`);
  try {
    const [loaded, check, review, stored] = await Promise.all([
      sidecar.load(candidate),
      sidecar.check(candidate),
      sidecar.review(candidate),
      sidecar.readFlags(candidate),
    ]);
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

$('export').onclick = async () => {
  if (!deckPath) return;
  setStage('deliver');
  try {
    const out = await sidecar.export(deckPath);
    say(`wrote ${out.outPath}` + (out.unresolvedMedia.length ? ` (missing media: ${out.unresolvedMedia.join(', ')})` : ''), out.unresolvedMedia.length > 0);
  } catch (err) {
    say(err instanceof SidecarError ? err.message : String(err), true);
  }
};

void getCurrentWebview().onDragDropEvent((event) => {
  const drop = $('drop');
  if (event.payload.type === 'over') drop.classList.add('hover');
  else drop.classList.remove('hover');
  if (event.payload.type === 'drop' && event.payload.paths[0]) void openDeck(event.payload.paths[0]);
});

(async () => {
  try {
    const s = await sidecar.status();
    if (!s.running) {
      say(s.error ?? 'engine not running', true);
      return;
    }
    const info = await sidecar.ping();
    say(`engine ${info.version} on node ${info.node}`);
    if (s.initial_deck) await openDeck(s.initial_deck);
  } catch (err) {
    say(String(err), true);
  }
})();
