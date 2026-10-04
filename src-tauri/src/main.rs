// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Run as a Claude Code hook (see desktop::hook_main) before anything else.
    if let Some(code) = agent_dev_lib::hook_main() {
        std::process::exit(code);
    }
    agent_dev_lib::run()
}
