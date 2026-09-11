// The desktop app's window: the agent shell (agent/app.ts, shared with the
// tool page over the bridge) over a TauriHost, plus this shell's own deck
// view -- checks, the card preview and the .apkg export through the
// sidecar's deck/* methods, on the Node engine Rust spawned. Nothing here
// says what a card is; the engine renders the review and the method text
// decides the rest.
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { mountAgentApp, type DeckView } from './agent/app.js';
import { EngineError, makeSidecarClient, type Flag, type SidecarClient } from './engine/client.js';
import { TauriHost, secrets, sidecarStatus } from './engine/tauri-host.js';
import { mountPreview } from './preview.js';
import { offerUpdate } from './updater.js';

const root = document.getElementById('app')!;
root.innerHTML = `
  <aside class="rail" id="rail"></aside>
  <main class="main" id="main">
    <section id="view-agent" class="view" hidden></section>
    <section id="view-deck" class="view" hidden>
      <section class="drop" id="drop">
        <p>Drop a <code>deck.json</code> (or the folder holding one) here</p>
        <button type="button" id="open">Open…</button>
      </section>
      <section class="work" id="work" hidden>
        <header class="bar"><span id="deckname"></span><span class="grow"></span><button type="button" id="export">Export .apkg</button></header>
        <div class="split">
          <div class="preview" id="preview"></div>
          <div class="side">
            <h2>Checks</h2><pre id="report"></pre>
            <h2>Flags <small id="flagcount"></small></h2><ul id="flags" class="flags"></ul>
          </div>
        </div>
      </section>
    </section>
  </main>`;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// ---- the deck view, over the sidecar ----------------------------------------

function makeDeckView(sidecar: SidecarClient, say: (text: string, isError?: boolean) => void): DeckView & { openPath(path: string): Promise<void> } {
  let deckPath: string | null = null;
  let flags: Flag[] = [];
  let preview: ReturnType<typeof mountPreview> | null = null;

  function renderFlags(): void {
    $('flagcount').textContent = flags.length ? `(${flags.length})` : '';
    $('flags').innerHTML = flags.map((f, i) => `<li>#${f.noteIndex + 1} ${f.note ? `— ${esc(f.note)}` : ''} <button type="button" data-unflag="${i}">×</button></li>`).join('');
    preview?.markFlagged(flags.map((f) => f.noteIndex));
  }
  async function persistFlags(): Promise<void> {
    if (deckPath) await sidecar.writeFlags(deckPath, flags);
  }
  $('flags').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-unflag]');
    if (!btn) return;
    flags.splice(Number(btn.dataset.unflag), 1);
    renderFlags();
    void persistFlags();
  });

  async function openPath(path: string): Promise<void> {
    say(`loading ${path}`);
    try {
      const [loaded, check, review, stored] = await Promise.all([sidecar.load(path), sidecar.check(path), sidecar.review(path), sidecar.readFlags(path)]);
      deckPath = path;
      flags = stored.flags;
      $('deckname').textContent = `${loaded.notes[0]?.deckName ?? '(no deck name)'} · ${loaded.count} notes`;
      $('report').textContent = (check.mediaNote ? `${check.mediaNote}\n` : '') + check.report;
      $('report').classList.toggle('clean', check.clean);
      $('drop').hidden = true;
      $('work').hidden = false;
      preview = mountPreview($('preview'), review.html, (noteIndex) => {
        // A stand-in for a designed flag sheet (docs/APP.md).
        const note = window.prompt(`Flag card #${noteIndex + 1}. What is wrong?`) ?? '';
        flags.push({ noteIndex, note, at: new Date().toISOString() });
        renderFlags();
        void persistFlags();
      });
      renderFlags();
      say(check.clean ? 'checks clean' : `${check.result.findings.length} finding(s)`, !check.clean);
    } catch (err) {
      say(err instanceof EngineError ? `${err.message} (code ${err.code})` : String(err), true);
    }
  }

  async function exportPath(path: string): Promise<void> {
    try {
      const out = await sidecar.export(path);
      say(`wrote ${out.outPath}` + (out.unresolvedMedia.length ? ` (missing media: ${out.unresolvedMedia.join(', ')})` : ''), out.unresolvedMedia.length > 0);
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
    }
  }

  $('open').addEventListener('click', () => {
    void open({ multiple: false, filters: [{ name: 'deck.json', extensions: ['json'] }] }).then((picked) => {
      if (typeof picked === 'string') void openPath(picked);
    });
  });
  $('export').addEventListener('click', () => {
    if (deckPath) void exportPath(deckPath);
  });

  return {
    show(visible) {
      $('view-deck').hidden = !visible;
    },
    open: (dir) => openPath(`${dir.replace(/[\\/]$/, '')}/deck.json`),
    export: (dir) => exportPath(`${dir.replace(/[\\/]$/, '')}/deck.json`),
    openPath,
  };
}

// ---- start -------------------------------------------------------------------

function fail(message: string): void {
  root.innerHTML = `<div class="dead"><h1>A.P.E.</h1><p class="error">${esc(message)}</p></div>`;
}

void (async () => {
  let host: TauriHost;
  try {
    host = await TauriHost.start(await sidecarStatus());
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }
  const sidecar = makeSidecarClient(host);
  const status = { say: (text: string, isError = false): void => app.say(text, isError) };
  const deck = makeDeckView(sidecar, (t, e) => status.say(t, e));
  const app = mountAgentApp(host, {
    rail: $('rail'),
    view: $('view-agent'),
    deck,
    keys: secrets,
    pickFolder: async () => {
      const picked = await open({ directory: true, multiple: false });
      return typeof picked === 'string' ? picked : null;
    },
  });

  // Opened with a deck.json (a file argument): its folder is the course.
  const initial = host.courseRoot();
  if (initial) {
    app.setCourseDir(initial);
    await app.openDeck(initial);
  }

  // A drop anywhere in the window: a deck.json opens, a folder becomes the course.
  void getCurrentWebview().onDragDropEvent((event) => {
    const drop = $('drop');
    drop.classList.toggle('hover', event.payload.type === 'over');
    if (event.payload.type !== 'drop' || !event.payload.paths[0]) return;
    const p = event.payload.paths[0];
    if (p.endsWith('.json')) {
      app.setCourseDir(p.replace(/[\\/][^\\/]+$/, ''));
      void deck.openPath(p);
      deck.show(true);
      $('view-agent').hidden = true;
    } else {
      app.setCourseDir(p);
    }
  });

  void offerUpdate($('main'), app.say);
})();
