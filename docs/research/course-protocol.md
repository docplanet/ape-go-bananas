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
{ path, files: File[], artifacts: { inventory: boolean, plan: boolean, deck: boolean, flags: boolean, review: boolean }, extracted: Extracted[] }
```
`File` is `{ name, relPath, bytes, kind, mimeType }` for every regular
file under `path`, recursive, sorted by `relPath`, skipping entries whose
name starts with `.`, `node_modules`, the top-level `_extracted/` tree, and
the artifacts themselves (`inventory.md`, `plan.md`, `deck.json`,
`flags.json`, `review.html`, `*.apkg`). `kind` by extension: `pdf`; `image` (png jpg jpeg gif webp);
`audio` (mp3 m4a wav aac ogg flac); `video` (mp4 mov webm mkv); `text` (md
txt vtt srt csv json html); `slides` (pptx ppt key odp); `doc` (docx doc
pages rtf); else `other`. `mimeType` is the usual one for the extension,
`application/octet-stream` when unknown. `artifacts` reports which of
`inventory.md`, `plan.md`, `deck.json`, `flags.json`, `review.html` exist
directly in `path`. A `path` that is not a directory → `-32000`.

`extracted` is what the page put beside a source file under
`_extracted/<relPath of the source>/`: for each listed file whose directory
there exists, `{ source, text, images }` — `source` the file's `relPath`,
`text` the relPath of `text.md` when present (else `null`), `images` the
relPaths of `pNNN.png|jpg|jpeg|webp` sorted by name. In `files` order; a
directory for nothing listed, or with neither text nor images, is omitted.

### `course/read`
params `{ path, name, encoding? }` → `{ name, text, bytes }` — reads a UTF-8
text file whose `name` is relative to `path`, refused (`-32602`) if it
escapes `path` or is not a regular file; only for files whose `kind` would
be `text` (else `-32602` `"…is not a text file"`). Binary attachments do not
pass through this on their way to the agent: the app hands them over as
`resource_link` blocks, and the agent (or the embedded loop) reads them
itself.

With `encoding: "base64"` → `{ name, base64, bytes }`: the file's bytes, any
kind, same confinement. This is how the desktop app's webview gets a PDF to
its own reader (it reaches the filesystem only through the sidecar); the
bridge serves the same bytes over `/file`. Any other `encoding` → `-32602`.

### `course/write`
params `{ path, name, text }` or `{ path, name, base64 }` → `{ name, bytes }`
— writes one file at `name` relative to `path`, creating directories,
replacing what is there. Exactly one of `text` (UTF-8) or `base64` (bytes),
else `-32602`; `name` that is `path` itself, escapes it, or names a
directory → `-32602` naming `name`; `path` not a directory → `-32000`. The
page uses it for `_extracted/…` (text and page images from a PDF, rendered
in the tab); nothing else writes through it today.

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
- `course/write` text and base64 into `_extracted/lecture.pdf/`, bytes
  round-tripping exactly; then `course/list` reports the entry (images
  sorted, `text` null until written) and still lists the same `files`; a
  nested source keeps its path; an extracted dir for nothing listed is
  ignored; overwrite allowed. Refused: `../outside.md`, an absolute name,
  `.`, a directory, both bodies, neither body, missing params, a file for
  `path` — and nothing outside is touched by a refused call.
