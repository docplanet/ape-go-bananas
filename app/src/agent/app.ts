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
    <label class="railhead" for="rail-deck">Deck</label>
    <input id="rail-deck" placeholder="Course::Lecture 3" autocomplete="off" title="What the deck is called in Anki. Two colons make a subdeck.">
    <div id="rail-summary" class="muted"></div>
    <div class="railhead">Steps</div>
    <ol class="stages" id="stages"></ol>
    <nav class="library" id="rail-library" aria-label="Folders" hidden></nav>
    <div class="railfoot">
      <div id="rail-agent" class="muted"></div>
      <button type="button" id="rail-settings" class="quiet">Settings</button>
      <div class="status" id="status"></div>
    </div>`;
  view.innerHTML = `<section class="home-pane" hidden></section><section class="settings-pane" hidden></section><section class="materials" hidden></section><section class="gate" hidden></section><section class="agent-host" hidden></section>`;
  bar.className = 'nextbar';
  bar.hidden = true;
  // The way out of a deck, where the eye is when it wants out: above the
  // next-step bar, naming where the deck sits, as Anki does.
  const crumb = document.createElement('nav');
  crumb.className = 'crumb';
  crumb.setAttribute('aria-label', 'Where you are');
  crumb.hidden = true;
  bar.before(crumb);
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
  // A dev build's engine respawns itself when dist/ is rebuilt under it
  // (sidecar.rs). Everything the shell held on the old process is gone --
  // the agent connection first -- so start over, as a code change does.
  bus.onNotification((method) => {
    if (method === 'engine/restarted') location.reload();
  });
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
    crumb.hidden = bar.hidden;
    renderCrumb();
    // On the deck list no deck is being worked on, so the rail does not name
    // one. The deck stays open behind it -- its agent connected -- and is
    // marked in the list; opening it again is instant.
    for (const el of railDeckBits) el.hidden = !courseDir || name === 'home';
    $<HTMLElement>(rail, '#rail-library').hidden = name !== 'home';
    home.setOpen(courseDir);
    deck.show(name === 'deck');
    if (name === 'home') void refreshHome();
  }

  function renderCrumb(): void {
    const segs = deckName.split('::');
    const leaf = segs.pop() ?? '';
    crumb.innerHTML =
      `<button type="button" class="crumb-back" title="All decks (⌘[)">← Decks</button>` +
      `<span class="crumb-path">${segs.map((s) => `<span class="crumb-folder">${esc(s)}</span><i>::</i>`).join('')}<strong>${esc(leaf)}</strong></span>`;
  }
  crumb.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.crumb-back')) show('home');
  });
  // ⌘[ (Ctrl+[ elsewhere) is back, as in a browser or Finder.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === '[' && !crumb.hidden) {
      e.preventDefault();
      show('home');
    }
  });

  // ---- the deck: a workspace -----------------------------------------------------
  let courseDir: string | null = null;
  let connection: ConnectResult | null = null;
  let chat: Chat | null = null;

  // A deck under the decks root keeps its name in its own folder, so the
  // list, the rail and Anki agree; a folder the bridge was opened on is not
  // the app's to write a record into, and keeps the older way: this window's
  // storage.
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const inRoot = (dir: string): boolean => norm(dir).replace(/\/[^/]*$/, '') === norm(decksRoot);
  let deckName = '';

  async function renameDeck(dir: string, name: string): Promise<string | null> {
    // A run reads the deck's name into its prompt and writes deck.json; a
    // rename rewrites deck.json. Not both at once.
    const running = dir === courseDir ? stages.busy() : null;
    if (running) {
      say(`${running} is still running — rename the deck when it has finished`, true);
      return null;
    }
    try {
      if (!inRoot(dir)) {
        remember.set(REMEMBER.name(dir), name);
        return name;
      }
      const r = await sidecar.renameDeck(decksRoot, dir, name);
      remember.set(REMEMBER.name(dir), null);
      if (r.moved) say(`${r.moved} card${r.moved === 1 ? '' : 's'} now go to ${r.name}`);
      if (dir === courseDir) {
        deckName = deckInput.value = r.name;
        renderCrumb();
        if (screen === 'deck') await deck.open(dir);
      }
      return r.name;
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
      return null;
    }
  }

  deckInput.addEventListener('change', () => {
    if (!courseDir) return;
    const name = deckInput.value.trim();
    if (!name || name === deckName) {
      deckInput.value = deckName;
      return;
    }
    const dir = courseDir;
    void renameDeck(dir, name).then((named) => {
      if (!named && dir === courseDir) deckInput.value = deckName;
    });
  });

  async function refreshHome(): Promise<void> {
    try {
      let { decks, folders } = await sidecar.listDecks(decksRoot);
      // Names given before decks kept their own were kept in this window's
      // storage. Written into the deck the first time it is listed, unless
      // it has cards: those already say which deck they go to.
      let adopted = false;
      for (const d of decks) {
        const kept = remember.get(REMEMBER.name(d.path));
        if (kept === null) continue;
        remember.set(REMEMBER.name(d.path), null);
        if (kept && kept !== d.name && !d.artifacts.deck) adopted = (await sidecar.renameDeck(decksRoot, d.path, kept).then(() => true, () => false)) || adopted;
      }
      if (adopted) ({ decks, folders } = await sidecar.listDecks(decksRoot));
      home.setDecks(decks, folders ?? []);
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
    }
  }

  /** Lets go of the open deck: its agent session, its place in the rail. */
  async function closeWorkspace(): Promise<void> {
    if (chat) {
      // The agent's session was opened in the old folder; a new folder is a new session.
      await chat.dispose();
      chat = null;
      connection = null;
      stages.setConnection(null);
      picker.setState({ connected: null });
    }
    courseDir = null;
    deckName = deckInput.value = '';
    materials.hideNotice();
    home.setOpen(null);
    remember.set(REMEMBER.deck, null);
    picker.setState({ hasFolder: false });
    showAgentLine();
  }

  async function deleteDeck(d: DeckSummary): Promise<void> {
    if (d.path === courseDir) {
      const running = stages.busy();
      if (running) {
        say(`${running} is still running in ${d.name} — stop it or let it finish first`, true);
        return;
      }
      await closeWorkspace();
    }
    try {
      const { trashed } = await sidecar.deleteDeck(decksRoot, d.path);
      await refreshHome();
      home.notify(`Deleted ${d.name}. Its files are kept for 30 days; nothing in Anki is touched.`, {
        label: 'Undo',
        run: () =>
          void sidecar
            .restoreDeck(decksRoot, trashed)
            .then((r) => {
              home.notify(`Restored ${r.name}.`);
              return refreshHome();
            })
            .catch((err: unknown) => say(err instanceof EngineError ? err.message : String(err), true)),
      });
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

  /**
   * Opens a deck's folder: the materials, the steps, and the chosen agent
   * connected in it. `quiet` is for the deck remembered from last time, which
   * may simply be gone -- renamed, deleted, on a disk that is not mounted.
   * That is not a failure the person caused and should not be shouted at them
   * in red on a screen they did not ask for.
   */
  async function openWorkspace(dir: string, name: string, quiet = false): Promise<boolean> {
    if (dir === courseDir) {
      show('agent');
      return true;
    }
    // A run belongs to the deck it started in: its results, its Stop and a
    // run-through's next stage all read "the current deck", so the deck does
    // not change under it.
    const running = stages.busy();
    if (running) {
      say(`${running} is still running in ${deckInput.value.trim() || 'this deck'} — stop it or let it finish first`, true);
      return false;
    }
    let named: string | null = null;
    try {
      named = (await sidecar.listCourse(dir)).name;
    } catch (err) {
      if (quiet) say(`${basename(dir)} is not there any more — pick a deck, or start a new one`);
      else say(err instanceof EngineError ? err.message : String(err), true);
      return false;
    }
    await closeWorkspace();
    courseDir = dir;
    remember.set(REMEMBER.deck, dir);
    deckName = deckInput.value = named ?? remember.get(REMEMBER.name(dir)) ?? name;
    renderCrumb();
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
      await openWorkspace(made.path, made.name);
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
      const dir = courseDir;
      const name = basename(relPath);
      const refresh = () => (dir === courseDir ? Promise.all([refreshMaterials(), stages.refresh()]) : undefined);
      const failed = (err: unknown) => say(err instanceof EngineError ? err.message : String(err), true);
      void sidecar
        .deleteCourse(dir, relPath, { trash: true })
        .then(async ({ trashed }) => {
          await refresh();
          if (!trashed || dir !== courseDir) return;
          materials.notify(`Removed ${name}. It is kept for 30 days.`, {
            label: 'Undo',
            run: () =>
              void sidecar
                .restoreCourse(dir, trashed)
                .then(async (r) => {
                  await refresh();
                  if (dir === courseDir) materials.notify(r.name === relPath ? `Put back ${name}.` : `Put back as ${r.name}: ${name} was added again meanwhile.`);
                })
                .catch(failed),
          });
        })
        .catch(failed);
    },
  });

  $<HTMLButtonElement>(rail, '#rail-settings').addEventListener('click', () => show('settings'));

  // ---- home, settings ----------------------------------------------------------
  const home: Home = mountHome(homeEl, {
    rail: $<HTMLElement>(rail, '#rail-library'),
    onNew: (name) => void newDeck(name),
    onOpen: (d) => void openWorkspace(d.path, d.name),
    onRename: async (d, name) => {
      const ok = (await renameDeck(d.path, name)) !== null;
      await refreshHome();
      return ok;
    },
    async onNewFolder(name) {
      try {
        const r = await sidecar.createFolder(decksRoot, name);
        await refreshHome();
        home.notify(`Made the folder ${r.name}.`);
        return true;
      } catch (err) {
        say(err instanceof EngineError ? err.message : String(err), true);
        return false;
      }
    },
    async onDeleteFolder(name) {
      try {
        const { removed } = await sidecar.deleteFolder(decksRoot, name);
        await refreshHome();
        home.notify(`Deleted the folder ${name}.`, {
          label: 'Undo',
          run: () =>
            void (async () => {
              for (const f of removed) await sidecar.createFolder(decksRoot, f);
              await refreshHome();
            })().catch((err: unknown) => say(err instanceof EngineError ? err.message : String(err), true)),
        });
      } catch (err) {
        say(err instanceof EngineError ? err.message : String(err), true);
      }
    },
    async onRenameFolder(from, to) {
      try {
        await sidecar.renameFolder(decksRoot, from, to);
      } catch (err) {
        say(err instanceof EngineError ? err.message : String(err), true);
        return;
      }
      const { decks } = await sidecar.listDecks(decksRoot);
      const inside = decks.filter((d) => d.name === from || d.name.startsWith(`${from}::`));
      let failed = 0;
      for (const d of inside) if ((await renameDeck(d.path, to + d.name.slice(from.length))) === null) failed += 1;
      await refreshHome();
      if (!failed) home.notify(`Moved ${inside.length} deck${inside.length === 1 ? '' : 's'} to ${to}.`);
    },
    onDelete: deleteDeck,
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
    // Said where it is seen every day: an agent is never updated on its own,
    // and Settings is a screen nobody opens once the agent works.
    const newer = chosen ? picker.updateFor(chosen) : null;
    $<HTMLElement>(rail, '#rail-agent').textContent =
      (!name ? 'No agent chosen' : connection ? `${name} · connected` : `${name} · not connected`) + (newer ? ` · update ${newer} in Settings` : '');
    home.setAgent(name);
  }
  let attaching: Promise<void> = Promise.resolve();
  const picker: Picker = mountPicker(settings.agentSlot, sidecar, bus, host.dataDir(), () => courseDir, opts.keys, {
    say,
    onListed: () => showAgentLine(),
    async release(id) {
      const running = stages.busy();
      if (running) {
        say(`${running} is still running — change the agent when it has finished`, true);
        return false;
      }
      await attaching; // a connect that is landing now is let go of too, not left behind
      if (connection?.provider === id) {
        await chat?.dispose();
        chat = null;
        connection = null;
        stages.setConnection(null);
        picker.setState({ connected: null });
        showAgentLine();
      }
      return true;
    },
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
      // One at a time: two connects finishing together (a double press, the
      // auto-connect meeting a Reconnect) both disposed the same old pane and
      // mounted a new one each, and the first new one was never closed.
      attaching = attaching.then(async () => {
        if (chat) await chat.dispose();
        // The adapter names itself by its package; the person chose "Claude Agent".
        const named: ConnectResult = { ...result, agent: { name: picker.nameOf(result.provider) ?? result.agent?.name ?? result.provider, version: result.agent?.version ?? '' } };
        connection = named;
        chat = mountChat(agentHost, sidecar, bus, named, say, () => courseDir, { get: () => remember.get(REMEMBER.mode), set: (id) => remember.set(REMEMBER.mode, id) }, { note: () => stages.note(), act: (d) => stages.act(d) });
        stages.setConnection(named);
        picker.setState({ connected: result.provider, chosen: result.provider });
        remember.set(REMEMBER.agent, result.provider);
        showAgentLine();
        say(`${named.agent!.name} ready`);
        if (screen === 'settings') show('agent');
        await stages.refresh();
      }).catch((err: unknown) => say(err instanceof EngineError ? err.message : String(err), true));
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
    bus,
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
    // `given` was asked for on the command line, so its failure is worth
    // saying plainly; `last` is just where we were, and may be long gone.
    if (first && !(await openWorkspace(first, basename(first), first === last && !given))) {
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
