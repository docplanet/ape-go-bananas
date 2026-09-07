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

const STAGES = ['extract', 'inventory review', 'organize', 'plan review', 'cards', 'deck preview', 'audit', 'deliver'] as const;

const app = document.getElementById('app')!;
app.innerHTML = `
  <aside class="rail">
    <h1>A.P.E.</h1>
    <div class="course"><div class="muted">Course folder</div><div id="coursedir" class="path">none</div><button id="pickdir">Choose…</button></div>
    <ol class="stages">${STAGES.map((s) => `<li data-stage="${s}">${s}</li>`).join('')}</ol>
    <nav class="views"><button data-view="agent">Agent</button><button data-view="deck">Deck</button></nav>
    <div class="status" id="status">starting engine…</div>
  </aside>
  <main class="main">
    <section id="view-agent" class="view"></section>
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
  // A deck.json already there means the preview is one click away.
  void sidecar.load(`${dir}/deck.json`).then(() => say('deck.json found — see Deck'), () => undefined);
}
$('pickdir').onclick = async () => {
  const picked = await open({ directory: true, multiple: false });
  if (typeof picked === 'string') setCourseDir(picked);
};

// ---- agent view --------------------------------------------------------------

function showPicker() {
  if (!dataDir) return;
  chat = null;
  mountPicker($('view-agent'), dataDir, () => courseDir, {
    say,
    onConnected(result: ConnectResult) {
      if (!result.session) {
        say('connected but no session', true);
        return;
      }
      setStage('extract');
      chat = mountChat($('view-agent'), result, say);
      say(`${result.agent?.name ?? result.provider} ready`);
    },
  });
}

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
