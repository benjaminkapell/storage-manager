#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|a| a == "--battery-check") {
        return roomy_lib::background_battery_check();
    }
    roomy_lib::run()
}
