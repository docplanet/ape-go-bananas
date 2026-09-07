// The three tools the embedded agent exposes -- read_file, write_file,
// list_dir (docs/research/agent-protocol.md §4) -- their JSON-schema
// definitions for the `tools` request field, and the one rule they share:
// every path resolves against the session cwd and anything that lands
// outside it (after resolve + realpath of the deepest existing ancestor,
// so a symlink cannot smuggle a path out) is refused with a text result,
// never an exception. Permission for write_file is the loop's concern
// (openrouter.ts), not this file's: this only knows how to read, write
// and list.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ToolKind } from '../acp/protocol.js';

export type ToolName = 'read_file' | 'write_file' | 'list_dir';

/** OpenAI-style function tool definition (openrouter-api.md §2.3). */
export interface ToolDefinition {
  type: 'function';
  function: { name: ToolName; description: string; parameters: object };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file inside the course folder. The path is relative to the course folder.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the course folder.' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a text file inside the course folder. Missing parent folders are created.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the course folder.' },
          content: { type: 'string', description: 'The full new contents of the file.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List one folder inside the course folder: one entry per line, folders suffixed with "/". Use "." for the course folder itself.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Folder path relative to the course folder.' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
];

/** ACP `kind` hint per tool (agent-protocol.md §4). */
export const TOOL_KINDS: Record<ToolName, ToolKind> = { read_file: 'read', write_file: 'edit', list_dir: 'search' };

const TOOL_VERBS: Record<ToolName, string> = { read_file: 'Read', write_file: 'Write', list_dir: 'List' };

export function isToolName(name: string): name is ToolName {
  return name === 'read_file' || name === 'write_file' || name === 'list_dir';
}

/** `Read notes/lecture-3.md`, `Write cards.tsv`, `List .` -- the `tool_call` title and the permission-prompt title. */
export function toolTitle(name: ToolName, relativePath: string): string {
  return `${TOOL_VERBS[name]} ${relativePath}`;
}

export interface ResolvedPath {
  /** Absolute path, realpath-normalised through the deepest existing ancestor. */
  abs: string;
  /** Path relative to cwd, `.` for cwd itself. */
  rel: string;
  /** False when the path escapes cwd. */
  inside: boolean;
}

/** Realpath of the deepest existing ancestor of `p`, with the non-existent tail re-joined. */
function realpathThroughExisting(p: string): string {
  let existing = p;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return p;
    tail.unshift(basename(existing));
    existing = parent;
  }
  let real: string;
  try {
    real = realpathSync(existing);
  } catch {
    real = existing;
  }
  return tail.length ? join(real, ...tail) : real;
}

/** Resolve a tool path against cwd and decide whether it stays inside the course folder. */
export function resolveInside(cwd: string, given: string): ResolvedPath {
  const cwdReal = realpathThroughExisting(resolve(cwd));
  const abs = realpathThroughExisting(resolve(cwd, given));
  const inside = abs === cwdReal || abs.startsWith(cwdReal.endsWith(sep) ? cwdReal : cwdReal + sep);
  const rel = inside ? relative(cwdReal, abs) || '.' : given;
  return { abs, rel, inside };
}

export function refusedText(given: string): string {
  return `Refused: ${given} is outside the course folder`;
}

export interface ToolResult {
  ok: boolean;
  text: string;
}

export function readFileTool(r: ResolvedPath): ToolResult {
  try {
    return { ok: true, text: readFileSync(r.abs, 'utf8') };
  } catch (e) {
    return { ok: false, text: `Could not read ${r.rel}: ${errorMessage(e)}` };
  }
}

export function writeFileTool(r: ResolvedPath, content: string): ToolResult {
  try {
    mkdirSync(dirname(r.abs), { recursive: true });
    writeFileSync(r.abs, content, 'utf8');
    return { ok: true, text: `Wrote ${r.rel} (${Buffer.byteLength(content, 'utf8')} bytes)` };
  } catch (e) {
    return { ok: false, text: `Could not write ${r.rel}: ${errorMessage(e)}` };
  }
}

/** One entry per line, sorted by name, directories suffixed with `/`. An empty folder yields an empty string. */
export function listDirTool(r: ResolvedPath): ToolResult {
  try {
    if (!statSync(r.abs).isDirectory()) return { ok: false, text: `Not a folder: ${r.rel}` };
    const entries = readdirSync(r.abs, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name));
    return { ok: true, text: entries.join('\n') };
  } catch (e) {
    return { ok: false, text: `Could not list ${r.rel}: ${errorMessage(e)}` };
  }
}

/** Absolute or relative -> path relative to cwd when it lies inside, else the absolute path (for attachment headings). */
export function displayPath(cwd: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  const rel = relative(resolve(cwd), abs);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
