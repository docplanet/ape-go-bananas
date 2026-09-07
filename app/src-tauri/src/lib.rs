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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Sidecar::new())
        .invoke_handler(tauri::generate_handler![sidecar_call, sidecar_status])
        .setup(|app| {
            let sidecar = app.state::<Sidecar>();
            // tokio's Command::spawn needs the runtime's reactor; setup()
            // runs on the main thread outside it, so hop in for the spawn.
            let handle = app.handle().clone();
            let started = sidecar::resolve_paths()
                .and_then(|(node, script)| tauri::async_runtime::block_on(async { sidecar.start(handle, node, script) }));
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
