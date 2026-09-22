//! Live memory, swap and "which apps use the most" snapshot.

use serde::Serialize;
use std::collections::HashMap;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUsage {
    pub name: String,
    pub bytes: u64,
    pub processes: u32,
    /// Path to the .app bundle when this is a normal app (then it can be quit).
    pub app_path: Option<String>,
    pub is_system: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    pub total: u64,
    pub used: u64,
    pub available: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    /// 1 = fine, 2 = tight, 4 = critical (macOS memory pressure levels)
    pub pressure: i32,
    pub uptime_secs: u64,
    pub apps: Vec<AppUsage>,
    pub chrome: crate::chrome::ChromeBreakdown,
}

fn pressure_level() -> i32 {
    let name = std::ffi::CString::new("kern.memorystatus_vm_pressure_level").unwrap();
    let mut v: libc::c_int = 0;
    let mut len = std::mem::size_of::<libc::c_int>();
    let rc = unsafe { libc::sysctlbyname(name.as_ptr(), &mut v as *mut _ as *mut libc::c_void, &mut len, std::ptr::null_mut(), 0) };
    if rc == 0 { v } else { 1 }
}

/// ".../Google Chrome.app/Contents/Frameworks/.../Helper.app/..." -> ".../Google Chrome.app"
fn outer_app(exe: &str) -> Option<&str> {
    exe.find(".app/").map(|i| &exe[..i + 4])
}

pub fn snapshot(sys: &mut System) -> MemoryInfo {
    sys.refresh_memory();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory().with_exe(UpdateKind::OnlyIfNotSet).with_cmd(UpdateKind::OnlyIfNotSet),
    );

    let mut groups: HashMap<String, AppUsage> = HashMap::new();
    for p in sys.processes().values() {
        let exe = p.exe().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
        let pname = p.name().to_string_lossy().to_string();
        let (key, name, app_path, is_system) = match outer_app(&exe) {
            Some(app) => {
                let sys_app = app.starts_with("/System/");
                let n = app.rsplit('/').next().unwrap_or(app).trim_end_matches(".app").to_string();
                (app.to_string(), n, if sys_app { None } else { Some(app.to_string()) }, sys_app)
            }
            None => {
                let sys_proc = exe.is_empty() || ["/System/", "/usr/", "/sbin/", "/bin/", "/Library/Apple/"].iter().any(|p| exe.starts_with(p));
                (format!("proc:{pname}"), pname.clone(), None, sys_proc)
            }
        };
        let g = groups.entry(key).or_insert(AppUsage { name, bytes: 0, processes: 0, app_path, is_system });
        g.bytes += p.memory();
        g.processes += 1;
    }
    let mut apps: Vec<AppUsage> = groups.into_values().collect();
    apps.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    apps.truncate(14);

    MemoryInfo {
        total: sys.total_memory(),
        used: sys.used_memory(),
        available: sys.available_memory(),
        swap_total: sys.total_swap(),
        swap_used: sys.used_swap(),
        pressure: pressure_level(),
        uptime_secs: System::uptime(),
        apps,
        chrome: crate::chrome::breakdown(sys),
    }
}
