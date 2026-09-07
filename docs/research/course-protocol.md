# Sidecar protocol, part 3: method files and the course folder

Extends `sidecar-protocol.md` (framing, lifecycle, errors unchanged). These
are read-only file methods so the app can build a stage's prompt without the
webview touching the filesystem. Nothing here interprets content.

## 1. Method files

The bundled method files live in the directory named by env `APE_METHOD_DIR`
(set by the app: the `method/` resource in a bundle, the method repo's
`method/` in dev). Missing or unreadable → `-32000` `"APE_METHOD_DIR is not
set or not a directory"` on either method.

### `method/list`
params none → `{ dir: string, files: [{ name, title, bytes }] }` — every
`*.md` directly in the directory, sorted by name. `title` is the text of
the first line starting `# `, else YAML frontmatter `name:` if the file
starts with `---`, else the file name without `.md`.

### `method/read`
params `{ name }` → `{ name, text }`. `name` must be a bare file name that
`method/list` would return (no `/`, no `..`); otherwise `-32602` naming
`name`. A name not present → `-32602`.

## 2. The course folder

### `course/list`
params `{ path }` (a directory) →
```
{ path, files: File[], artifacts: { inventory: boolean, plan: boolean, deck: boolean, flags: boolean, review: boolean } }
```
`File` is `{ name, relPath, bytes, kind, mimeType }` for every regular
file under `path`, recursive, sorted by `relPath`, skipping entries whose
name starts with `.`, `node_modules`, and the artifacts themselves
(`inventory.md`, `plan.md`, `deck.json`, `flags.json`, `review.html`,
`*.apkg`). `kind` by extension: `pdf`; `image` (png jpg jpeg gif webp);
`audio` (mp3 m4a wav aac ogg flac); `video` (mp4 mov webm mkv); `text` (md
txt vtt srt csv json html); `slides` (pptx ppt key odp); `doc` (docx doc
pages rtf); else `other`. `mimeType` is the usual one for the extension,
`application/octet-stream` when unknown. `artifacts` reports which of
`inventory.md`, `plan.md`, `deck.json`, `flags.json`, `review.html` exist
directly in `path`. A `path` that is not a directory → `-32000`.

### `course/read`
params `{ path, name }` → `{ name, text, bytes }` — reads a UTF-8 text file
whose `name` is relative to `path`, refused (`-32602`) if it escapes `path`
or is not a regular file; only for files whose `kind` would be `text` (else
`-32602` `"…is not a text file"`). Binary attachments never pass through
this: the app hands them to the agent as `resource_link` blocks, and the
agent (or the embedded loop) reads them itself.

## 3. What the oracle must prove

- `method/list`/`read` against a temp dir with three `.md` files (one with
  a `# ` title, one with frontmatter `name:`, one with neither), sorted;
  `read` returns exact text; `../x.md`, `a/b.md`, unknown name → `-32602`;
  unset `APE_METHOD_DIR` → `-32000`.
- `course/list` against a temp tree with nested files of several kinds, a
  dotfile, a `node_modules` dir, and the artifacts present/absent; exact
  `files` and `artifacts`; a file path instead of a dir → `-32000`.
- `course/read` for `notes.md` (exact text), for a nested `sub/a.txt`, for
  `../outside.md` → `-32602`, for `slide.png` → `-32602`.
