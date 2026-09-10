// The agent shell: what the page becomes when `ape-bridge` opened it. The
// rail on the left (course folder, deck name, the eight stages), the agent
// view (picker, then chat, with a gate above for artifacts), and the tool
// page itself as the deck view. app/src/main.ts, over the bridge.
//
// What the deck view does differently from the desktop app: checks, the card
// preview and the .apkg export run in this tab, on the engine the tool page
// already carries -- the bridge only supplies deck.json's text, the image
// bytes beside it, and the flags file. That keeps every deck operation on
// Node 20 (the bridge never touches node:sqlite) and keeps the preview that
// was proven at 10 MB.

import { Bridge, BridgeError, makeSidecarClient, type BridgeLocator, type ConnectResult, type Flag, type SidecarClient } from '../engine/bridge-client.js';
import { addMediaBytes, exportApkg, loadDeckText, postToPreview, setPreviewExtras, showError } from '../tool.js';
import { makeBus } from './bus.js';
import { mountChat, type Chat } from './chat.js';
import { mountFallbackPermissions } from './permission-any.js';
import { mountPicker } from './picker.js';
import { mountStages, type Stages } from './stages.js';

/** Appended to the review page: a Flag button per card, and an outline on flagged ones. */
const FLAG_SCRIPT = `<script>
document.querySelectorAll('article').forEach((a, i) => {
  const b = document.createElement('button');
  b.textContent = 'Flag';
  b.className = 'flag';
  b.style.cssText = 'float:right;margin-left:8px';
  b.onclick = () => parent.postMessage({ type: 'ape:flag', noteIndex: i }, '*');
  a.querySelector('.idx').prepend(b);
});
window.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'ape:flagged') return;
  document.querySelectorAll('article').forEach((a, i) => {
    a.style.outline = e.data.indexes.includes(i) ? '2px solid #E8C07D' : '';
  });
});
<\/script>`;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export async function mountAgentApp(locator: BridgeLocator): Promise<void> {
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  document.body.classList.add('with-rail');
  $('rail').hidden = false;
  $('rail').innerHTML = `
    <h1>A.P.E.</h1>
    <div class="course">
      <label class="muted" for="coursedir">Course folder</label>
      <input id="coursedir" placeholder="/path/to/lecture-3" autocomplete="off" spellcheck="false">
      <label class="muted" for="deckname-in">Deck name</label>
      <input id="deckname-in" placeholder="Course::Lecture 3" autocomplete="off">
    </div>
    <ol class="stages" id="stages"></ol>
    <nav class="views"><button data-view="agent">Agent</button><button data-view="deck">Deck</button></nav>
    <div class="status" id="status">connecting to the bridge…</div>`;
  const status = $('status');
  const say = (text: string, isError = false): void => {
    status.textContent = text;
    status.classList.toggle('error', isError);
  };

  // ---- the bridge ------------------------------------------------------------
  const bridge = new Bridge(locator);
  let sidecar: SidecarClient;
  try {
    const info = await bridge.health();
    await bridge.connect();
    sidecar = makeSidecarClient(bridge);
    say(`engine ${info.version} on node ${info.node}`);
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), true);
    showError(
      `This page was opened by ape-bridge, but the bridge cannot be reached. ` +
        `Is it still running in your terminal? If your browser asked to allow access to your local network, it needs a yes.`,
    );
    return;
  }
  const bus = makeBus(sidecar);
  // Prompts for sessions no chat pane owns -- the auditor's and the
  // adjudicator's. Without this their write permissions went unanswered.
  mountFallbackPermissions($('view-agent'), sidecar, bus);

  // ---- views -----------------------------------------------------------------
  const deckView = ['drop', 'results', 'exportnote'].map((id) => $(id));
  const agentView = $('view-agent');
  const showView = (name: 'agent' | 'deck'): void => {
    agentView.hidden = name !== 'agent';
    for (const el of deckView) if (name === 'agent') el.hidden = true;
    if (name === 'deck') {
      $('drop').hidden = false;
      $('results').hidden = deckLoaded === false;
    }
  };
  $('rail').querySelector('.views')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-view]');
    if (b) showView(b.dataset.view as 'agent' | 'deck');
  });

  // ---- course folder + deck name --------------------------------------------
  const courseInput = $<HTMLInputElement>('coursedir');
  const deckNameInput = $<HTMLInputElement>('deckname-in');
  let courseDir: string | null = locator.courseDir;
  if (courseDir) courseInput.value = courseDir;
  courseInput.addEventListener('change', () => {
    courseDir = courseInput.value.trim() || null;
    stages.setConnection(connection);
    void stages.refreshMarks();
  });

  // ---- deck view over the bridge ---------------------------------------------
  let deckLoaded = false;
  let deckPath: string | null = null;
  let flags: Flag[] = [];

  function renderFlags(): void {
    postToPreview({ type: 'ape:flagged', indexes: flags.map((f) => f.noteIndex) });
    const el = $('flags');
    el.innerHTML = flags.map((f, i) => `<li>#${f.noteIndex + 1} ${f.note ? `— ${esc(f.note)}` : ''} <button data-unflag="${i}">×</button></li>`).join('');
    $('flagcount').textContent = flags.length ? `(${flags.length})` : '';
    $('flagbox').hidden = false;
  }
  async function persistFlags(): Promise<void> {
    if (deckPath) await sidecar.writeFlags(deckPath, flags);
  }
  $('flags').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-unflag]');
    if (!b) return;
    flags.splice(Number(b.dataset.unflag), 1);
    renderFlags();
    void persistFlags();
  });
  setPreviewExtras({
    script: FLAG_SCRIPT,
    onMessage(data) {
      const m = data as { type?: string; noteIndex?: number };
      if (m?.type !== 'ape:flag' || !Number.isInteger(m.noteIndex)) return;
      // A stand-in for a designed flag sheet, as on the desktop (docs/APP.md).
      const note = window.prompt(`Flag card #${m.noteIndex! + 1}. What is wrong?`) ?? '';
      flags.push({ noteIndex: m.noteIndex!, note, at: new Date().toISOString() });
      renderFlags();
      void persistFlags();
    },
  });

  async function fetchFile(root: string, rel: string): Promise<Uint8Array | null> {
    const res = await fetch(bridge.fileUrl(root, rel));
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  }

  async function openDeck(dir: string): Promise<void> {
    showView('deck');
    say('loading deck.json…');
    const path = `${dir}/deck.json`;
    try {
      const text = (await sidecar.readCourse(dir, 'deck.json')).text;
      const info = await loadDeckText(text, 'deck.json');
      deckLoaded = true;
      deckPath = path;
      $('drop').hidden = true;
      // Images: beside the material first, then the Anki media folder.
      const mediaDir = await sidecar.mediaDir().then((m) => (m.exists ? m.mediaDir : null), () => null);
      let found = 0;
      for (const name of info.referencedMedia) {
        const bytes = (await fetchFile(dir, name)) ?? (mediaDir ? await fetchFile(mediaDir, name) : null);
        if (bytes) {
          addMediaBytes(name, bytes);
          found += 1;
        }
      }
      flags = (await sidecar.readFlags(path)).flags;
      renderFlags();
      say(`${info.count} notes${info.clean ? ', checks clean' : ', checks found problems'}${info.referencedMedia.length ? ` · ${found}/${info.referencedMedia.length} images` : ''}`, !info.clean);
    } catch (err) {
      say(err instanceof BridgeError ? `${err.message} (code ${err.code})` : String(err), true);
    }
  }

  // ---- stages + agent --------------------------------------------------------
  let connection: ConnectResult | null = null;
  let chat: Chat | null = null;
  // The runner gets a client whose newSession carries the chat pane's
  // selections over: the method's fresh auditor/adjudicator sessions must use
  // the model and mode the user picked, not the agent's defaults.
  const runnerClient: SidecarClient = {
    ...sidecar,
    newSession: async (connectionId: string) => {
      const r = await sidecar.newSession(connectionId);
      await chat?.applyConfigTo(r.session.sessionId);
      return r;
    },
  };
  const stages: Stages = mountStages($('stages') as HTMLOListElement, $('gate'), {
    sidecar: runnerClient,
    courseDir: () => courseDir,
    deckName: () => deckNameInput.value.trim(),
    say,
    showView,
    openDeck,
    exportDeck: async () => {
      if (!deckLoaded && courseDir) await openDeck(courseDir);
      await exportApkg();
    },
    currentFlags: () => flags,
  });

  function showPicker(): void {
    chat = null;
    connection = null;
    stages.setConnection(null);
    mountPicker($('agent-host'), sidecar, bus, locator.dataDir, () => courseDir, {
      say,
      onConnected(result) {
        if (!result.session || !courseDir) {
          say('connected but no session', true);
          return;
        }
        connection = result;
        chat = mountChat($('agent-host'), sidecar, bus, result, say);
        stages.setConnection(result);
        say(`${result.agent?.name ?? result.provider} ready — pick a stage on the left`);
        void stages.refreshMarks();
      },
    });
  }

  showView('agent');
  showPicker();
  void stages.refreshMarks();
  window.addEventListener('beforeunload', () => void chat?.dispose());
}
