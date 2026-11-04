//! Dedicated desktop verification executable. Never replaces the daily binary.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tuicommander_lib::run_agent_test(tauri::generate_context!())
}
