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

import { BridgeError, makeSidecarClient, type ConnectResult, type EngineHost, type Flag, type SidecarClient } from '../engine/bridge-client.js';
import { addMediaBytes, exportApkg, loadDeckText, postToPreview, setPreviewExtras } from '../tool.js';
import { makeBus } from './bus.js';
import { mountChat, type Chat } from './chat.js';
import { mountFallbackPermissions } from './permission-any.js';
import { extractMaterials } from './extract.js';
import { mountPicker } from './picker.js';
import { mountSignIn } from './signin.js';
import { CLAUDE_JS_TOP_MODELS, CLAUDE_JS_VERSION } from '../container/pinned.ts';
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

export async function mountAgentApp(host: EngineHost): Promise<void> {
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  document.body.classList.add('with-rail');
  $('rail').hidden = false;
  $('rail').innerHTML = `
    <h1>A.P.E.</h1>
    <div class="course">
      ${
        host.writeCourseFile
          ? `<label class="muted">Lecture files</label>
             <div id="uploadzone" class="uploadzone">
               <input type="file" id="coursefiles" multiple hidden>
               <button type="button" class="link" id="addcourse">Add files</button>
               <span class="muted"> or drop them here</span>
             </div>
             <ul id="courselist" class="courselist"></ul>
             <input id="coursedir" type="hidden">`
          : `<label class="muted" for="coursedir">Course folder</label>
             <input id="coursedir" placeholder="/path/to/lecture-3" autocomplete="off" spellcheck="false">`
      }
      <label class="muted" for="deckname-in">Deck name</label>
      <input id="deckname-in" placeholder="Course::Lecture 3" autocomplete="off">
    </div>
    <div class="railhead">Steps <span class="muted">— click one to run</span></div>
    <ol class="stages" id="stages"></ol>
    <div class="railhead">View</div>
    <nav class="views">
      <button data-view="agent" title="The agent: sign-in, the picker, and the chat">Agent</button>
      <button data-view="deck" title="The deck: every card, the checks and your flags — after stage 5">Deck</button>
    </nav>
    <div class="status" id="status">connecting to the bridge…</div>`;
  const status = $('status');
  const say = (text: string, isError = false): void => {
    status.textContent = text;
    status.classList.toggle('error', isError);
  };

  // ---- the engine, wherever it is running -------------------------------------
  const sidecar: SidecarClient = makeSidecarClient(host);
  say(`engine ${host.info.version} on node ${host.info.node}${host.info.transport === 'container' ? ' — in this tab' : ''}`);
  const bus = makeBus(sidecar);

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
  let courseDir: string | null = host.courseRoot();
  if (courseDir) courseInput.value = courseDir;
  courseInput.addEventListener('change', () => {
    courseDir = courseInput.value.trim() || null;
    stages.setConnection(connection);
    void stages.refreshMarks();
  });

  // In the tab, the course folder is inside the sandbox: the user hands over
  // files rather than naming a path, and the bytes go straight to the
  // container's filesystem instead of through JSON-RPC.
  if (host.writeCourseFile) {
    courseInput.value = courseDir ?? '';
    const list = $('courselist');
    const refreshList = async (): Promise<void> => {
      const names = (await host.listCourseFiles?.()) ?? [];
      list.innerHTML = names.length === 0 ? '' : names.map((n) => `<li>${esc(n)}</li>`).join('');
    };
    const accept = async (files: File[]): Promise<void> => {
      if (files.length === 0) return;
      try {
        for (const file of files) {
          say(`adding ${file.name}…`);
          await host.writeCourseFile!(file.name, new Uint8Array(await file.arrayBuffer()));
        }
        say(`${files.length} file${files.length === 1 ? '' : 's'} added — click 1 extract on the left when you are ready`);
      } catch (err) {
        say(err instanceof Error ? err.message : String(err), true);
      }
      await refreshList();
      await stages.refreshMarks();
    };
    const picker = $<HTMLInputElement>('coursefiles');
    $('addcourse').addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => {
      void accept([...(picker.files ?? [])]);
      picker.value = '';
    });
    const zone = $('uploadzone');
    for (const type of ['dragenter', 'dragover'] as const) {
      zone.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add('over');
      });
    }
    for (const type of ['dragleave', 'drop'] as const) {
      zone.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove('over');
        if (type === 'drop') void accept([...((e as DragEvent).dataTransfer?.files ?? [])]);
      });
    }
    void refreshList();
  }
  // Prompts for sessions no chat pane owns -- the auditor's and the
  // adjudicator's. Without this their write permissions went unanswered.
  mountFallbackPermissions($('view-agent'), sidecar, bus, () => courseDir);

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

  const fetchFile = (root: string, rel: string): Promise<Uint8Array | null> => host.readFile(root, rel);

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
  // In the tab, an agent has to be fetched before it can be installed or
  // connected -- Claude Code's current release is a native binary, so the
  // pinned JavaScript build is pulled into the container first. On the bridge
  // the host has no prepareProvider and these pass straight through.
  const prepare = async (providerId: string): Promise<void> => {
    await host.prepareProvider?.(providerId, (step) => say(`${step}…`));
  };
  const pickerClient: SidecarClient = {
    ...sidecar,
    installProvider: async (dataDir, id) => {
      await prepare(id);
      return sidecar.installProvider(dataDir, id);
    },
    connect: async (params) => {
      await prepare(params.provider);
      return sidecar.connect(params);
    },
  };

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
    prepareMaterials: async (dir) => {
      await extractMaterials(sidecar, host, dir, say);
    },
    currentFlags: () => flags,
  });

  function showPicker(): void {
    chat = null;
    connection = null;
    stages.setConnection(null);
    $('signin-open')?.classList.remove('hidden');
    mountPicker($('agent-host'), pickerClient, bus, host.dataDir(), () => courseDir, {
      say,
      onConnected(result) {
        if (!result.session || !courseDir) {
          say('connected but no session', true);
          return;
        }
        connection = result;
        chat = mountChat($('agent-host'), sidecar, bus, result, say, () => courseDir);
        stages.setConnection(result);
        // Signed in and connected: the sign-in button is now a confusing
        // second door, so it goes until the picker comes back.
        $('signin-open')?.classList.add('hidden');
        say(`${result.agent?.name ?? result.provider} ready — click 1 extract on the left to start`);
        void stages.refreshMarks();
      },
    });
  }

  // Signing in is the CLI's own flow, so the page offers it as a console
  // rather than a form (signin.ts). Only the in-tab host has one.
  if (host.signIn) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'signin-open';
    button.className = 'ghost';
    button.textContent = 'Sign in to Claude';
    button.addEventListener('click', () => {
      button.disabled = true;
      void (async () => {
        try {
          await prepare('claude');
          mountSignIn($('view-agent'), host, say, () => {
            button.disabled = false;
          });
        } catch (err) {
          button.disabled = false;
          say(err instanceof Error ? err.message : String(err), true);
        }
      })();
    });
    $('rail').querySelector('.views')!.after(button);
    // The pinned build's model list stops where its release did. That is the
    // first visible cost of pinning, and someone who sees a stale dropdown
    // deserves to know why rather than guess at it.
    const note = document.createElement('p');
    note.className = 'railnote';
    note.textContent = `Claude here is a pinned build (${CLAUDE_JS_VERSION}) — the last that runs in a tab. Its models stop at ${CLAUDE_JS_TOP_MODELS}. For the newest, use the bridge.`;
    button.after(note);
  }

  showView('agent');
  showPicker();
  void stages.refreshMarks();
  window.addEventListener('beforeunload', () => void chat?.dispose());
}
