//! The engine's Node process, owned by the app.
//!
//! Speaks docs/research/sidecar-protocol.md over the child's stdio: one
//! JSON-RPC 2.0 message per line each way. Rust owns the process rather than
//! the webview spawning it through a shell plugin so that (a) the app, not a
//! static capability file, decides which `node` runs -- the engine needs
//! Node >= 24 for `node:sqlite`, and a machine's PATH `node` is often older;
//! (b) the child's lifetime is the window's lifetime; and (c) the reverse
//! direction (`agent/requestPermission`, §5) has a place to land later.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::oneshot;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub running: bool,
    pub node: Option<String>,
    pub script: Option<String>,
    pub error: Option<String>,
    /// `APE_OPEN`: a deck.json to open as soon as the window is up. A CLI/dev
    /// affordance (and the hook a file association will use later).
    pub initial_deck: Option<String>,
    /// Where installed agents and the registry cache live (agent-protocol.md §1).
    pub data_dir: Option<String>,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>>;

pub struct Sidecar {
    inner: Mutex<Option<Running>>,
    status: Mutex<Status>,
    /// How the process was started, so it can be started again.
    launch: Mutex<Option<(AppHandle, Paths)>>,
    started: Mutex<Option<std::time::SystemTime>>,
}

struct Running {
    child: Child,
    stdin: Arc<tokio::sync::Mutex<ChildStdin>>,
    pending: Pending,
    next_id: AtomicU64,
}

impl Sidecar {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            launch: Mutex::new(None),
            started: Mutex::new(None),
            status: Mutex::new(Status {
                running: false,
                node: None,
                script: None,
                error: None,
                initial_deck: std::env::var("APE_OPEN").ok().filter(|s| !s.is_empty()),
                data_dir: None,
            }),
        }
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }

    pub fn set_data_dir(&self, dir: PathBuf) {
        self.status.lock().unwrap().data_dir = Some(dir.display().to_string());
    }

    /// Answers a reverse request the sidecar sent us (agent-protocol.md §3):
    /// the webview decided, this writes the JSON-RPC response to the child.
    pub async fn answer(&self, id: u64, result: Option<Value>, error: Option<RpcError>) -> Result<(), String> {
        let stdin = {
            let guard = self.inner.lock().unwrap();
            guard.as_ref().ok_or("sidecar not running")?.stdin.clone()
        };
        let msg = match error {
            Some(err) => json!({ "jsonrpc": "2.0", "id": id, "error": err }),
            None => json!({ "jsonrpc": "2.0", "id": id, "result": result.unwrap_or(Value::Null) }),
        };
        let line = format!("{}\n", msg);
        let mut guard = stdin.lock().await;
        guard.write_all(line.as_bytes()).await.map_err(|e| format!("write to sidecar: {e}"))
    }

    /// Spawns the engine. `node` and `script` are resolved by `resolve_paths`;
    /// the first stdout line must be `sidecar/ready` (§2.1), forwarded to the
    /// webview like every other notification.
    pub fn start(&self, app: AppHandle, paths: Paths) -> Result<(), String> {
        *self.launch.lock().unwrap() = Some((app.clone(), paths.clone()));
        let Paths { node, script, npm_cli, method_dir } = paths;
        let mut cmd = Command::new(&node);
        cmd.arg(&script);
        if let Some(npm) = npm_cli {
            cmd.env("APE_NPM_CLI", npm);
        }
        if let Some(dir) = method_dir {
            cmd.env("APE_METHOD_DIR", dir);
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("spawn {} {}: {e}", node.display(), script.display()))?;

        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));

        let reader_pending = pending.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let msg: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => {
                        eprintln!("sidecar: non-JSON on stdout, ignored: {line}");
                        continue;
                    }
                };
                match (msg.get("id"), msg.get("method")) {
                    // response or error-response
                    (Some(id), None) => {
                        let Some(id) = id.as_u64() else { continue };
                        let tx = reader_pending.lock().unwrap().remove(&id);
                        if let Some(tx) = tx {
                            let outcome = if let Some(err) = msg.get("error") {
                                Err(serde_json::from_value(err.clone()).unwrap_or(RpcError {
                                    code: -32603,
                                    message: "malformed error object".into(),
                                    data: None,
                                }))
                            } else {
                                Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                            };
                            let _ = tx.send(outcome);
                        }
                    }
                    // notification
                    (None, Some(method)) => {
                        let _ = app.emit(
                            "sidecar://notification",
                            json!({ "method": method, "params": msg.get("params").cloned().unwrap_or(Value::Null) }),
                        );
                    }
                    // reverse request (agent-protocol.md §3): the webview
                    // answers through the `sidecar_answer` command.
                    (Some(id), Some(method)) => {
                        let _ = app.emit(
                            "sidecar://request",
                            json!({ "id": id, "method": method, "params": msg.get("params").cloned().unwrap_or(Value::Null) }),
                        );
                    }
                    _ => {}
                }
            }
            // stdout closed: every waiter gets an error rather than a hang.
            for (_, tx) in reader_pending.lock().unwrap().drain() {
                let _ = tx.send(Err(RpcError { code: -32001, message: "sidecar exited".into(), data: None }));
            }
        });

        *self.inner.lock().unwrap() = Some(Running {
            child,
            stdin: Arc::new(tokio::sync::Mutex::new(stdin)),
            pending,
            next_id: AtomicU64::new(1),
        });
        *self.started.lock().unwrap() = Some(std::time::SystemTime::now());
        {
            let mut s = self.status.lock().unwrap();
            s.running = true;
            s.node = Some(node.display().to_string());
            s.script = Some(script.display().to_string());
            s.error = None;
        }
        Ok(())
    }

    pub fn fail(&self, error: String) {
        let mut s = self.status.lock().unwrap();
        s.running = false;
        s.error = Some(error);
    }

    /// A dev build runs the engine as it is in the repo (`resolve_paths`), and
    /// a rebuild there leaves this process serving the old code: "method not
    /// found: anki/send" came from a sidecar two hours older than `dist/`.
    /// True when the script on disk is newer than the process running it.
    fn stale(&self) -> bool {
        if !cfg!(debug_assertions) {
            return false;
        }
        let Some(started) = *self.started.lock().unwrap() else { return false };
        let Some(script) = self.launch.lock().unwrap().as_ref().map(|(_, p)| p.script.clone()) else { return false };
        std::fs::metadata(script).and_then(|m| m.modified()).map(|m| m > started).unwrap_or(false)
    }

    /// Stops the process and starts it again from the same paths. Whatever
    /// the old one held -- agent sessions above all -- is gone; the shell is
    /// told, as a notification, and starts over.
    pub fn restart(&self) -> Result<(), String> {
        let (app, paths) = self.launch.lock().unwrap().clone().ok_or_else(|| "the engine was never started".to_string())?;
        self.stop();
        self.start(app.clone(), paths)?;
        let _ = app.emit("sidecar://notification", json!({ "method": "engine/restarted", "params": Value::Null }));
        Ok(())
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        if cfg!(debug_assertions) {
            eprintln!("sidecar: -> {method}");
        }
        if self.stale() {
            eprintln!("sidecar: the engine on disk is newer than the running process; restarting it");
            if let Err(e) = self.restart() {
                self.fail(e.clone());
                return Err(RpcError { code: -32001, message: e, data: None });
            }
        }
        let (stdin, rx, line) = {
            let guard = self.inner.lock().unwrap();
            let running = guard.as_ref().ok_or(RpcError {
                code: -32001,
                message: self.status().error.unwrap_or_else(|| "sidecar not running".into()),
                data: None,
            })?;
            let id = running.next_id.fetch_add(1, Ordering::SeqCst);
            let (tx, rx) = oneshot::channel();
            running.pending.lock().unwrap().insert(id, tx);
            let mut req = json!({ "jsonrpc": "2.0", "id": id, "method": method });
            if !params.is_null() {
                req["params"] = params;
            }
            (running.stdin.clone(), rx, format!("{}\n", req))
        };
        stdin
            .lock()
            .await
            .write_all(line.as_bytes())
            .await
            .map_err(|e| RpcError { code: -32001, message: format!("write to sidecar: {e}"), data: None })?;
        rx.await.unwrap_or(Err(RpcError { code: -32001, message: "sidecar dropped the request".into(), data: None }))
    }

    pub fn stop(&self) {
        if let Some(mut running) = self.inner.lock().unwrap().take() {
            let _ = running.child.start_kill();
        }
    }
}

/// Which Node and which script. Explicit env wins (`APE_NODE`, `APE_SIDECAR`);
/// in a debug build the script defaults to the engine checkout this app lives
/// in; `node` falls back to PATH. A wrong Node is the first thing a dev hits,
/// so the version is checked here and the message names the fix.
#[derive(Clone)]
pub struct Paths {
    pub node: PathBuf,
    pub script: PathBuf,
    /// npm's entry point, handed to the sidecar as `APE_NPM_CLI` so agent
    /// installs use the bundled npm (agent-protocol.md §1).
    pub npm_cli: Option<PathBuf>,
    /// The method files, handed to the sidecar as `APE_METHOD_DIR`
    /// (course-protocol.md §1): the bundle's `method/` resource, else the
    /// method repo's `method/` beside this checkout in dev.
    pub method_dir: Option<PathBuf>,
}

/// Bundled layout (tauri-packaging.md §9): the node externalBin sits beside
/// the app executable; engine, npm and method files are resources.
fn bundled(resource_dir: Option<&PathBuf>) -> (Option<PathBuf>, Option<PathBuf>, Option<PathBuf>) {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let node = exe_dir.as_ref().map(|d| d.join(if cfg!(windows) { "node.exe" } else { "node" })).filter(|p| p.exists());
    // Tauri's resource_dir() canonicalizes `<exe dir>/../Resources` and has
    // been seen to fail for a bundle copied out of a zip; the layout is fixed
    // (tauri-packaging.md §2), so derive it from the executable as a fallback.
    let derived = exe_dir.as_ref().map(|d| {
        if cfg!(target_os = "macos") { d.join("..").join("Resources") } else { d.clone() }
    });
    let resource_dir = resource_dir.cloned().filter(|p| p.is_dir()).or(derived.filter(|p| p.is_dir()));
    let resource_dir = resource_dir.as_ref();
    let script = resource_dir.map(|r| r.join("engine").join("sidecar").join("index.js")).filter(|p| p.exists());
    let npm = resource_dir.map(|r| r.join("npm").join("bin").join("npm-cli.js")).filter(|p| p.exists());
    (node, script, npm)
}

pub fn resolve_paths(resource_dir: Option<PathBuf>) -> Result<Paths, String> {
    let (bundled_node, bundled_script, bundled_npm) = bundled(resource_dir.as_ref());
    // A dev build runs the engine as it is in the repo. The staged copy under
    // src-tauri/resources is whatever prepare-bundle last wrote, and preferring
    // it here once ran a weeks-old sidecar under a freshly built window
    // ("method not found: decks/create").
    let repo_dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../dist/sidecar/index.js");
    let script = match std::env::var_os("APE_SIDECAR") {
        Some(p) => PathBuf::from(p),
        None => match bundled_script {
            _ if cfg!(debug_assertions) && repo_dist.exists() => repo_dist,
            Some(p) => p,
            None => {
                return Err(format!(
                    "no bundled engine (looked for engine/sidecar/index.js under {}; exe {}) and APE_SIDECAR is not set",
                    resource_dir.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "<no resource dir>".into()),
                    std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default()
                ))
            }
        },
    };
    let script = script.canonicalize().map_err(|e| format!("engine script {}: {e} (run `npm run build` in the engine repo)", script.display()))?;

    let node = std::env::var_os("APE_NODE")
        .map(PathBuf::from)
        .or(bundled_node)
        .unwrap_or_else(|| PathBuf::from("node"));
    let npm_cli = std::env::var_os("APE_NPM_CLI").map(PathBuf::from).or(bundled_npm);
    // Same for the method files: in dev, the method repo beside this checkout
    // (staged with SETUP.md by prepare-bundle for a real bundle).
    let dev_method = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../Anki/method");
    let method_dir = std::env::var_os("APE_METHOD_DIR")
        .map(PathBuf::from)
        .or_else(|| if cfg!(debug_assertions) && dev_method.is_dir() { dev_method.canonicalize().ok() } else { None })
        .or_else(|| resource_dir.as_ref().map(|r| r.join("method")).filter(|p| p.join("1-extract.md").exists()));
    let out = std::process::Command::new(&node)
        .arg("--version")
        .output()
        .map_err(|e| format!("{}: {e} (set APE_NODE to a Node >= 24 binary)", node.display()))?;
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let major: u32 = version.trim_start_matches('v').split('.').next().and_then(|m| m.parse().ok()).unwrap_or(0);
    if major < 24 {
        return Err(format!("{} is Node {version}; the engine needs >= 24 (node:sqlite). Set APE_NODE.", node.display()));
    }
    Ok(Paths { node, script, npm_cli, method_dir })
}
