// Writes the updater feed (latest.json) for a release from the signatures
// its build jobs uploaded, and prints it on stdout.
//
//   node .github/release/updater-feed.mjs <tag> <owner/repo> > latest.json
//
// tauri-action can write this feed itself, but each of the four build jobs
// then downloads the release's latest.json, adds its own platform and puts
// the file back. Two jobs finishing together both delete the same asset and
// the second delete is a 404: v0.1.2 and v0.1.8 each lost platforms that way.
// So the build jobs only upload bundles and their .sig files, and this runs
// once, after all of them, and owns the whole file.
//
// The shape is tauri-action v0.6.2's (upload-version-json.ts), so nothing an
// installed app reads changes: `<os>-<arch>` for the updater to find itself
// by, `<os>-<arch>-<bundle>` for every signed bundle, each signature being
// the .sig file's text as it is, each url the asset's download link. Where a
// platform has two signed bundles (Linux: AppImage and deb) the plain key
// takes the one tauri-action prefers, the AppImage.
//
// A .sig this cannot place is an error, not a guess. Building a new kind of
// bundle means teaching it here, not a feed that quietly lacks it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [tag, repo] = process.argv.slice(2);
if (!tag || !repo) {
  console.error('usage: updater-feed.mjs <tag> <owner/repo>');
  process.exit(2);
}

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

// The version the app was built as, from the source at this tag -- not the
// tag with its "v" dropped, which would make verify's version check a
// tautology.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { version } = JSON.parse(readFileSync(join(root, 'app/src-tauri/tauri.conf.json'), 'utf8'));

// tauri-action's notes are its releaseBody, which is what the release was
// created with.
const release = JSON.parse(gh('release', 'view', tag, '--repo', repo, '--json', 'body,assets'));
const urls = new Map(release.assets.map((a) => [a.name, a.url]));

// Bundle by file ending, as the Tauri CLI names them. Arch by the token in
// the name, spelled the way the updater spells it.
const kinds = [
  { end: '.app.tar.gz', os: 'darwin', bundle: 'app' },
  { end: '.AppImage', os: 'linux', bundle: 'appimage' },
  { end: '.deb', os: 'linux', bundle: 'deb' },
  { end: '-setup.exe', os: 'windows', bundle: 'nsis' },
];
const arches = { aarch64: 'aarch64', arm64: 'aarch64', x86_64: 'x86_64', x64: 'x86_64', amd64: 'x86_64' };
// tauri-action's order for the plain key, with unzipped signatures and NSIS
// not preferred: AppImage first, then MSI, then the NSIS setup.
const priority = { appimage: 3, msi: 2, nsis: 1 };

const dir = mkdtempSync(join(tmpdir(), 'feed-'));
const entries = [];
try {
  gh('release', 'download', tag, '--repo', repo, '--pattern', '*.sig', '--dir', dir);
  for (const sig of readdirSync(dir).sort()) {
    const name = sig.slice(0, -'.sig'.length);
    const kind = kinds.find((k) => name.endsWith(k.end));
    const token = name.match(/[_.-](aarch64|arm64|x86_64|x64|amd64)(?=[_.-])/)?.[1];
    if (!kind || !token) throw new Error(`${sig}: no platform this script knows; teach it the bundle`);
    const url = urls.get(name);
    if (!url) throw new Error(`${sig} is on ${tag} but ${name}, the file it signs, is not`);
    entries.push({ os: kind.os, arch: arches[token], bundle: kind.bundle, signature: readFileSync(join(dir, sig), 'utf8'), url });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (entries.length === 0) throw new Error(`${tag} has no .sig assets; no build job signed anything`);

const platforms = {};
const groups = new Map();
for (const e of entries) {
  const key = `${e.os}-${e.arch}`;
  groups.set(key, [...(groups.get(key) ?? []), e]);
}
for (const key of [...groups.keys()].sort()) {
  const group = groups.get(key).sort((a, b) => (priority[b.bundle] ?? 0) - (priority[a.bundle] ?? 0));
  const [first, second] = group;
  if (second && (priority[first.bundle] ?? 0) === (priority[second.bundle] ?? 0)) {
    throw new Error(`${key}: ${first.bundle} and ${second.bundle} are equally good for the plain key; say which wins`);
  }
  platforms[key] = { signature: first.signature, url: first.url };
  for (const e of group.sort((a, b) => a.bundle.localeCompare(b.bundle))) {
    const k = `${key}-${e.bundle}`;
    if (platforms[k]) throw new Error(`${k}: two signed bundles`);
    platforms[k] = { signature: e.signature, url: e.url };
  }
}

const feed = { version, notes: release.body, pub_date: new Date().toISOString(), platforms };
process.stdout.write(JSON.stringify(feed, null, 2));
console.error(`latest.json for ${version}: ${Object.keys(platforms).join(', ')}`);
