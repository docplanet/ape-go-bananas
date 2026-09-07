# Tauri 2 + bundled Node sidecar: packaging and distribution

Read 2026-09-07:

- https://v2.tauri.app/develop/sidecar/
- https://v2.tauri.app/learn/sidecar-nodejs/
- https://v2.tauri.app/develop/resources/
- https://v2.tauri.app/reference/config/
- https://v2.tauri.app/distribute/sign/macos/
- https://v2.tauri.app/distribute/sign/windows/
- https://v2.tauri.app/distribute/windows-installer/
- https://v2.tauri.app/plugin/updater/
- https://v2.tauri.app/distribute/pipelines/github/
- https://github.com/tauri-apps/tauri-action (README)
- https://github.com/tauri-apps/tauri/issues/11992 (+ comments)
- tauri source: crates/tauri-bundler/src/bundle/macos/{app.rs,sign.rs}, crates/tauri-macos-sign/src/keychain.rs; plugins-workspace/plugins/shell/src/process/mod.rs
- https://docs.rs/tauri/latest/tauri/path/struct.PathResolver.html, https://docs.rs/tauri/latest/tauri/process/index.html
- https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html, https://nodejs.org/api/sqlite.html
- https://nodejs.org/dist/latest-v24.x/ (+ win-x64/), https://yao-pkg.github.io/pkg/ (+ guide/sea-vs-standard)
- https://support.apple.com/en-us/102445, https://developer.apple.com/programs/
- Local checks on this Mac (macOS 26.6.2, rustc 1.92, host `aarch64-apple-darwin`): nvm Node v24.12.0 and v20.18.1 binaries.

"Unverified" below = not found in the pages read; do not build on it without checking.

## 1. `bundle.externalBin` (sidecars)

Config (paths relative to `src-tauri/`):

```json
{ "bundle": { "externalBin": ["binaries/node"] } }
```

- Filename convention: the config names `binaries/node`; the file on disk must be `binaries/node-<target-triple>[.exe]`. Config reference: Tauri looks for `binary-name{-target-triple}{.system-extension}`. Examples: `binaries/node-aarch64-apple-darwin`, `binaries/node-x86_64-apple-darwin`, `binaries/node-x86_64-pc-windows-msvc.exe`, `binaries/node-x86_64-unknown-linux-gnu`. Get the triple with `rustc --print host-tuple` (Rust >= 1.84).
- Any executable qualifies: the guide says binaries are "executables written in any programming language". Nothing requires them to be built by you, so the official Node download is acceptable as an externalBin. (Local check: nvm's v24.12.0 `bin/node` is a plain Mach-O arm64 executable, 117,655,968 bytes.)
- Where it lands: macOS `Contents/MacOS/` (bundler `app.rs`: `bin_dir = bundle_directory.join("MacOS")`, `settings.copy_binaries(&bin_dir)`). Windows/Linux: next to the main executable (the shell plugin resolves it relative to the exe; see below). The triple suffix is stripped in the bundle, so the file is `Contents/MacOS/node`.
- Rust-side resolution: `tauri::process` in v2 contains only `current_binary` and `restart`; there is no `tauri::process::Command`. Sidecar spawning lives in `tauri-plugin-shell`:

```rust
use tauri_plugin_shell::ShellExt;
let cmd = app.shell().sidecar("node")?          // name only, no path, no triple
    .args(["engine/main.js"]);
let (mut rx, child) = cmd.spawn()?;            // or: cmd.output().await?
```

  `sidecar()` -> `relative_command_path()`: `platform::current_exe()?.parent()` joined with the name, `.exe` appended on Windows. So `std::process::Command::new(current_exe_dir.join("node"))` is equivalent; `resource_dir()` is the wrong base for sidecars (they are not in Resources on macOS).
- Rust calls need no capability; capabilities gate the frontend only. If the webview must call it: `capabilities/default.json` -> `{"identifier":"shell:allow-execute","allow":[{"name":"binaries/node","sidecar":true,"args":[...]}]}`, and JS `Command.sidecar('binaries/node', [...])`.
- Official "Node.js as a sidecar" guide (https://v2.tauri.app/learn/sidecar-nodejs/): it packages with pkg, not a bare node binary: "For this we use the pkg tool, but any other tool that can compile JavaScript or Typescript into a binary application will work." `package.json`: `"build": "pkg index.ts --output my-sidecar"`, then a `rename.js` that does `fs.renameSync(\`my-sidecar${ext}\`, \`../src-tauri/binaries/my-sidecar-${targetTriple}${ext}\`)`. It does not mention Node SEA or shipping node itself. Unverified: whether `tauri dev` also copies externalBin next to the debug exe (expected, not confirmed in the pages read).

## 2. `bundle.resources`

```json
{ "bundle": { "resources": ["../engine/dist/", "../methods/**/*.md"] } }
```
Map form (rename destinations under `$RESOURCE/`):
```json
{ "bundle": { "resources": { "../engine/dist/": "engine/", "../methods/": "methods/" } } }
```
- Globs: `"dir/"` copies recursively preserving structure; `"dir/**/*"` all files; `"dir/**"` is invalid (matches directories only).
- Rust read:
```rust
use tauri::{Manager, path::BaseDirectory};
let p = app.path().resolve("engine/main.js", BaseDirectory::Resource)?;
let s = std::fs::read_to_string(&p)?;
```
- `resource_dir()` per platform: macOS `${exe_dir}/../Resources` (inside the .app); Windows the exe's directory; Linux `/usr/lib/${exe_name}` (AppImage: `${APPDIR}/usr/lib/${exe_name}`).
- Frontend reads need `fs:allow-resource-read-recursive` + `fs:scope` `$RESOURCE/**/*`; Rust reads need nothing.
- Consequence for the engine: `node <resource_dir>/engine/main.js` works, and the .md files sit beside it; pass the resource dir to the child as an argument or env var (`.envs([...])`).

## 3. App data directory

- `app.path().app_data_dir()` = `data_dir()/${bundle_identifier}`: macOS `~/Library/Application Support/<identifier>`, Windows `{FOLDERID_RoamingAppData}/<identifier>`, Linux `$XDG_DATA_HOME/<identifier>` or `~/.local/share/<identifier>`.
- `app_local_data_dir()` = `local_data_dir()/<identifier>` (Windows LocalAppData; same as data on macOS). `app_config_dir()` likewise.
- Not created automatically: `std::fs::create_dir_all` first. Use it for on-demand downloads (e.g. extra runtimes, user DB); never write into `resource_dir()` (read-only inside a signed .app).

## 4. Spawning the bundled node on macOS: Gatekeeper and signing

- `tauri build` signs sidecars: `app.rs` collects `SignTarget { path, is_an_executable: true }` for every external binary, comments "Sign frameworks and sidecar binaries first, per apple, signing must be done inside out", then signs the main bundle. `keychain.rs` runs `codesign --force -s <identity> [--options runtime] [--entitlements <file>] [--keychain <path>] <path>`; no `--deep`, no `--timestamp`.
- The same `bundle.macOS.entitlements` file is applied to every target, sidecar included (`keychain.sign(&target.path, entitlements_path.as_deref(), is_an_executable && hardened_runtime)` in a loop). `hardenedRuntime` defaults to `true`. So the official node binary is re-signed under your Developer ID with your entitlements, replacing Node's own.
- Node's own signature (local check, v24.12.0 and v20.18.1): signed by TeamIdentifier `HX7739G8FX` with hardened runtime and entitlements `allow-jit`, `allow-unsigned-executable-memory`, `allow-dyld-environment-variables`, `disable-executable-page-protection`, `disable-library-validation`, `get-task-allow`. V8 needs JIT, so after Tauri re-signs it your entitlements file must carry at least:

```xml
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
<key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>
```
  (This set is what the dev.to Tauri 2 notarization write-up uses for the app itself; a hardened-runtime sidecar without allow-jit crashes with SIGTRAP after notarization per the search results. Do not add `get-task-allow`: it fails notarization. Unverified: whether Node also needs `disable-executable-page-protection`; test a notarized build.)
- Quarantine: the `com.apple.quarantine` xattr is set on the downloaded .dmg and propagates to the copied .app; Gatekeeper evaluates the whole bundle on first launch. A child process spawned from a running, approved app is not re-prompted. The failure mode to avoid is a sidecar whose signature does not match the bundle (issue #11992: notarization rejected "The signature of the binary is invalid" for `MacOS/test_binary`; the reporter traced it to keychain trust settings and worked around it by signing with an explicit `--keychain $HOME/Library/Keychains/login.keychain-db`; no maintainer fix noted).
- Unsigned app entirely: blocked (see 5). Unsigned node inside a signed .app cannot happen with `tauri build` (everything is signed); if you copy a binary in after the build, the seal breaks and Gatekeeper refuses the app.
- Ad-hoc: the signing guide says an ad-hoc signature is possible with the pseudo-identity `"-"`, "though this approach has limitations regarding user whitelisting"; `keychain.rs` excerpt showed no special handling of `-`. Unverified that it works in 2.x.

## 5. Signing and notarization

macOS (`tauri build` does both when the env is present):

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)"  # or bundle.macOS.signingIdentity
# CI only: import the cert
APPLE_CERTIFICATE=<base64 .p12>  APPLE_CERTIFICATE_PASSWORD=...
# notarize, option A (Apple ID)
APPLE_ID=you@example.com  APPLE_PASSWORD=<app-specific password>  APPLE_TEAM_ID=TEAMID
# notarize, option B (App Store Connect API key)
APPLE_API_ISSUER=...  APPLE_API_KEY=<key id>  APPLE_API_KEY_PATH=./AuthKey_XXXX.p8
```
```json
{ "bundle": { "macOS": {
  "signingIdentity": "Developer ID Application: Name (TEAMID)",
  "entitlements": "./Entitlements.plist",
  "hardenedRuntime": true,
  "minimumSystemVersion": "10.13" } } }
```
- Cost: Apple Developer Program "$99 annual membership". Required for a Developer ID certificate and notarization.
- Unsigned/un-notarized download: Apple 102445 shows "Apple cannot check 'Example App' for malicious software" with only Move to Trash / Done. Override = System Settings > Privacy & Security > Open Anyway, then Open again. Control-click > Open is not mentioned on the current page (removed in Sequoia per common reports; unverified here). Tauri: "Code signing is required on macOS ... to prevent a warning that your application is broken and can not be started, when downloaded from the browser."

Windows:
- Unsigned: SmartScreen warns on download/run until the user clicks through. EV cert: immediate reputation, no warning. OV cert: cheaper, still warns until reputation accrues (Tauri's local OV instructions apply only to certs issued before 2023-06-01; newer OV certs live on hardware tokens or cloud HSMs).
- Local OV: `bundle.windows.{certificateThumbprint, digestAlgorithm:"sha256", timestampUrl}`. Anything else (Azure Trusted/Artifact Signing, Key Vault via relic, other HSM): `"bundle": {"windows": {"signCommand": "relic sign --file %1 --key azure --config relic.conf"}}`.
- Unverified: whether nodejs.org's `node.exe` is Authenticode-signed; the bundler signs it with your cert anyway when `signCommand`/thumbprint is set (unverified that externalBin is included in Windows signing; check the bundler's windows sign path).

## 6. Updater (`tauri-plugin-updater`)

Keys: `tauri signer generate -w ~/.tauri/ape.key` -> private key (keep secret) + pubkey. Build with `TAURI_SIGNING_PRIVATE_KEY=<path or content>` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<pw>`. Verification cannot be disabled.

```json
{ "bundle": { "createUpdaterArtifacts": true },
  "plugins": { "updater": {
    "pubkey": "<content of ape.key.pub>",
    "endpoints": ["https://github.com/<user>/<repo>/releases/latest/download/latest.json"],
    "windows": { "installMode": "passive" } } } }
```
Static endpoint JSON (what tauri-action's `latest.json` looks like):
```json
{ "version": "1.0.0", "notes": "...", "pub_date": "2024-01-15T10:30:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "...", "url": "https://.../APE.app.tar.gz" },
    "darwin-x86_64":  { "signature": "...", "url": "..." },
    "windows-x86_64": { "signature": "...", "url": "https://.../APE_1.0.0_x64-setup.exe" },
    "linux-x86_64":   { "signature": "...", "url": "https://.../APE_1.0.0_amd64.AppImage" } } }
```
Platform key = `<linux|darwin|windows>-<x86_64|aarch64|i686|armv7>`. Dynamic servers answer 204 (none) or 200 with `{version,url,signature,notes,pub_date}`. Endpoint URLs may use `{{current_version}}`, `{{target}}`, `{{arch}}`. Artifacts with `createUpdaterArtifacts`: macOS `APE.app.tar.gz` + `.sig`; Windows the NSIS/MSI installer + `.sig`.

Rust: `app.updater()?.check().await?` -> `update.download_and_install(|_,_|{}, ||{}).await?; app.restart()`. JS: `check()` then `update.downloadAndInstall()` and `relaunch()` from `@tauri-apps/plugin-process`. Sidecars ship inside the updater bundle, so a new node version just rides along.

GitHub Releases workflow (from /distribute/pipelines/github/, trimmed):
```yaml
name: publish
on: { push: { branches: [release] }, workflow_dispatch: }
jobs:
  publish-tauri:
    permissions: { contents: write }
    strategy:
      fail-fast: false
      matrix:
        include:
          - { platform: macos-latest, args: '--target aarch64-apple-darwin' }
          - { platform: macos-latest, args: '--target x86_64-apple-darwin' }
          - { platform: ubuntu-22.04, args: '' }
          - { platform: windows-latest, args: '' }
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v7
      - if: startsWith(matrix.platform, 'ubuntu')
        run: sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf xdg-utils
      - uses: actions/setup-node@v6
        with: { node-version: lts/*, cache: npm }
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: "${{ matrix.platform == 'macos-latest' && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }}" }
      - uses: swatinem/rust-cache@v2
        with: { workspaces: './src-tauri -> target' }
      - run: npm install
      - uses: tauri-apps/tauri-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        with:
          tagName: app-v__VERSION__
          releaseName: 'App v__VERSION__'
          releaseBody: 'See the assets to download this version and install.'
          releaseDraft: true
          prerelease: false
          args: ${{ matrix.args }}
```
tauri-action inputs of note: `uploadUpdaterJson` ("Whether to upload a JSON file for the updater or not ... This file assume you're using the GitHub Release as your updater endpoint"), `updaterJsonPreferNsis`, `tagName`, `releaseDraft`, `args`, `projectPath`. It runs `tauri build`, uploads the bundles, and writes `latest.json` to the release. The Node sidecar per target must be present in `src-tauri/binaries/` before the action runs: add a step that downloads the matching nodejs.org archive and renames `bin/node` (or `node.exe`) to `node-<triple>` (the guide's `rename.js` pattern).

## 7. Node SEA vs shipping the full node binary

Sizes (nodejs.org /dist/latest-v24.x = v24.20.0, 2026-08-26): darwin-arm64 .tar.gz 53 MB, darwin-x64 .tar.gz 54 MB, win-x64 .zip 38 MB, linux-x64 .tar.xz 32 MB, `win-x64/node.exe` 93 MB. Uncompressed macOS arm64 `node` is about 118 MB (local v24.12.0: 117,655,968 bytes). A SEA is that same binary plus your blob, so it is never smaller than node itself; both routes cost roughly 100-120 MB per platform in the installed app (DMG/NSIS compress it to roughly the tarball sizes).

Node 24 SEA: Stability 1.1 "Active development". Only `--experimental-sea-config` + external `postject`; `--build-sea` arrived in v25.5.0 (not in 24). CI-tested platforms: "Windows; macOS (arm64 only; x64 is not currently supported and is skipped in the tests); Linux (... except Alpine ... except s390x)". macOS steps: `codesign --remove-signature hello`, `npx postject hello NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --macho-segment-name NODE_SEA`, `codesign --sign - hello` (Tauri re-signs it later anyway). `mainFormat: "module"` (ESM) is supported but not with `useSnapshot`; `import()` breaks with `useCodeCache`; cross-platform builds need both false. `require` inside the SEA "can only be used to load built-in modules", so everything must be bundled into one file first (esbuild).

`node:sqlite`: Stability 1.2 "Release candidate", unflagged since v22.13.0/v23.4.0 (local: v24.12.0 -> `sqlite ok 3.50.4`, with an ExperimentalWarning). It is a built-in, so by the SEA rule above it is loadable from a SEA; no page read states this explicitly and it was not tested here (unverified). yao-pkg/pkg: "Requires Node.js >= 22 on the build host", "Works out of the box on Node 20 and 24; Node 22 needs --sea or --public"; its `--sea` mode "runs on stock, unmodified Node.js", standard mode uses patched pkg-fetch binaries (delayed security updates).

Trade-off: a bare node + `resources/engine/*.js` lets the engine JS update without rebuilding the sidecar, keeps ESM and the .md files as plain files, avoids postject and the SEA x64-macOS gap, and is what the entitlements story in 4 is already sized for. SEA/pkg only buys a single file and (pkg standard) bytecode obfuscation.

## 8. Windows specifics

`bundle.windows.webviewInstallMode` (`type` values, installer size impact): `downloadBootstrapper` (default, +0 MB, needs internet), `embedBootstrapper` (+~1.8 MB, needs internet, better for Win7 .msi), `offlineInstaller` (+~127 MB, offline), `fixedRuntime` (+~180 MB, `"path": "./Microsoft.WebView2.FixedVersionRuntime.<ver>.x64/"`), `skip` (not recommended). Each accepts `"silent": true|false`.
```json
{ "bundle": { "targets": ["nsis"], "windows": {
  "webviewInstallMode": { "type": "downloadBootstrapper", "silent": true },
  "nsis": { "installMode": "perCurrentUser" } } } }
```
NSIS `-setup.exe` cross-compiles from macOS/Linux and defaults to per-user (`%LOCALAPPDATA%`, no admin); `perMachine` needs admin (`C:/Program Files`); `both` prompts. WiX `.msi` builds on Windows only (needs the VBScript optional feature). Windows 10 1803+ and 11 ship WebView2 Evergreen, so the download bootstrapper is normally a no-op. Sidecar file must be `node-x86_64-pc-windows-msvc.exe`; the plugin appends `.exe` when resolving.

## 9. Recommended shape

- Sidecar: the official nodejs.org `node` binary per target (no pkg, no SEA), at `src-tauri/binaries/node-<triple>[.exe]`, spawned from Rust with `app.shell().sidecar("node").args([main_js, ...])`.
- Engine `dist/` and method `.md` files under `bundle.resources`, located with `app.path().resolve(..., BaseDirectory::Resource)` and handed to node as args/env.
- Mutable state in `app_data_dir()`.
- macOS: Developer ID + notarization via `tauri build` env vars; entitlements file with allow-jit / allow-unsigned-executable-memory / allow-dyld-environment-variables (applies to node too).
- Windows: NSIS per-user, `downloadBootstrapper`; sign via `signCommand` (Azure Trusted Signing) when budget allows; expect SmartScreen until then.
- Updates: `tauri-plugin-updater` with minisign keys, `latest.json` from `tauri-action` on GitHub Releases.
