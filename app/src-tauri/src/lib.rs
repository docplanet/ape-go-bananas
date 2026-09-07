mod sidecar;

use sidecar::{RpcError, Sidecar, Status};
use serde_json::Value;
use tauri::{Manager, State};

#[tauri::command]
async fn sidecar_call(state: State<'_, Sidecar>, method: String, params: Value) -> Result<Value, RpcError> {
    state.call(&method, params).await
}

#[tauri::command]
fn sidecar_status(state: State<'_, Sidecar>) -> Status {
    state.status()
}

#[tauri::command]
async fn sidecar_answer(state: State<'_, Sidecar>, id: u64, result: Option<Value>, error: Option<RpcError>) -> Result<(), String> {
    state.answer(id, result, error).await
}

// API keys live in the OS credential store, never in a file the sidecar or
// the webview can read at rest. The webview asks for one only to hand it to
// `agent/connect`, and nothing logs it (agent-protocol.md §2, §5).
const SECRET_SERVICE: &str = "dev.docplanet.ape";

#[tauri::command]
fn secret_get(name: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SECRET_SERVICE, &name).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_set(name: String, value: String) -> Result<(), String> {
    keyring::Entry::new(SECRET_SERVICE, &name)
        .and_then(|e| e.set_password(&value))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_delete(name: String) -> Result<(), String> {
    let entry = keyring::Entry::new(SECRET_SERVICE, &name).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Sidecar::new())
        .invoke_handler(tauri::generate_handler![sidecar_call, sidecar_status, sidecar_answer, secret_get, secret_set, secret_delete])
        .setup(|app| {
            let sidecar = app.state::<Sidecar>();
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
                sidecar.set_data_dir(dir);
            }
            // tokio's Command::spawn needs the runtime's reactor; setup()
            // runs on the main thread outside it, so hop in for the spawn.
            let handle = app.handle().clone();
            let resource_dir = app.path().resource_dir().ok();
            let started = sidecar::resolve_paths(resource_dir)
                .and_then(|paths| tauri::async_runtime::block_on(async { sidecar.start(handle, paths) }));
            match started {
                Ok(()) => {}
                Err(e) => {
                    eprintln!("sidecar: {e}");
                    sidecar.fail(e);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<Sidecar>().stop();
            }
        });
}
