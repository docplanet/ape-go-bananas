// Read-only file methods -- docs/research/course-protocol.md. The app builds
// a stage's prompt from these without the webview touching the filesystem,
// and nothing here interprets what it reads.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { InvalidParams, type MethodHandler } from './methods.js';

const ARTIFACTS = ['inventory.md', 'plan.md', 'deck.json', 'flags.json', 'review.html'] as const;

const KINDS: Record<string, { kind: string; mime: string }> = {
  pdf: { kind: 'pdf', mime: 'application/pdf' },
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  aac: { kind: 'audio', mime: 'audio/aac' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  flac: { kind: 'audio', mime: 'audio/flac' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  webm: { kind: 'video', mime: 'video/webm' },
  mkv: { kind: 'video', mime: 'video/x-matroska' },
  md: { kind: 'text', mime: 'text/markdown' },
  txt: { kind: 'text', mime: 'text/plain' },
  vtt: { kind: 'text', mime: 'text/vtt' },
  srt: { kind: 'text', mime: 'application/x-subrip' },
  csv: { kind: 'text', mime: 'text/csv' },
  json: { kind: 'text', mime: 'application/json' },
  html: { kind: 'text', mime: 'text/html' },
  pptx: { kind: 'slides', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  ppt: { kind: 'slides', mime: 'application/vnd.ms-powerpoint' },
  key: { kind: 'slides', mime: 'application/vnd.apple.keynote' },
  odp: { kind: 'slides', mime: 'application/vnd.oasis.opendocument.presentation' },
  docx: { kind: 'doc', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  doc: { kind: 'doc', mime: 'application/msword' },
  pages: { kind: 'doc', mime: 'application/vnd.apple.pages' },
  rtf: { kind: 'doc', mime: 'application/rtf' },
};

function classify(name: string): { kind: string; mimeType: string } {
  const ext = extname(name).slice(1).toLowerCase();
  const k = KINDS[ext];
  return k ? { kind: k.kind, mimeType: k.mime } : { kind: 'other', mimeType: 'application/octet-stream' };
}

function str(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== 'string' || v.length === 0) throw new InvalidParams(`params.${key} must be a non-empty string`);
  return v;
}

function asParams(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidParams('params must be an object');
  return raw as Record<string, unknown>;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function methodDir(): string {
  const dir = process.env.APE_METHOD_DIR;
  if (!dir || !isDirectory(dir)) throw new Error('APE_METHOD_DIR is not set or not a directory');
  return dir;
}

function titleOf(text: string, name: string): string {
  for (const line of text.split('\n')) {
    if (line.startsWith('# ')) return line.slice(2).trim();
  }
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    const front = end === -1 ? text : text.slice(0, end);
    const m = /^name:\s*(.+)$/m.exec(front);
    if (m) return m[1]!.trim().replace(/^["']|["']$/g, '');
  }
  return name.replace(/\.md$/, '');
}

/** A bare file name only: no separators, no traversal. */
function bareName(name: string, field: string): string {
  if (name.includes('/') || name.includes('\\') || name === '..' || name === '.' || name.includes('\0')) {
    throw new InvalidParams(`params.${field} must be a bare file name`);
  }
  return name;
}

function listFiles(root: string, dir: string, out: { name: string; relPath: string; bytes: number; kind: string; mimeType: string }[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listFiles(root, full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = relative(root, full).split(sep).join('/');
    if (dir === root && ((ARTIFACTS as readonly string[]).includes(entry.name) || entry.name.toLowerCase().endsWith('.apkg'))) continue;
    if (entry.name.toLowerCase().endsWith('.apkg')) continue;
    out.push({ name: entry.name, relPath: rel, bytes: statSync(full).size, ...classify(entry.name) });
  }
}

export function courseMethods(): Record<string, MethodHandler> {
  return {
    'method/list': () => {
      const dir = methodDir();
      const files = readdirSync(dir)
        .filter((f) => f.endsWith('.md') && statSync(join(dir, f)).isFile())
        .sort()
        .map((name) => {
          const text = readFileSync(join(dir, name), 'utf8');
          return { name, title: titleOf(text, name), bytes: Buffer.byteLength(text) };
        });
      return { dir, files };
    },

    'method/read': (raw) => {
      const name = bareName(str(asParams(raw), 'name'), 'name');
      const dir = methodDir();
      const full = join(dir, name);
      if (!name.endsWith('.md') || !existsSync(full) || !statSync(full).isFile()) throw new InvalidParams(`params.name: no method file "${name}"`);
      return { name, text: readFileSync(full, 'utf8') };
    },

    'course/list': (raw) => {
      const path = str(asParams(raw), 'path');
      if (!isDirectory(path)) throw new Error(`${path} is not a directory`);
      const files: { name: string; relPath: string; bytes: number; kind: string; mimeType: string }[] = [];
      listFiles(path, path, files);
      files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
      const has = (f: string) => {
        try {
          return statSync(join(path, f)).isFile();
        } catch {
          return false;
        }
      };
      return {
        path,
        files,
        artifacts: { inventory: has('inventory.md'), plan: has('plan.md'), deck: has('deck.json'), flags: has('flags.json'), review: has('review.html') },
      };
    },

    'course/read': (raw) => {
      const p = asParams(raw);
      const path = str(p, 'path');
      const name = str(p, 'name');
      if (!isDirectory(path)) throw new Error(`${path} is not a directory`);
      const root = resolve(path);
      const full = resolve(root, name);
      if (full !== root && !full.startsWith(root + sep)) throw new InvalidParams(`params.name: "${name}" escapes the course folder`);
      let st;
      try {
        st = statSync(full);
      } catch {
        throw new InvalidParams(`params.name: no file "${name}"`);
      }
      if (!st.isFile()) throw new InvalidParams(`params.name: "${name}" is not a regular file`);
      if (classify(basename(full)).kind !== 'text') throw new InvalidParams(`params.name: "${name}" is not a text file`);
      const text = readFileSync(full, 'utf8');
      return { name, text, bytes: st.size };
    },
  };
}
