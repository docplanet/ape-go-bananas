// Stages everything `tauri build` bundles besides the Rust binary
// (docs/research/tauri-packaging.md §9):
//   src-tauri/binaries/node-<triple>   the official nodejs.org binary, an externalBin
//                                      (re-signed by tauri build on macOS)
//   src-tauri/resources/npm/           npm from the same distribution, as JS
//   src-tauri/resources/engine/        the engine's dist/ (sidecar + checks + apkg + acp)
//   src-tauri/resources/method/        the method files, prose, unmodified
// Idempotent; skips a download whose checksum already verified.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = process.env.APE_NODE_VERSION ?? 'v24.12.0';
const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const engineDir = resolve(appDir, '..');
const tauriDir = join(appDir, 'src-tauri');
const methodDir = process.env.APE_METHOD_DIR ?? resolve(engineDir, '..', 'Anki', 'method');

const triple = process.env.APE_TARGET_TRIPLE ?? execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();
const [arch, os] = (() => {
  const a = triple.startsWith('aarch64') ? 'arm64' : 'x64';
  if (triple.includes('apple-darwin')) return [a, 'darwin'];
  if (triple.includes('windows')) return [a, 'win'];
  return [a, 'linux'];
})();
const ext = os === 'win' ? 'zip' : 'tar.gz';
const distName = `node-${NODE_VERSION}-${os}-${arch}`;
const archive = `${distName}.${ext}`;
const base = `https://nodejs.org/dist/${NODE_VERSION}`;

const binDest = join(tauriDir, 'binaries', `node-${triple}${os === 'win' ? '.exe' : ''}`);
const npmDest = join(tauriDir, 'resources', 'npm');

async function fetchNode() {
  if (existsSync(binDest) && existsSync(join(npmDest, 'bin', 'npm-cli.js'))) {
    console.log(`node ${NODE_VERSION} already staged`);
    return;
  }
  const work = join(tmpdir(), `ape-node-${NODE_VERSION}`);
  mkdirSync(work, { recursive: true });
  const archivePath = join(work, archive);
  console.log(`downloading ${base}/${archive}`);
  const bytes = Buffer.from(await (await fetch(`${base}/${archive}`)).arrayBuffer());
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sums.split('\n').find((l) => l.endsWith(archive))?.split(/\s+/)[0];
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (!expected || expected !== actual) throw new Error(`checksum mismatch for ${archive}: expected ${expected}, got ${actual}`);
  writeFileSync(archivePath, bytes);
  console.log(`verified sha256 ${actual.slice(0, 12)}…`);
  rmSync(join(work, distName), { recursive: true, force: true });
  if (ext === 'zip') execFileSync('unzip', ['-q', '-o', archivePath, '-d', work]);
  else execFileSync('tar', ['-xzf', archivePath, '-C', work]);
  const extracted = join(work, distName);
  mkdirSync(dirname(binDest), { recursive: true });
  cpSync(join(extracted, os === 'win' ? 'node.exe' : 'bin/node'), binDest);
  chmodSync(binDest, 0o755);
  rmSync(npmDest, { recursive: true, force: true });
  cpSync(join(extracted, os === 'win' ? 'node_modules/npm' : 'lib/node_modules/npm'), npmDest, { recursive: true });
  console.log(`staged ${binDest} (${(statSync(binDest).size / 1e6).toFixed(0)} MB) and ${npmDest}`);
}

function stageEngine() {
  const dist = join(engineDir, 'dist');
  if (!existsSync(join(dist, 'sidecar', 'index.js'))) throw new Error(`${dist} has no sidecar; run \`npm run build\` in ${engineDir} first`);
  const dest = join(tauriDir, 'resources', 'engine');
  rmSync(dest, { recursive: true, force: true });
  cpSync(dist, dest, { recursive: true, filter: (src) => !src.endsWith('.d.ts') && !src.endsWith('.map') });
  cpSync(join(engineDir, 'package.json'), join(tauriDir, 'resources', 'package.json'));
  console.log(`staged engine -> ${dest}`);
}

function stageMethod() {
  const dest = join(tauriDir, 'resources', 'method');
  rmSync(dest, { recursive: true, force: true });
  if (!existsSync(methodDir)) {
    console.log(`method dir ${methodDir} not found; set APE_METHOD_DIR (skipping)`);
    mkdirSync(dest, { recursive: true });
    return;
  }
  mkdirSync(dest, { recursive: true });
  // read+write rather than cpSync: the method files are relative symlinks
  // into the skills tree, and cpSync's dereference misreads them as dirs.
  for (const f of readdirSync(methodDir).filter((f) => f.endsWith('.md'))) writeFileSync(join(dest, f), readFileSync(join(methodDir, f)));
  console.log(`staged method files from ${methodDir} -> ${dest}`);
}

await fetchNode();
stageEngine();
stageMethod();
