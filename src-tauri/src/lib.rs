mod memory;
mod safety;
mod scan;

use serde::Serialize;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use sysinfo::System;
use tauri::{AppHandle, Emitter, Manager, State};

struct AppState {
    scanning: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    sys: Mutex<System>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskInfo {
    total: u64,
    used: u64,
    free: u64,
    full_disk_access: bool,
    scanning: bool,
    home: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrashResult {
    path: String,
    ok: bool,
    error: Option<String>,
}

fn last_scan_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("last-scan.json"))
}

#[tauri::command]
fn disk_info(state: State<AppState>) -> DiskInfo {
    let (total, used, free) = scan::volume_stats();
    DiskInfo { total, used, free, full_disk_access: scan::has_full_disk_access(), scanning: state.scanning.load(Ordering::Relaxed), home: safety::home() }
}

#[tauri::command]
fn start_scan(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    if state.scanning.swap(true, Ordering::SeqCst) {
        return Err("A scan is already running.".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let scanning = state.scanning.clone();
    let cancel = state.cancel.clone();
    std::thread::spawn(move || {
        let emit_app = app.clone();
        let emit = move |p: scan::Progress| {
            let _ = emit_app.emit("scan-progress", p);
        };
        let result = scan::Scanner { cancel: &cancel, emit: &emit }.run();
        if !result.cancelled {
            if let (Some(f), Ok(json)) = (last_scan_file(&app), serde_json::to_vec(&result)) {
                let _ = std::fs::write(f, json);
            }
        }
        scanning.store(false, Ordering::SeqCst);
        let _ = app.emit("scan-done", result);
    });
    Ok(())
}

#[tauri::command]
fn cancel_scan(state: State<AppState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn load_last_scan(app: AppHandle) -> Option<serde_json::Value> {
    let bytes = std::fs::read(last_scan_file(&app)?).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[tauri::command]
fn memory_info(state: State<AppState>) -> memory::MemoryInfo {
    let mut sys = state.sys.lock().unwrap();
    memory::snapshot(&mut sys)
}

#[tauri::command]
fn trash_paths(paths: Vec<String>) -> Vec<TrashResult> {
    use trash::macos::{DeleteMethod, TrashContextExtMacos};
    let mut ctx = trash::TrashContext::default();
    ctx.set_delete_method(DeleteMethod::NsFileManager);
    paths
        .into_iter()
        .map(|path| {
            if !safety::can_trash(&path) {
                return TrashResult { path, ok: false, error: Some("Roomy doesn't touch this location to keep your Mac safe.".into()) };
            }
            if std::fs::symlink_metadata(&path).is_err() {
                // Already gone (maybe removed in Finder). Treat as done.
                return TrashResult { path, ok: true, error: None };
            }
            match ctx.delete(&path) {
                Ok(()) => TrashResult { path, ok: true, error: None },
                Err(e) => TrashResult { path, ok: false, error: Some(e.to_string()) },
            }
        })
        .collect()
}

#[tauri::command]
fn reveal(path: String) {
    let _ = Command::new("open").arg("-R").arg(path).spawn();
}

#[tauri::command]
fn open_place(place: String) {
    let target = match place.as_str() {
        "full-disk-access" => "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles".to_string(),
        "storage-settings" => "x-apple.systempreferences:com.apple.settings.Storage".to_string(),
        "trash" => format!("{}/.Trash", safety::home()),
        "activity-monitor" => "/System/Applications/Utilities/Activity Monitor.app".to_string(),
        _ => return,
    };
    let _ = Command::new("open").arg(target).spawn();
}

#[tauri::command]
fn quit_app(app_path: String) -> Result<(), String> {
    if !app_path.ends_with(".app") || app_path.starts_with("/System/") {
        return Err("This one can't be quit from here.".into());
    }
    // Ask politely by name, the same as choosing Quit from the app's menu.
    let name = std::path::Path::new(&app_path).file_stem().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let out = Command::new("osascript")
        .args(["-e", "on run argv", "-e", "tell application (item 1 of argv) to quit", "-e", "end run", &name])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err("The app didn't want to quit. It may have unsaved work, check the app itself.".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState { scanning: Arc::new(AtomicBool::new(false)), cancel: Arc::new(AtomicBool::new(false)), sys: Mutex::new(System::new()) })
        .invoke_handler(tauri::generate_handler![
            disk_info, start_scan, cancel_scan, load_last_scan, memory_info, trash_paths, reveal, open_place, quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running Roomy");
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore]
    fn real_trash() {
        let h = super::safety::home();
        let f = format!("{h}/roomy-trash-test.txt");
        std::fs::write(&f, "delete me").unwrap();
        let r = super::trash_paths(vec![f.clone(), "/Applications/Safari.app".into(), format!("{h}/Documents")]);
        for x in &r { println!("{} ok={} err={:?}", x.path, x.ok, x.error); }
        assert!(r[0].ok && !std::path::Path::new(&f).exists());
        assert!(!r[1].ok && !r[2].ok);
    }
}
