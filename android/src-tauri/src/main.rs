// Desktop-style entry point kept only so the crate also builds as an
// ordinary binary (e.g. `cargo check` on a host target); the real Android
// entry point is `tauri::mobile_entry_point` in lib.rs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    conductor_mobile_lib::run();
}
