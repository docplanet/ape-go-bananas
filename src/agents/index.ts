// Provider management -- docs/research/agent-protocol.md §1. Copies Zed's
// mechanism (docs/research/agent-install-and-auth.md §4): read the public
// ACP registry, install an entry's npm package into a per-agent prefix under
// the app's data directory with the sidecar's own Node, and spawn it from
// there. Nothing here knows what an agent says; it only puts one on disk.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const DEFAULT_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const REGISTRY_MAX_AGE_MS = 60 * 60 * 1000;

export type Distribution = 'npx' | 'binary' | 'uvx';

export interface Provider {
  id: string;
  kind: 'acp' | 'api';
  name: string;
  description: string;
  version: string | null;
  installed: boolean;
  installedVersion: string | null;
  distribution: Distribution | null;
  installable: boolean;
}

/** One registry entry, kept whole so `agent/connect` can read its npx args/env. */
export interface RegistryEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  distribution: Distribution;
  npx?: { package: string; args: string[]; env: Record<string, string> };
}

export interface RegistryState {
  fetchedAt: string | null;
  url: string;
  error: string | null;
  entries: RegistryEntry[];
}

export const BUILT_IN_PROVIDERS: Provider[] = [
  {
    id: 'openrouter',
    kind: 'api',
    name: 'OpenRouter',
    description: 'Any model, one API key',
    version: null,
    installed: true,
    installedVersion: null,
    distribution: null,
    installable: false,
  },
];

export function isBuiltIn(id: string): boolean {
  return BUILT_IN_PROVIDERS.some((p) => p.id === id);
}

interface RegistryCache {
  fetchedAt: string;
  url: string;
  entries: RegistryEntry[];
}

function cachePath(dataDir: string): string {
  return join(dataDir, 'registry.json');
}

/** Strict mapping per §1: an entry without id/name/distribution is skipped, and only the one distribution key present is recorded. */
function parseRegistry(raw: unknown): RegistryEntry[] {
  const list = Array.isArray(raw) ? raw : (raw as { agents?: unknown })?.agents;
  if (!Array.isArray(list)) return [];
  const entries: RegistryEntry[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as Record<string, unknown>;
    const dist = e.distribution;
    if (typeof e.id !== 'string' || typeof e.name !== 'string' || typeof dist !== 'object' || dist === null) continue;
    const kind = (['npx', 'binary', 'uvx'] as const).find((k) => k in (dist as object));
    if (kind === undefined) continue;
    const entry: RegistryEntry = {
      id: e.id,
      name: e.name,
      description: typeof e.description === 'string' ? e.description : '',
      version: typeof e.version === 'string' ? e.version : '',
      distribution: kind,
    };
    if (kind === 'npx') {
      const npx = (dist as { npx: Record<string, unknown> }).npx;
      if (typeof npx?.package !== 'string') continue;
      entry.npx = {
        package: npx.package,
        args: Array.isArray(npx.args) ? npx.args.filter((a): a is string => typeof a === 'string') : [],
        env: typeof npx.env === 'object' && npx.env !== null ? (npx.env as Record<string, string>) : {},
      };
    }
    entries.push(entry);
  }
  return entries;
}

function readCache(dataDir: string): RegistryCache | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(dataDir), 'utf8')) as Partial<RegistryCache>;
    if (typeof parsed.fetchedAt !== 'string' || !Array.isArray(parsed.entries)) return null;
    return { fetchedAt: parsed.fetchedAt, url: typeof parsed.url === 'string' ? parsed.url : '', entries: parsed.entries as RegistryEntry[] };
  } catch {
    return null;
  }
}

export async function loadRegistry(
  dataDir: string,
  opts: { registryUrl?: string; refresh?: boolean; fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<RegistryState> {
  const now = opts.now ?? Date.now;
  const cached = readCache(dataDir);
  // A call that names no URL means "the registry this data dir already
  // uses" -- agents/install carries none (§1) and must find the entries
  // agents/list just cached, whichever registry they came from.
  const url = opts.registryUrl ?? (cached?.url || DEFAULT_REGISTRY_URL);
  const fresh = cached !== null && cached.url === url && now() - Date.parse(cached.fetchedAt) < REGISTRY_MAX_AGE_MS;
  if (fresh && !opts.refresh) {
    return { fetchedAt: cached.fetchedAt, url, error: null, entries: cached.entries };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`registry ${url} answered HTTP ${res.status}`);
    const entries = parseRegistry(await res.json());
    const fetchedAt = new Date(now()).toISOString();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(cachePath(dataDir), `${JSON.stringify({ fetchedAt, url, entries } satisfies RegistryCache, null, 2)}\n`);
    return { fetchedAt, url, error: null, entries };
  } catch (err) {
    const error = (err as Error).message;
    if (cached !== null) return { fetchedAt: cached.fetchedAt, url, error, entries: cached.entries };
    return { fetchedAt: null, url, error, entries: [] };
  }
}

// ---- on-disk layout -------------------------------------------------------

export function prefixFor(dataDir: string, id: string): string {
  return join(dataDir, 'npx', id);
}

/** The name npm installs a package under: `@scope/name@1.2.3` -> `@scope/name`. */
export function packageName(spec: string): string {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

function readInstalledPackageJson(dataDir: string, entry: RegistryEntry): { dir: string; json: Record<string, unknown> } | null {
  if (entry.npx === undefined) return null;
  const dir = join(prefixFor(dataDir, entry.id), 'node_modules', packageName(entry.npx.package));
  try {
    return { dir, json: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown> };
  } catch {
    return null;
  }
}

export function installedVersion(dataDir: string, entry: RegistryEntry): string | null {
  const pkg = readInstalledPackageJson(dataDir, entry);
  return pkg !== null && typeof pkg.json.version === 'string' ? pkg.json.version : null;
}

/** §1 agents/install: the sole `bin` entry, or the one named after the package's unscoped name. */
export function resolveBin(dataDir: string, entry: RegistryEntry): string | null {
  const pkg = readInstalledPackageJson(dataDir, entry);
  if (pkg === null) return null;
  const bin = pkg.json.bin;
  const unscoped = basename(packageName(entry.npx!.package));
  let rel: string | undefined;
  if (typeof bin === 'string') rel = bin;
  else if (typeof bin === 'object' && bin !== null) {
    const entries = Object.entries(bin as Record<string, string>);
    rel = entries.length === 1 ? entries[0]![1] : (bin as Record<string, string>)[unscoped];
  }
  return rel === undefined ? null : resolve(pkg.dir, rel);
}

export function toProvider(dataDir: string, entry: RegistryEntry): Provider {
  const version = installedVersion(dataDir, entry);
  return {
    id: entry.id,
    kind: 'acp',
    name: entry.name,
    description: entry.description,
    version: entry.version || null,
    installed: version !== null,
    installedVersion: version,
    distribution: entry.distribution,
    installable: entry.distribution === 'npx',
  };
}

// ---- npm ------------------------------------------------------------------

/** §1: APE_NPM_CLI, else the npm-cli.js beside this Node, else `npm` on PATH. Returns argv[0..] to prepend to npm's own args. */
export function npmCommand(): { command: string; args: string[] } {
  const override = process.env.APE_NPM_CLI;
  if (override) return { command: process.execPath, args: [override] };
  const beside = join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(beside)) return { command: process.execPath, args: [beside] };
  return { command: 'npm', args: [] };
}

export interface InstallResult {
  id: string;
  package: string;
  version: string;
  bin: string;
}

export function installAgent(
  dataDir: string,
  entry: RegistryEntry,
  opts: { registry?: string; onProgress?: (stream: 'stdout' | 'stderr', line: string) => void } = {},
): Promise<InstallResult> {
  if (entry.npx === undefined) return Promise.reject(new RangeError(`${entry.id}: distribution is ${entry.distribution}, only npx entries can be installed`));
  const prefix = prefixFor(dataDir, entry.id);
  mkdirSync(prefix, { recursive: true });
  const spec = entry.npx.package.includes('@', 1) || entry.version === '' ? entry.npx.package : `${entry.npx.package}@${entry.version}`;
  const npm = npmCommand();
  const args = [...npm.args, 'install', '--prefix', prefix, '--save-exact', '--no-audit', '--no-fund', '--no-package-lock'];
  const registry = opts.registry ?? process.env.APE_NPM_REGISTRY;
  if (registry) args.push('--registry', registry);
  args.push(spec);

  return new Promise<InstallResult>((resolvePromise, reject) => {
    const child = spawn(npm.command, args, { cwd: prefix, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, npm_config_update_notifier: 'false' } });
    let lastErr = '';
    const pump = (stream: 'stdout' | 'stderr') => {
      let buf = '';
      child[stream]!.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let i: number;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line.trim() === '') continue;
          if (stream === 'stderr') lastErr = line;
          opts.onProgress?.(stream, line);
        }
      });
      child[stream]!.on('end', () => {
        if (buf.trim() !== '') opts.onProgress?.(stream, buf);
        if (stream === 'stderr' && buf.trim() !== '') lastErr = buf.trim();
      });
    };
    pump('stdout');
    pump('stderr');
    child.on('error', (err) => reject(new Error(`npm failed to start: ${err.message}`)));
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`npm install ${spec} exited ${code}${lastErr ? `: ${lastErr}` : ''}`));
        return;
      }
      const version = installedVersion(dataDir, entry);
      const bin = resolveBin(dataDir, entry);
      if (version === null || bin === null) {
        reject(new Error(`npm install ${spec} finished but ${packageName(entry.npx!.package)} has no package.json/bin under ${prefix}`));
        return;
      }
      resolvePromise({ id: entry.id, package: packageName(entry.npx!.package), version, bin });
    });
  });
}

export function uninstallAgent(dataDir: string, id: string): boolean {
  const prefix = prefixFor(dataDir, id);
  try {
    if (!statSync(prefix).isDirectory()) return false;
  } catch {
    return false;
  }
  rmSync(prefix, { recursive: true, force: true });
  return true;
}
