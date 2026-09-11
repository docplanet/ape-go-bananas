// The shell: docs/APP.md's one window. The rail on the left holds the deck's
// name, the eight steps and Settings; the main pane is card generation --
// the materials the person added, the bar that says what is next, the
// artifact gate, the agent's live output, the deck preview at step 6 --
// and, with no deck open, the list of decks. A deck is a workspace the app
// owns, one folder per deck under its data dir; files are added by dropping
// them on the window or from a picker. The agent is a setting: chosen once
// in Settings, remembered, connected on its own whenever a deck is opened,
// because its session is opened in the deck's folder.
//
// It is the same code in the desktop app and on the tool page when
// `ape-bridge` opens it -- the host (engine/host.ts) is what differs. The
// deck view is injected, because that is the one thing the two shells do
// differently: the desktop app loads, checks, renders and exports through
// the sidecar's deck/* methods on the Node engine; the tool page does all
// of that in the tab on the engine it already carries.

import { toBase64 } from '../engine/bytes.js';
import { EngineError, makeSidecarClient, type ConnectResult, type DeckSummary, type EngineHost, type SidecarClient, type SendToAnkiResult } from '../engine/client.js';
import { makeBus } from './bus.js';
import { mountChat, type Chat } from './chat.js';
import { extractMaterials } from './extract.js';
import { mountHome, type Home } from './home.js';
import { mountMaterials, type Materials } from './materials.js';
import { mountFallbackPermissions } from './permission-any.js';
import { mountPicker, type KeyStore, type Picker } from './picker.js';
import { mountSettings, type Settings } from './settings.js';
import { mountStages, type Stages } from './stages.js';

/** The deck half of the window: everything from "deck.json is there" to the .apkg. */
export interface DeckView {
  /** Shows or hides the deck panes; when hidden, the agent pane has the main area. */
  show(visible: boolean): void;
  /** Loads `<courseDir>/deck.json`: the checks, the card preview, the owner's flags. Reports its own failures. */
  open(courseDir: string): Promise<void>;
  /** Exports `<courseDir>/deck.json`; the path written, or null when it was saved some other way (a download) or failed. Reports its own failures. */
  export(courseDir: string): Promise<string | null>;
  /** Puts `<courseDir>/deck.json` into the running Anki; null when it failed (Anki closed, most often). Reports its own failures. */
  sendToAnki(courseDir: string): Promise<SendToAnkiResult | null>;
}

export interface AgentAppOptions {
  rail: HTMLElement;
  /** The next-step bar's element, above the main pane's views. */
  bar: HTMLElement;
  /** The main pane's container for everything but the deck view: home, settings, materials, the gate and the agent's output. */
  view: HTMLElement;
  deck: DeckView;
  /** Where an API key entered in Settings is kept: the OS keychain on the desktop, the tab on the site. */
  keys: KeyStore;
  /** A native file dialog returning paths, where the shell has one; without it, a file input whose bytes go through the sidecar. */
  pickFiles?: () => Promise<string[] | null>;
}

export interface AgentApp {
  courseDir(): string | null;
  /** Files by path (a drop on the desktop window): into the open deck, or into a new deck named after them. */
  addPaths(paths: string[]): Promise<void>;
  /** Files by content (a browser drop or file input): same. */
  addFiles(files: File[]): Promise<void>;
  /** The one status line, for the shell's own messages too (an update). */
  say(text: string, isError?: boolean): void;
  dispose(): Promise<void>;
}

const REMEMBER = { deck: 'ape.deck', agent: 'ape.agent', mode: 'ape.mode', name: (dir: string) => `ape.name:${dir}` };
const remember = {
  get: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string | null): void => {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* a webview with storage blocked: the app still works, it just forgets */
    }
  },
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function basename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
}

export function mountAgentApp(host: EngineHost, opts: AgentAppOptions): AgentApp {
  const { rail, bar, view, deck } = opts;
  rail.innerHTML = `
    <h1>A.P.E.</h1>
    <button type="button" id="rail-home" class="quiet">All decks</button>
    <label class="railhead" for="rail-deck">Deck</label>
    <input id="rail-deck" placeholder="Course::Lecture 3" autocomplete="off" title="What the deck is called in Anki. Two colons make a subdeck.">
    <div id="rail-summary" class="muted"></div>
    <div class="railhead">Steps</div>
    <ol class="stages" id="stages"></ol>
    <div class="railfoot">
      <div id="rail-agent" class="muted"></div>
      <button type="button" id="rail-settings" class="quiet">Settings</button>
      <div class="status" id="status"></div>
    </div>`;
  view.innerHTML = `<section class="home-pane" hidden></section><section class="settings-pane" hidden></section><section class="materials" hidden></section><section class="gate" hidden></section><section class="agent-host" hidden></section>`;
  bar.className = 'nextbar';
  bar.hidden = true;
  const $ = <T extends HTMLElement>(root: HTMLElement, sel: string): T => root.querySelector<T>(sel)!;
  const status = $<HTMLElement>(rail, '#status');
  const say = (text: string, isError = false): void => {
    status.textContent = text;
    status.classList.toggle('error', isError);
  };
  const homeEl = $<HTMLElement>(view, '.home-pane');
  const settingsEl = $<HTMLElement>(view, '.settings-pane');
  const materialsEl = $<HTMLElement>(view, '.materials');
  const gate = $<HTMLElement>(view, '.gate');
  const agentHost = $<HTMLElement>(view, '.agent-host');
  const deckInput = $<HTMLInputElement>(rail, '#rail-deck');
  const railDeckBits = [deckInput, $<HTMLElement>(rail, '#rail-summary'), ...rail.querySelectorAll<HTMLElement>('.railhead, .stages')];

  // ---- the engine, wherever it is running -------------------------------------
  const sidecar: SidecarClient = makeSidecarClient(host);
  const bus = makeBus(sidecar);
  const decksRoot = `${host.dataDir().replace(/[\\/]$/, '')}/decks`;

  // ---- screens ---------------------------------------------------------------
  type Screen = 'home' | 'settings' | 'agent' | 'deck';
  let screen: Screen = 'home';
  let before: Screen = 'home';
  function show(name: Screen): void {
    if (name !== 'settings') before = name;
    screen = name;
    view.hidden = name === 'deck';
    homeEl.hidden = name !== 'home';
    settingsEl.hidden = name !== 'settings';
    materialsEl.hidden = name !== 'agent';
    gate.hidden = name !== 'agent' || gate.innerHTML === '';
    agentHost.hidden = name !== 'agent';
    bar.hidden = !(name === 'agent' || name === 'deck') || !courseDir;
    for (const el of railDeckBits) el.hidden = !courseDir;
    $<HTMLElement>(rail, '#rail-home').hidden = name === 'home';
    deck.show(name === 'deck');
    if (name === 'home') void refreshHome();
  }

  // ---- the deck: a workspace -----------------------------------------------------
  let courseDir: string | null = null;
  let connection: ConnectResult | null = null;
  let chat: Chat | null = null;

  deckInput.addEventListener('change', () => {
    if (courseDir) remember.set(REMEMBER.name(courseDir), deckInput.value.trim());
  });

  async function refreshHome(): Promise<void> {
    try {
      home.setDecks((await sidecar.listDecks(decksRoot)).decks);
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
    }
  }

  async function refreshMaterials(): Promise<void> {
    if (!courseDir) return;
    try {
      const { files, extracted } = await sidecar.listCourse(courseDir);
      const material = files.filter((f) => f.kind !== 'other');
      materials.set(material, extracted);
      const pdfs = material.filter((f) => f.kind === 'pdf').length;
      $<HTMLElement>(rail, '#rail-summary').textContent = material.length ? `${material.length} file${material.length === 1 ? '' : 's'}${pdfs ? `, ${pdfs} PDF${pdfs === 1 ? '' : 's'}` : ''}` : 'no files yet';
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
    }
  }

  /** Opens a deck's folder: the materials, the steps, and the chosen agent connected in it. */
  async function openWorkspace(dir: string, name: string): Promise<boolean> {
    if (dir === courseDir) {
      show('agent');
      return true;
    }
    try {
      await sidecar.listCourse(dir);
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
      return false;
    }
    if (chat) {
      // The agent's session was opened in the old folder; a new folder is a new session.
      await chat.dispose();
      chat = null;
      connection = null;
      stages.setConnection(null);
      picker.setState({ connected: null });
    }
    courseDir = dir;
    remember.set(REMEMBER.deck, dir);
    deckInput.value = remember.get(REMEMBER.name(dir)) ?? name;
    picker.setState({ hasFolder: true });
    show('agent');
    await Promise.all([refreshMaterials(), stages.refresh()]);
    const chosen = remember.get(REMEMBER.agent);
    if (chosen) {
      const ok = await picker.connectIfInstalled(chosen);
      if (!ok && !connection) say(`${picker.nameOf(chosen) ?? chosen} could not be connected — see Settings`, true);
    } else {
      say('no agent chosen yet — the first step will send you to Settings');
    }
    return true;
  }

  async function newDeck(name: string): Promise<string | null> {
    try {
      const made = await sidecar.createDeck(decksRoot, name);
      remember.set(REMEMBER.name(made.path), name);
      await openWorkspace(made.path, name);
      return made.path;
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
      return null;
    }
  }

  // ---- adding and removing materials ----------------------------------------------
  async function addPaths(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    if (!courseDir && !(await newDeck(basename(paths[0]!).replace(/\.[^.]+$/, '')))) return;
    try {
      const { imported } = await sidecar.importCourse(courseDir!, paths);
      say(imported.length ? `added ${imported.length} file${imported.length === 1 ? '' : 's'}` : 'nothing to add from that');
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
    }
    await Promise.all([refreshMaterials(), stages.refresh()]);
  }
  async function addFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    if (!courseDir && !(await newDeck(files[0]!.name.replace(/\.[^.]+$/, '')))) return;
    let added = 0;
    for (const file of files) {
      try {
        say(`adding ${file.name}…`);
        await sidecar.writeCourse(courseDir!, file.name, { base64: toBase64(new Uint8Array(await file.arrayBuffer())) });
        added += 1;
      } catch (err) {
        say(err instanceof EngineError ? err.message : String(err), true);
      }
    }
    if (added) say(`added ${added} file${added === 1 ? '' : 's'}`);
    await Promise.all([refreshMaterials(), stages.refresh()]);
  }
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.addEventListener('change', () => {
    void addFiles([...(fileInput.files ?? [])]);
    fileInput.value = '';
  });
  view.append(fileInput);
  function askForFiles(): void {
    if (opts.pickFiles) {
      void opts.pickFiles().then((paths) => {
        if (paths) void addPaths(paths);
      });
    } else fileInput.click();
  }
  // A browser drop anywhere: files by content. (The desktop webview hands
  // drops to Rust instead, and main.ts calls addPaths with the paths.)
  for (const type of ['dragenter', 'dragover'] as const) document.addEventListener(type, (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) void addFiles(files);
  });
  const materials: Materials = mountMaterials(materialsEl, {
    onAdd: askForFiles,
    onRemove(relPath) {
      if (!courseDir) return;
      void sidecar
        .deleteCourse(courseDir, relPath)
        .then(() => Promise.all([refreshMaterials(), stages.refresh()]))
        .catch((err: unknown) => say(err instanceof EngineError ? err.message : String(err), true));
    },
  });

  $<HTMLButtonElement>(rail, '#rail-home').addEventListener('click', () => show('home'));
  $<HTMLButtonElement>(rail, '#rail-settings').addEventListener('click', () => show('settings'));

  // ---- home, settings ----------------------------------------------------------
  const home: Home = mountHome(homeEl, {
    onNew: (name) => void newDeck(name),
    onOpen: (d) => void openWorkspace(d.path, d.name),
    openSettings: () => show('settings'),
  });
  const settings: Settings = mountSettings(settingsEl, host, {
    onDone: () => show(before === 'settings' ? 'home' : before),
    say,
  });
  void sidecar.listMethod().then(
    (m) => settings.setMethodDir(m.dir),
    () => settings.setMethodDir(null),
  );

  // Prompts for sessions no chat pane owns -- the auditor's and the
  // adjudicator's. Without this their write permissions went unanswered.
  mountFallbackPermissions(view, sidecar, bus, () => courseDir);

  // ---- the agent, as a setting --------------------------------------------------
  function showAgentLine(): void {
    const chosen = remember.get(REMEMBER.agent);
    const name = chosen ? (picker.nameOf(chosen) ?? chosen) : null;
    $<HTMLElement>(rail, '#rail-agent').textContent = !name ? 'No agent chosen' : connection ? `${name} · connected` : `${name} · not connected`;
    home.setAgent(name);
  }
  const picker: Picker = mountPicker(settings.agentSlot, sidecar, bus, host.dataDir(), () => courseDir, opts.keys, {
    say,
    onChosen(id) {
      remember.set(REMEMBER.agent, id);
      picker.setState({ chosen: id });
      showAgentLine();
    },
    onConnected(result) {
      if (!result.session || !courseDir) {
        say('connected but no session', true);
        return;
      }
      void (async () => {
        if (chat) await chat.dispose();
        // The adapter names itself by its package; the person chose "Claude Agent".
        const named: ConnectResult = { ...result, agent: { name: picker.nameOf(result.provider) ?? result.agent?.name ?? result.provider, version: result.agent?.version ?? '' } };
        connection = named;
        chat = mountChat(agentHost, sidecar, bus, named, say, () => courseDir, { get: () => remember.get(REMEMBER.mode), set: (id) => remember.set(REMEMBER.mode, id) });
        stages.setConnection(named);
        picker.setState({ connected: result.provider, chosen: result.provider });
        remember.set(REMEMBER.agent, result.provider);
        showAgentLine();
        say(`${named.agent!.name} ready`);
        if (screen === 'settings') show('agent');
        await stages.refresh();
      })();
    },
  });
  picker.setState({ chosen: remember.get(REMEMBER.agent) });
  void picker.ready.then(showAgentLine);

  // ---- the steps ---------------------------------------------------------------
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
  const stages: Stages = mountStages($<HTMLOListElement>(rail, '#stages'), bar, gate, {
    sidecar: runnerClient,
    courseDir: () => courseDir,
    deckName: () => deckInput.value.trim(),
    say,
    showAgentView: () => show('agent'),
    openDeck: async (dir) => {
      show('deck');
      await deck.open(dir);
    },
    exportDeck: async () => (courseDir ? deck.export(courseDir) : null),
    sendToAnki: async () => (courseDir ? deck.sendToAnki(courseDir) : null),
    prepareMaterials: async (dir) => {
      await extractMaterials(sidecar, host, dir, say);
      await refreshMaterials();
    },
    openSettings: () => show('settings'),
    hasMaterials: () => materials.count() > 0,
    addFiles: askForFiles,
  });

  // ---- start -------------------------------------------------------------------
  say(`engine ${host.info.version} on node ${host.info.node}`);
  show('home');
  showAgentLine();
  void (async () => {
    // The folder the host was opened on (ape-bridge's argument), else the deck from last time.
    const given = host.courseRoot();
    const last = remember.get(REMEMBER.deck);
    const first = given ?? last;
    if (first && !(await openWorkspace(first, basename(first)))) {
      remember.set(REMEMBER.deck, null);
      show('home');
    }
    showAgentLine();
  })();

  const dispose = async (): Promise<void> => {
    await chat?.dispose();
    host.close();
  };
  window.addEventListener('beforeunload', () => void dispose());

  return {
    courseDir: () => courseDir,
    addPaths,
    addFiles,
    say,
    dispose,
  };
}

export { EngineError, esc };
export type { DeckSummary };
