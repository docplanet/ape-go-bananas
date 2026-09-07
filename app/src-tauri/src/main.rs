// Prevents an additional console window on Windows in release; no effect elsewhere.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ape_app_lib::run()
}
