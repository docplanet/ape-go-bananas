// File methods over the course folder -- docs/research/course-protocol.md.
// The app builds a stage's prompt from these without the webview touching
// the filesystem, and nothing here interprets what it reads. The one write,
// course/write, exists so the page can put what it extracted from a PDF
// beside the PDF; it is confined to the folder the same way course/read is.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { InvalidParams, type MethodHandler } from './methods.js';

const ARTIFACTS = ['inventory.md', 'plan.md', 'deck.json', 'flags.json', 'review.html'] as const;
// Where the page puts what it extracted from a source file: text.md and one
// image per page under `_extracted/<relPath of the source>/`. Not material,
// so not listed as files; reported as `extracted` instead.
const EXTRACTED = '_extracted';
const PAGE_IMAGE = /^p\d+\.(png|jpe?g|webp)$/i;

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
    if (dir === root && entry.name === EXTRACTED) continue;
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

/** For each listed file, what `_extracted/<relPath>/` holds: the text, the page images. Source order. */
function extractedFor(root: string, files: { relPath: string }[]): { source: string; text: string | null; images: string[] }[] {
  const out: { source: string; text: string | null; images: string[] }[] = [];
  for (const f of files) {
    const dir = join(root, EXTRACTED, ...f.relPath.split('/'));
    if (!isDirectory(dir)) continue;
    const names = readdirSync(dir).sort();
    const at = (n: string) => `${EXTRACTED}/${f.relPath}/${n}`;
    const text = names.includes('text.md') && statSync(join(dir, 'text.md')).isFile() ? at('text.md') : null;
    const images = names.filter((n) => PAGE_IMAGE.test(n)).map(at);
    if (text !== null || images.length > 0) out.push({ source: f.relPath, text, images });
  }
  return out;
}

/** `name` resolved beneath `path`, or -32602 when it is the folder itself or climbs out of it. */
function within(path: string, name: string): string {
  const root = resolve(path);
  const full = resolve(root, name);
  if (full === root || !full.startsWith(root + sep)) throw new InvalidParams(`params.name: "${name}" escapes the course folder`);
  return full;
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
        extracted: extractedFor(path, files),
      };
    },

    'course/write': (raw) => {
      const p = asParams(raw);
      const path = str(p, 'path');
      const name = str(p, 'name');
      if (!isDirectory(path)) throw new Error(`${path} is not a directory`);
      const full = within(path, name);
      const hasText = typeof p.text === 'string';
      const hasBase64 = typeof p.base64 === 'string';
      if (hasText === hasBase64) throw new InvalidParams('params: exactly one of `text` (UTF-8) or `base64` (bytes) must be given');
      const data = hasText ? Buffer.from(p.text as string, 'utf8') : Buffer.from(p.base64 as string, 'base64');
      if (existsSync(full) && !statSync(full).isFile()) throw new InvalidParams(`params.name: "${name}" is not a regular file`);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, data);
      return { name, bytes: data.length };
    },

    'course/read': (raw) => {
      const p = asParams(raw);
      const path = str(p, 'path');
      const name = str(p, 'name');
      if (!isDirectory(path)) throw new Error(`${path} is not a directory`);
      const full = within(path, name);
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
