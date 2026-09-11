// The engine hosted inside the tab.
//
// WebContainer is a Node runtime compiled to WebAssembly, so the sidecar
// that the desktop app drove over stdio and that `ape-bridge` serves over
// loopback runs here unchanged -- `dist/` is mounted into the container's
// filesystem and started as an ordinary child process. Everything the page
// already knows how to ask for (deck/*, course/*, method/*, agents/*,
// agent/*) therefore works with no second implementation, and an ACP agent
// the sidecar installs and spawns is a process in the same sandbox.
//
// The one pinned dependency: Claude Code ships the native binary from
// v2.1.113 on, and a Mach-O executable cannot run in here. Anthropic's own
// guidance for that case is to pin an earlier version, so the page installs
// the last JavaScript build and points the adapter at it through
// CLAUDE_CODE_EXECUTABLE (wrapper.ts).

import { WebContainer, type WebContainerProcess } from '@webcontainer/api';
import { BridgeError, type BridgeInfo, type ReverseRequest } from '../engine/bridge-transport.js';
import type { EngineHost } from '../engine/host.js';
import { LineSplitter, decodeLine, encodeIn } from './framing.js';
import { engineFileCount, engineTree, put, type FileTree } from './engine-files.js';
import { WRAPPER_PATH, WRAPPER_SOURCE } from './wrapper.js';

export { CLAUDE_JS_VERSION } from './pinned.ts';
import { CLAUDE_JS_VERSION } from './pinned.ts';

const METHOD_RAW = 'https://raw.githubusercontent.com/docplanet/anki-process-engine-live/main/';
const METHOD_FILES: { name: string; from: string }[] = [
  { name: '1-extract.md', from: 'method/1-extract.md' },
  { name: '2-organize.md', from: 'method/2-organize.md' },
  { name: '3-cards.md', from: 'method/3-cards.md' },
  { name: '4-audit.md', from: 'method/4-audit.md' },
  { name: 'SETUP.md', from: 'SETUP.md' },
];
const COURSE_DIR = 'course';
const READY_TIMEOUT_MS = 30_000;
const LOG_LINES = 500;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
export type Progress = (step: string) => void;

/** Boots a container, mounts the engine, and starts the sidecar in it. */
export async function startContainerHost(onProgress: Progress = () => {}): Promise<ContainerHost> {
  onProgress('starting a Node runtime in this tab');
  const wc = await WebContainer.boot();

  onProgress('fetching the method files');
  const tree: FileTree = engineTree();
  const method: FileTree = {};
  await Promise.all(
    METHOD_FILES.map(async (f) => {
      const res = await fetch(METHOD_RAW + f.from);
      if (!res.ok) throw new BridgeError(-32000, `could not fetch ${f.name}: HTTP ${res.status}`);
      put(method, f.name, await res.text());
    }),
  );
  tree.method = { directory: method };
  tree[COURSE_DIR] = { directory: {} };
  tree.home = { directory: {} };
  put(tree, WRAPPER_PATH, WRAPPER_SOURCE);
  put(tree, 'package.json', JSON.stringify({ name: 'ape-container', private: true, type: 'module' }, null, 2));

  onProgress(`mounting the engine (${engineFileCount()} files)`);
  await wc.mount(tree);

  onProgress('starting the engine');
  const host = new ContainerHost(wc);
  await host.start();
  return host;
}

export class ContainerHost implements EngineHost {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private notificationHandler: ((method: string, params: unknown) => void) | null = null;
  private requestHandler: ((request: ReverseRequest) => void) | null = null;
  private process: WebContainerProcess | null = null;
  private writer: WritableStreamDefaultWriter<string> | null = null;
  private failure: string | null = null;
  private readyResolve: (() => void) | null = null;
  /** The adapters' own logging, kept for when a session stalls and the page has nothing else to show. */
  readonly log: string[] = [];
  info: BridgeInfo = { engine: 'ape', version: '0', node: '0', transport: 'container' };

  constructor(private readonly wc: WebContainer) {}

  /** Absolute path of the course folder inside the container. */
  courseRoot(): string {
    return `${this.wc.workdir}/${COURSE_DIR}`;
  }

  dataDir(): string {
    return `${this.wc.workdir}/data`;
  }

  async start(): Promise<void> {
    const proc = await this.wc.spawn('node', [WRAPPER_PATH]);
    this.process = proc;
    this.writer = proc.input.getWriter();
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new BridgeError(-32000, 'the engine did not start in this tab within 30s')), READY_TIMEOUT_MS);
      this.readyResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    const splitter = new LineSplitter();
    void proc.output.pipeTo(
      new WritableStream({
        write: (chunk: string) => {
          for (const raw of splitter.push(chunk)) this.take(raw);
        },
      }),
    );
    void proc.exit.then((code) => this.fail(`the engine in this tab exited (${code})`));
    await ready;
  }

  private take(raw: string): void {
    const line = decodeLine(raw);
    if (line === null) return;
    if (line.kind === 'err') {
      this.log.push(line.text);
      if (this.log.length > LOG_LINES) this.log.shift();
      return;
    }
    if (line.kind === 'exit') {
      this.fail(`the engine in this tab exited (${line.code ?? 'signal'})`);
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line.text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.method === 'sidecar/ready') {
      const params = (message.params ?? {}) as Partial<BridgeInfo>;
      this.info = { engine: params.engine ?? 'ape', version: params.version ?? '0', node: params.node ?? '0', transport: 'container' };
      this.readyResolve?.();
      this.readyResolve = null;
      return;
    }
    this.dispatch(message);
  }

  private dispatch(message: Record<string, unknown>): void {
    const hasId = 'id' in message && message.id !== null && message.id !== undefined;
    if ('method' in message) {
      if (hasId) this.requestHandler?.({ id: Number(message.id), method: String(message.method), params: message.params });
      else this.notificationHandler?.(String(message.method), message.params);
      return;
    }
    if (!hasId) return;
    const slot = this.pending.get(Number(message.id));
    if (!slot) return;
    this.pending.delete(Number(message.id));
    if ('error' in message) {
      const error = message.error as { code: number; message: string; data?: unknown };
      slot.reject(new BridgeError(error.code, error.message, error.data));
    } else {
      slot.resolve(message.result);
    }
  }

  private fail(reason: string): void {
    if (this.failure !== null) return;
    this.failure = reason;
    this.readyResolve?.();
    this.readyResolve = null;
    for (const p of this.pending.values()) p.reject(new BridgeError(-32000, reason));
    this.pending.clear();
  }

  private async send(line: string): Promise<void> {
    if (this.failure !== null) throw new BridgeError(-32000, this.failure);
    if (!this.writer) throw new BridgeError(-32000, 'the engine in this tab has not started');
    await this.writer.write(encodeIn(line));
  }

  async call<T>(method: string, params?: unknown): Promise<T> {
    if (this.failure !== null) throw new BridgeError(-32000, this.failure);
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    try {
      await this.send(JSON.stringify(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params }));
    } catch (err) {
      this.pending.delete(id);
      throw err;
    }
    return (await result) as T;
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.send(JSON.stringify(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }));
  }

  answer(id: number, result: unknown): Promise<void> {
    return this.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  refuse(id: number, message: string): Promise<void> {
    return this.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }));
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  onRequest(handler: (request: ReverseRequest) => void): void {
    this.requestHandler = handler;
  }

  /**
   * The sidecar sees real absolute paths inside the container, and that is
   * what travels over JSON-RPC. `wc.fs` from the page resolves against the
   * workdir instead, so an absolute path handed to it comes out doubled --
   * the first upload wrote to `/home/<wd>/home/<wd>/course/...` and failed.
   * Everything crossing `wc.fs` goes through here first.
   */
  private local(path: string): string {
    const root = `${this.wc.workdir}/`;
    return path.startsWith(root) ? path.slice(root.length) : path.replace(/^\//, '');
  }

  async readFile(root: string, relPath: string): Promise<Uint8Array | null> {
    const path = relPath ? `${root.replace(/\/$/, '')}/${relPath}` : root;
    try {
      return await this.wc.fs.readFile(this.local(path));
    } catch {
      return null;
    }
  }

  /** Puts one uploaded file in the course folder. Bytes go straight to the container's filesystem, never through JSON-RPC. */
  async writeCourseFile(name: string, bytes: Uint8Array): Promise<void> {
    const dir = this.local(this.courseRoot());
    const slash = name.lastIndexOf('/');
    if (slash > 0) await this.wc.fs.mkdir(`${dir}/${name.slice(0, slash)}`, { recursive: true });
    await this.wc.fs.writeFile(`${dir}/${name}`, bytes);
  }

  /** What is in the course folder now, for the page's own listing before any agent exists. */
  async listCourseFiles(): Promise<string[]> {
    try {
      return (await this.wc.fs.readdir(this.local(this.courseRoot()))).filter((n) => !n.startsWith('.'));
    } catch {
      return [];
    }
  }

  /** EngineHost: only the Claude tier needs anything fetched before it can run. */
  async prepareProvider(providerId: string, onProgress: Progress = () => {}): Promise<void> {
    if (/claude/i.test(providerId)) await this.installClaudeJs(onProgress);
  }

  /**
   * `claude setup-token`, as a process in the container, with its console
   * relayed. It prints a URL to authorise on claude.ai and waits for the code
   * that comes back; the page shows both sides rather than reimplementing a
   * flow it does not own.
   */
  signIn(onOutput: (text: string) => void): { write(line: string): void; cancel(): void; done: Promise<number> } | null {
    const cli = `${this.wc.workdir}/claude-js/node_modules/@anthropic-ai/claude-code/cli.js`;
    let writer: WritableStreamDefaultWriter<string> | null = null;
    let child: WebContainerProcess | null = null;
    const queue: string[] = [];
    const done = (async () => {
      const proc = await this.wc.spawn('node', [cli, 'setup-token'], { env: { HOME: `${this.wc.workdir}/home` }, terminal: { cols: 400, rows: 40 } });
      child = proc;
      writer = proc.input.getWriter();
      for (const line of queue.splice(0)) void writer.write(`${line}\n`);
      void proc.output.pipeTo(new WritableStream({ write: (chunk: string) => onOutput(chunk) }));
      return proc.exit;
    })();
    return {
      write(line) {
        if (writer) void writer.write(`${line}\n`);
        else queue.push(line);
      },
      cancel() {
        child?.kill();
      },
      done,
    };
  }

  /**
   * Installs the pinned JavaScript Claude Code the adapters are pointed at.
   * Separate from start() because it is ~18 MB and only the Claude tier needs
   * it: the page calls this when the user picks that agent.
   */
  async installClaudeJs(onProgress: Progress = () => {}): Promise<void> {
    const cli = `${this.wc.workdir}/claude-js/node_modules/@anthropic-ai/claude-code/cli.js`;
    if ((await this.readFile(cli, '')) !== null) return; // already fetched into this container
    onProgress(`installing Claude Code ${CLAUDE_JS_VERSION} in this tab`);
    const proc = await this.wc.spawn('npm', ['install', '--prefix', 'claude-js', '--no-audit', '--no-fund', '--omit', 'optional', `@anthropic-ai/claude-code@${CLAUDE_JS_VERSION}`]);
    let tail = '';
    void proc.output.pipeTo(new WritableStream({ write: (c: string) => { tail = (tail + c).slice(-600); } }));
    const code = await proc.exit;
    if (code !== 0) throw new BridgeError(-32000, `could not install Claude Code in this tab (npm exited ${code}): ${plain(tail).slice(-200)}`);
  }

  close(): void {
    this.fail('the engine in this tab was stopped');
    this.process?.kill();
    this.process = null;
  }
}

/** npm draws spinners; strip escape sequences and control characters before putting a line in front of anyone. */
function plain(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}
