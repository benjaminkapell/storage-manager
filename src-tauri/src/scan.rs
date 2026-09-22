//! The disk scan: one parallel walk over the data volume that produces
//! big files, folder sizes, clean-up candidates and system data, followed by
//! a hashing pass that confirms exact duplicates.

use crate::safety::{can_trash, display_path, home, is_package_ext};
use jwalk::WalkDirGeneric;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::{File, Metadata};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const MB: u64 = 1024 * 1024;
const GB: u64 = 1024 * MB;
const BIG_FILE: u64 = 200 * MB;
const DUP_MIN: u64 = MB;
const FOLDER_MIN: u64 = 100 * MB;
const FOLDER_MAX_DEPTH: usize = 14;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: &'static str,
    pub files: u64,
    pub bytes: u64,
    pub current: String,
    pub done: u64,
    pub total: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileItem {
    pub path: String,
    pub size: u64,
    pub modified: u64,
    /// "file", "app" or "library" (a package such as a Final Cut library)
    pub kind: &'static str,
    pub category: &'static str,
    pub trashable: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub path: String,
    pub size: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    pub path: Option<String>,
    pub title: String,
    pub detail: String,
    pub size: u64,
    /// dev | cache | logs | installers | trash | backups | mail | messages |
    /// photos | icloud | docker | appdata | swap | snapshots | hidden
    pub group: &'static str,
    /// "safe" (rebuilds itself), "check" (look before removing), "guide" (fix it elsewhere)
    pub safety: &'static str,
    pub trashable: bool,
    pub how_to: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DupGroup {
    pub size: u64,
    pub wasted: u64,
    pub files: Vec<FileItem>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub key: &'static str,
    pub bytes: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub finished_at: u64,
    pub duration_ms: u64,
    pub cancelled: bool,
    pub volume_total: u64,
    pub volume_used: u64,
    pub volume_free: u64,
    pub scanned_bytes: u64,
    pub file_count: u64,
    pub unreadable: u64,
    pub full_disk_access: bool,
    pub categories: Vec<Category>,
    pub folders: Vec<Folder>,
    pub big_files: Vec<FileItem>,
    pub junk: Vec<Finding>,
    pub system: Vec<Finding>,
    pub duplicates: Vec<DupGroup>,
}

/// What we learned about a directory when we entered it. Flags are inherited
/// by everything below it.
#[derive(Clone)]
struct Frame {
    path: String,
    depth: usize,
    size: u64,
    in_app: bool,
    in_package: bool,
    in_photos: bool,
    in_junk: bool,
    in_dev: bool,
    in_system: bool,
    in_hidden: bool,
    junk: Option<Def>,
    system: Option<Def>,
    package: Option<&'static str>,
    modified: u64,
}

#[derive(Clone)]
struct Def {
    group: &'static str,
    title: String,
    detail: &'static str,
    safety: &'static str,
    how_to: Option<&'static str>,
    min_size: u64,
}

fn def(group: &'static str, title: impl Into<String>, detail: &'static str, safety: &'static str) -> Def {
    Def { group, title: title.into(), detail, safety, how_to: None, min_size: MB }
}

pub fn volume_stats() -> (u64, u64, u64) {
    let root = data_root();
    let c = std::ffi::CString::new(root.to_string_lossy().as_bytes()).unwrap();
    unsafe {
        let mut s: libc::statfs = std::mem::zeroed();
        if libc::statfs(c.as_ptr(), &mut s) != 0 {
            return (0, 0, 0);
        }
        let bs = s.f_bsize as u64;
        let total = s.f_blocks as u64 * bs;
        let free = s.f_bavail as u64 * bs;
        let used = (s.f_blocks as u64 - s.f_bfree as u64) * bs;
        (total, used, free)
    }
}

/// On modern macOS everything you can change lives on the Data volume.
/// Walking it (rather than "/") avoids counting firmlinked folders twice.
pub fn data_root() -> PathBuf {
    let p = PathBuf::from("/System/Volumes/Data");
    if p.exists() { p } else { PathBuf::from("/") }
}

pub fn has_full_disk_access() -> bool {
    let h = home();
    for probe in ["Library/Safari", "Library/Mail", "Library/Messages"] {
        let p = Path::new(&h).join(probe);
        if p.exists() {
            if let Err(e) = std::fs::read_dir(&p) {
                if e.kind() == std::io::ErrorKind::PermissionDenied {
                    return false;
                }
            }
        }
    }
    true
}

fn mtime(m: &Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0)
}

fn ext_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => name[i + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

fn category_for_ext(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "mp4" | "mov" | "m4v" | "mkv" | "avi" | "webm" | "mts" | "braw" | "r3d" | "mxf" | "insv" | "lrv" | "hevc" => "videos",
        "jpg" | "jpeg" | "png" | "heic" | "heif" | "gif" | "webp" | "tif" | "tiff" | "raw" | "cr2" | "cr3" | "nef" | "arw" | "dng" | "raf" | "psd" | "svg" => "photos",
        "mp3" | "wav" | "aif" | "aiff" | "flac" | "m4a" | "aac" | "ogg" | "caf" => "music",
        "pdf" | "doc" | "docx" | "pages" | "key" | "numbers" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "md" | "rtf" | "csv" | "epub" => "documents",
        "zip" | "dmg" | "pkg" | "rar" | "7z" | "tar" | "gz" | "tgz" | "iso" | "xip" | "bz2" | "xz" => "archives",
        _ => return None,
    })
}

/// Recognise folders that are safe clean-up candidates.
fn classify_junk(dp: &str, name: &str, real: &Path, h: &str) -> Option<Def> {
    let lib = format!("{h}/Library");
    let rel = dp.strip_prefix(&format!("{h}/")).unwrap_or("");
    let project = |fallback: &str| {
        let parent = Path::new(dp).parent();
        let name = |p: Option<&Path>| p.and_then(|x| x.file_name()).map(|n| n.to_string_lossy().to_string());
        match name(parent) {
            Some(n) if matches!(n.as_str(), "src-tauri" | "backend" | "frontend" | "app" | "web" | "server" | "client" | "pipeline") => {
                name(parent.and_then(|p| p.parent())).map(|g| format!("{g} / {n}")).unwrap_or(n)
            }
            Some(n) => n,
            None => fallback.to_string(),
        }
    };
    let d = match name {
        "node_modules" => def("dev", format!("Code packages for \u{201c}{}\u{201d}", project("a project")),
            "Downloaded building blocks for a coding project (node_modules). They come back automatically the next time the project is installed.", "safe"),
        "target" if real.parent().map(|p| p.join("Cargo.toml").exists()).unwrap_or(false) =>
            def("dev", format!("Rust build files for \u{201c}{}\u{201d}", project("a project")),
                "Temporary files created when a Rust project is built. They are recreated the next time you build.", "safe"),
        ".venv" | "venv" if real.join("pyvenv.cfg").exists() =>
            def("dev", format!("Python setup for \u{201c}{}\u{201d}", project("a project")),
                "A private copy of Python for one project. It can be set up again from the project's instructions.", "safe"),
        ".next" | ".turbo" | ".parcel-cache" | ".svelte-kit" | "__pycache__" if dp.starts_with(h) && !dp.starts_with(&lib) =>
            def("dev", format!("Build leftovers in \u{201c}{}\u{201d}", project("a project")),
                "Temporary files a coding tool makes to speed things up. They are recreated automatically.", "safe"),
        _ => {
            return match rel {
                "Library/Developer/Xcode/DerivedData" => Some(def("dev", "Xcode build files",
                    "Temporary files Xcode creates while building apps. Xcode recreates them when needed.", "safe")),
                "Library/Developer/Xcode/iOS DeviceSupport" | "Library/Developer/Xcode/watchOS DeviceSupport" => Some(def("dev", "Xcode iPhone support files",
                    "Files Xcode downloaded for iPhones you once connected. They download again if you connect that phone.", "safe")),
                "Library/Developer/CoreSimulator/Devices" => Some(Def { how_to: Some("Open Terminal and run: xcrun simctl delete unavailable. Or remove simulators in Xcode > Window > Devices and Simulators."),
                    ..def("dev", "iPhone simulators", "Pretend iPhones Xcode uses for testing. Old ones pile up.", "check") }),
                "Library/Developer/CoreSimulator/Caches" => Some(def("dev", "iPhone simulator caches", "Temporary simulator files. Recreated when needed.", "safe")),
                ".npm" => Some(def("dev", "npm download cache", "Copies of code packages kept to speed up future installs. Safe to remove.", "safe")),
                ".cache" => Some(def("dev", "Developer tools cache", "Temporary files kept by coding tools. They are downloaded again when needed.", "safe")),
                ".cargo/registry" => Some(def("dev", "Rust package cache", "Downloaded Rust packages. They download again when needed.", "safe")),
                ".gradle/caches" => Some(def("dev", "Gradle cache", "Android/Java build downloads. Recreated when needed.", "safe")),
                ".bun/install/cache" => Some(def("dev", "Bun download cache", "Copies of code packages. Downloaded again when needed.", "safe")),
                "Library/pnpm" => Some(def("dev", "pnpm package store", "Shared code packages for projects. Reinstalled when a project needs them.", "safe")),
                "Movies/CapCut/User Data/Cache" => Some(def("cache", "CapCut video cache",
                    "Preview copies CapCut makes while you edit. Your projects stay intact, CapCut recreates previews when needed.", "safe")),
                ".ollama/models" => Some(Def { how_to: Some("Open Terminal, type ollama list to see your models, then ollama rm <name> for the ones you don't use."),
                    ..def("dev", "AI models (Ollama)", "Large AI model files downloaded for Ollama. Only remove the ones you no longer use.", "guide") }),
                "Library/Logs" => Some(def("logs", "App log files", "Diary files apps write about what they did. Only useful for troubleshooting.", "safe")),
                ".Trash" => Some(Def { how_to: Some("Right-click the Trash in your Dock and choose Empty Trash."),
                    ..def("trash", "Already in your Trash", "Files you already deleted. They still take up space until the Trash is emptied.", "guide") }),
                _ if rel.starts_with("Library/Caches/") && !rel["Library/Caches/".len()..].contains('/') => {
                    Some(def("cache", format!("Cache: {}", friendly_bundle(name)),
                        "Temporary files an app keeps to load faster. The app rebuilds them when needed (it may be a bit slower the first time).", "safe"))
                }
                _ => None,
            };
        }
    };
    Some(d)
}

/// Recognise big system-data areas that can't just be trashed.
fn classify_system(dp: &str, name: &str, h: &str) -> Option<Def> {
    let rel = dp.strip_prefix(&format!("{h}/")).unwrap_or("");
    if name.ends_with(".photoslibrary") {
        return Some(Def { how_to: Some("Open Photos > Settings > iCloud and choose \u{201c}Optimize Mac Storage\u{201d}. Photos then keeps full copies in iCloud and smaller ones on your Mac. Also check Photos > Recently Deleted."),
            min_size: GB, ..def("photos", format!("Photos library \u{201c}{}\u{201d}", name.trim_end_matches(".photoslibrary")), "All the photos and videos in the Photos app.", "guide") });
    }
    if dp == "/private/var/folders" {
        return Some(Def { how_to: Some("Restart your Mac. macOS cleans most of these up by itself while starting."),
            min_size: 2 * GB, ..def("temp", "Temporary system files", "Scratch files apps and macOS make while working. Normally cleaned up on restart.", "guide") });
    }
    let parent_rel = Path::new(rel).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    Some(match (rel, parent_rel.as_str()) {
        (_, "Library/Application Support/MobileSync/Backup") => Def {
            how_to: Some("With the phone connected, open Finder, select it in the sidebar, click Manage Backups and delete old ones. Or move this backup to the Trash here if you no longer need it."),
            min_size: 100 * MB, ..def("backups", "iPhone or iPad backup", "A full copy of a phone or tablet saved on this Mac. Not needed if you back up to iCloud.", "check") },
        ("Library/Mail", _) => Def { how_to: Some("In Mail, delete large old emails and empty the Deleted Messages folder. Emails stay safe in your email account online."),
            min_size: GB, ..def("mail", "Email stored on this Mac", "Copies of your emails and attachments from the Mail app.", "guide") },
        ("Library/Messages/Attachments", _) => Def { how_to: Some("Open Messages > Settings > General and set \u{201c}Keep messages\u{201d} to 1 year. Or go to Apple menu > System Settings > General > Storage > Messages to remove big attachments."),
            min_size: 500 * MB, ..def("messages", "Photos and files from Messages", "Every picture, video and file sent or received in iMessage.", "guide") },
        ("Library/Containers/com.docker.docker", _) => Def { how_to: Some("Open Docker Desktop > Troubleshoot (bug icon) > Clean / Purge data. Or in Terminal run: docker system prune -a"),
            min_size: GB, ..def("docker", "Docker", "A virtual computer used for coding. It keeps growing and never shrinks on its own.", "guide") },
        ("Library/Mobile Documents", _) => Def { how_to: Some("Open Apple menu > System Settings > your name > iCloud > iCloud Drive and turn on \u{201c}Optimize Mac Storage\u{201d}."),
            min_size: GB, ..def("icloud", "iCloud Drive files kept on this Mac", "Local copies of your iCloud Drive files.", "guide") },
        (_, "Library/Containers") | (_, "Library/Group Containers") | (_, "Library/Application Support") => Def {
            how_to: Some("Clean it from inside the app (look for a storage or cache setting), or delete the app if you don't use it anymore."),
            min_size: GB, ..def("appdata", format!("App data: {}", friendly_bundle(name)), "Files an app saves for itself: downloads, chat history, offline content.", "guide") },
        _ => return None,
    })
}

/// "com.spotify.client" -> "Spotify"; "group.net.whatsapp.WhatsApp.shared" -> "Whatsapp"; "Google" -> "Google".
fn friendly_bundle(name: &str) -> String {
    let n = name.trim_start_matches("group.");
    let parts: Vec<&str> = n.split('.').collect();
    if parts.len() < 3 {
        return n.to_string();
    }
    let pick = if parts[1] == "apple" { parts[parts.len() - 1] } else { parts[1] };
    let mut c = pick.chars();
    let word = c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default();
    if parts[1] == "apple" { format!("Apple {word}") } else { word }
}

pub struct Scanner<'a> {
    pub cancel: &'a AtomicBool,
    pub emit: &'a (dyn Fn(Progress) + Sync),
}

impl Scanner<'_> {
    pub fn run(&self) -> ScanResult {
        let started = Instant::now();
        let h = home();
        let root = data_root();
        let (volume_total, volume_used, volume_free) = volume_stats();

        let walker = WalkDirGeneric::<((), Option<Metadata>)>::new(&root)
            .skip_hidden(false)
            .follow_links(false)
            .process_read_dir(|_, _, _, children| {
                for c in children.iter_mut().flatten() {
                    c.client_state = std::fs::symlink_metadata(c.path()).ok();
                }
            });

        let mut stack: Vec<Frame> = Vec::new();
        let mut seen_inodes: HashSet<(u64, u64)> = HashSet::new();
        let mut folders = Vec::new();
        let mut big: Vec<FileItem> = Vec::new();
        let mut junk: Vec<Finding> = Vec::new();
        let mut system: Vec<Finding> = Vec::new();
        let mut cats: HashMap<&'static str, u64> = HashMap::new();
        let mut dup_candidates: HashMap<u64, Vec<(PathBuf, u64)>> = HashMap::new();
        let mut swap_bytes = 0u64;
        let mut files = 0u64;
        let mut bytes = 0u64;
        let mut unreadable = 0u64;
        let mut last_emit = Instant::now();
        let lib = format!("{h}/Library");
        let trash_dir = format!("{h}/.Trash");

        let finalize = |f: Frame, stack: &mut Vec<Frame>, folders: &mut Vec<Folder>, big: &mut Vec<FileItem>, junk: &mut Vec<Finding>, system: &mut Vec<Finding>| {
            if f.size >= FOLDER_MIN && f.depth <= FOLDER_MAX_DEPTH {
                folders.push(Folder { path: f.path.clone(), size: f.size });
            }
            if let Some(d) = &f.junk {
                if f.size >= d.min_size {
                    junk.push(to_finding(d, &f.path, f.size));
                }
            }
            if let Some(d) = &f.system {
                if f.size >= d.min_size {
                    system.push(to_finding(d, &f.path, f.size));
                }
            }
            if let Some(kind) = f.package {
                if f.size >= BIG_FILE && f.system.is_none() && worth_listing(&f.path) {
                    big.push(FileItem {
                        path: f.path.clone(),
                        size: f.size,
                        modified: f.modified,
                        kind,
                        category: if kind == "app" { "apps" } else { "other" },
                        trashable: can_trash(&f.path),
                    });
                }
            }
            if let Some(parent) = stack.last_mut() {
                parent.size += f.size;
            }
        };

        for entry in walker {
            if self.cancel.load(Ordering::Relaxed) {
                break;
            }
            let e = match entry {
                Ok(e) => e,
                Err(_) => {
                    unreadable += 1;
                    continue;
                }
            };
            if e.read_children_error.is_some() {
                unreadable += 1;
            }
            let depth = e.depth;
            while stack.last().map(|t| t.depth >= depth).unwrap_or(false) {
                let f = stack.pop().unwrap();
                finalize(f, &mut stack, &mut folders, &mut big, &mut junk, &mut system);
            }
            let real = e.path();
            let dp = display_path(&real);
            let name = e.file_name.to_string_lossy().to_string();
            let meta = match (&e.client_state, depth) {
                (Some(m), _) => m.clone(),
                (None, 0) => match std::fs::symlink_metadata(&real) {
                    Ok(m) => m,
                    Err(_) => continue,
                },
                _ => {
                    unreadable += 1;
                    continue;
                }
            };
            let ft = meta.file_type();
            let parent = stack.last();
            let inherit = |f: fn(&Frame) -> bool| parent.map(f).unwrap_or(false);

            if ft.is_dir() {
                let ext = ext_of(&name);
                let is_pkg = is_package_ext(&ext);
                let in_package = inherit(|p| p.in_package);
                let in_junk = inherit(|p| p.in_junk);
                let in_system = inherit(|p| p.in_system);
                let junk_def = if !in_junk && !in_package && depth > 0 { classify_junk(&dp, &name, &real, &h) } else { None };
                let sys_def = if !in_system && !in_junk && junk_def.is_none() && depth > 0 { classify_system(&dp, &name, &h) } else { None };
                stack.push(Frame {
                    depth,
                    size: meta.blocks() * 512,
                    in_app: inherit(|p| p.in_app) || ext == "app",
                    in_package: in_package || is_pkg,
                    in_photos: inherit(|p| p.in_photos) || ext == "photoslibrary",
                    in_dev: inherit(|p| p.in_dev) || junk_def.as_ref().map(|d| d.group == "dev").unwrap_or(false),
                    in_junk: in_junk || junk_def.is_some(),
                    in_system: in_system || sys_def.is_some(),
                    in_hidden: inherit(|p| p.in_hidden) || (name.starts_with('.') && depth > 0),
                    package: if is_pkg && !in_package {
                        Some(if ext == "app" { "app" } else { "library" })
                    } else {
                        None
                    },
                    junk: junk_def,
                    system: sys_def,
                    modified: mtime(&meta),
                    path: dp,
                });
                continue;
            }
            if !ft.is_file() {
                continue;
            }

            if meta.nlink() > 1 && !seen_inodes.insert((meta.dev() as u64, meta.ino())) {
                continue; // hard link we already counted
            }
            let size = meta.blocks() * 512;
            files += 1;
            bytes += size;
            let Some(top) = stack.last_mut() else { continue };
            top.size += size;

            let ext = ext_of(&name);
            let in_user_area = dp.starts_with(&format!("{h}/")) && !dp.starts_with(&lib) && !dp.starts_with(&trash_dir);
            let category = if top.in_app {
                "apps"
            } else if top.in_dev {
                "dev"
            } else if top.in_photos {
                "photos"
            } else if let Some(c) = category_for_ext(&ext) {
                c
            } else if in_user_area {
                "other"
            } else {
                "system"
            };
            *cats.entry(category).or_default() += size;

            if dp.starts_with("/private/var/vm/") {
                swap_bytes += size;
                continue;
            }
            if size >= BIG_FILE && !top.in_package && !top.in_junk && worth_listing(&dp) {
                big.push(FileItem { path: dp.clone(), size, modified: mtime(&meta), kind: "file", category, trashable: can_trash(&dp) });
            }
            let logical = meta.len();
            if logical >= DUP_MIN && in_user_area && !top.in_package && !top.in_junk && !top.in_hidden && size > 0 && !app_managed(&dp) {
                dup_candidates.entry(logical).or_default().push((real.clone(), mtime(&meta)));
            }
            if matches!(ext.as_str(), "dmg" | "pkg" | "xip" | "iso") && in_user_area && size >= 5 * MB && !top.in_package && !top.in_junk {
                junk.push(Finding {
                    id: dp.clone(),
                    path: Some(dp.clone()),
                    title: format!("Installer: {name}"),
                    detail: "A file used to install an app. Once the app is installed you don't need it anymore.".into(),
                    size,
                    group: "installers",
                    safety: "safe",
                    trashable: can_trash(&dp),
                    how_to: None,
                });
            }

            if last_emit.elapsed().as_millis() > 120 {
                last_emit = Instant::now();
                (self.emit)(Progress { phase: "walking", files, bytes, current: dp, done: bytes, total: volume_used });
            }
        }
        while let Some(f) = stack.pop() {
            finalize(f, &mut stack, &mut folders, &mut big, &mut junk, &mut system);
        }

        let cancelled = self.cancel.load(Ordering::Relaxed);
        let duplicates = if cancelled { Vec::new() } else { self.find_duplicates(dup_candidates) };

        // Extra system facts that the walk can't see as folders.
        if swap_bytes > 0 {
            system.push(Finding {
                id: "swap".into(), path: None, title: "Memory overflow files (swap)".into(),
                detail: "When your Mac runs out of memory it parks things on the disk. These files shrink after a restart.".into(),
                size: swap_bytes, group: "swap", safety: "guide", trashable: false,
                how_to: Some("Restart your Mac. Quitting apps you aren't using (see the Memory tab) keeps them small.".into()),
            });
        }
        let snaps = local_snapshots();
        if snaps > 0 {
            system.push(Finding {
                id: "snapshots".into(), path: None, title: format!("{snaps} Time Machine snapshot{}", if snaps == 1 { "" } else { "s" }),
                detail: "Hidden safety copies Time Machine keeps on this Mac. macOS normally removes them when space runs low, but they can hold a lot.".into(),
                size: 0, group: "snapshots", safety: "guide", trashable: false,
                how_to: Some("Open Terminal and run: tmutil thinlocalsnapshots / 999999999999 4  (it's safe, it only removes the local copies, not your Time Machine backup drive).".into()),
            });
        }
        if volume_used > bytes + 2 * GB {
            system.push(Finding {
                id: "hidden".into(), path: None, title: "Space the app can't look inside".into(),
                detail: "Used space outside the folders Roomy can read: macOS itself, protected system areas, Time Machine snapshots, and folders that need Full Disk Access.".into(),
                size: volume_used - bytes, group: "hidden", safety: "guide", trashable: false,
                how_to: Some("Give Roomy Full Disk Access (button at the top of Overview) and scan again. What remains is mostly macOS itself and snapshots.".into()),
            });
        }

        big.sort_by(|a, b| b.size.cmp(&a.size));
        big.truncate(300);
        junk.sort_by(|a, b| b.size.cmp(&a.size));
        system.sort_by(|a, b| b.size.cmp(&a.size));
        let mut categories: Vec<Category> = cats.into_iter().map(|(key, bytes)| Category { key, bytes }).collect();
        categories.sort_by(|a, b| b.bytes.cmp(&a.bytes));

        ScanResult {
            finished_at: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
            duration_ms: started.elapsed().as_millis() as u64,
            cancelled,
            volume_total,
            volume_used,
            volume_free,
            scanned_bytes: bytes,
            file_count: files,
            unreadable,
            full_disk_access: has_full_disk_access(),
            categories,
            folders,
            big_files: big,
            junk,
            system,
            duplicates,
        }
    }

    fn find_duplicates(&self, candidates: HashMap<u64, Vec<(PathBuf, u64)>>) -> Vec<DupGroup> {
        let groups: Vec<(u64, Vec<(PathBuf, u64)>)> = candidates.into_iter().filter(|(_, v)| v.len() > 1).collect();
        let total: u64 = groups.iter().map(|(s, v)| s * v.len() as u64).sum();
        let done = AtomicU64::new(0);
        let last = Mutex::new(Instant::now());
        let tick = |n: u64, current: &Path| {
            let d = done.fetch_add(n, Ordering::Relaxed) + n;
            if let Ok(mut l) = last.try_lock() {
                if l.elapsed().as_millis() > 150 {
                    *l = Instant::now();
                    (self.emit)(Progress { phase: "duplicates", files: 0, bytes: 0, current: display_path(current), done: d, total });
                }
            }
        };

        let mut out: Vec<DupGroup> = groups
            .into_par_iter()
            .flat_map_iter(|(size, files)| {
                if self.cancel.load(Ordering::Relaxed) {
                    return Vec::new();
                }
                // Cheap pass: first + last 64 KB. Then a full hash for anything still matching.
                let mut by_partial: HashMap<[u8; 32], Vec<(PathBuf, u64)>> = HashMap::new();
                for (p, m) in files {
                    if let Some(hsh) = partial_hash(&p, size) {
                        by_partial.entry(hsh).or_default().push((p, m));
                    }
                }
                let mut result = Vec::new();
                for (_, same) in by_partial.into_iter().filter(|(_, v)| v.len() > 1) {
                    let mut by_full: HashMap<[u8; 32], Vec<(PathBuf, u64)>> = HashMap::new();
                    for (p, m) in same {
                        if self.cancel.load(Ordering::Relaxed) {
                            return Vec::new();
                        }
                        let hsh = if size <= 128 * 1024 { partial_hash(&p, size) } else { full_hash(&p) };
                        tick(size, &p);
                        if let Some(hsh) = hsh {
                            by_full.entry(hsh).or_default().push((p, m));
                        }
                    }
                    for (_, mut v) in by_full.into_iter().filter(|(_, v)| v.len() > 1) {
                        // Oldest first: it's most likely the original, and the UI keeps it by default.
                        v.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.as_os_str().len().cmp(&b.0.as_os_str().len())));
                        let files: Vec<FileItem> = v
                            .iter()
                            .map(|(p, m)| {
                                let dp = display_path(p);
                                let ext = ext_of(&p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
                                FileItem { trashable: can_trash(&dp), path: dp, size, modified: *m, kind: "file", category: category_for_ext(&ext).unwrap_or("other") }
                            })
                            .collect();
                        result.push(DupGroup { size, wasted: size * (files.len() as u64 - 1), files });
                    }
                }
                result
            })
            .collect();
        out.sort_by(|a, b| b.wasted.cmp(&a.wasted));
        out
    }
}

/// Big items worth showing: your own files, and apps in /Applications.
fn worth_listing(dp: &str) -> bool {
    dp.starts_with(&format!("{}/", home())) || (dp.starts_with("/Applications/") && dp.matches('/').count() <= 3)
}

/// Folders whose files belong to an app's project format. Removing a "duplicate"
/// in there would break a project, so we never offer it.
fn app_managed(dp: &str) -> bool {
    ["/CapCut/", "com.lveditor.draft", "/Final Cut", ".fcpcache", "/Render Files/", "/Ableton/", "/Logic/", "/.git/"]
        .iter()
        .any(|m| dp.contains(m))
}

fn to_finding(d: &Def, path: &str, size: u64) -> Finding {
    Finding {
        id: path.to_string(),
        path: Some(path.to_string()),
        title: d.title.clone(),
        detail: d.detail.to_string(),
        size,
        group: d.group,
        safety: d.safety,
        trashable: d.safety != "guide" && can_trash(path),
        how_to: d.how_to.map(|s| s.to_string()),
    }
}

fn partial_hash(p: &Path, size: u64) -> Option<[u8; 32]> {
    let mut f = File::open(p).ok()?;
    let mut hasher = blake3::Hasher::new();
    let chunk = 64 * 1024u64;
    let mut buf = vec![0u8; chunk.min(size) as usize];
    f.read_exact(&mut buf).ok()?;
    hasher.update(&buf);
    if size > chunk * 2 {
        f.seek(SeekFrom::End(-(chunk as i64))).ok()?;
        f.read_exact(&mut buf).ok()?;
        hasher.update(&buf);
    }
    Some(*hasher.finalize().as_bytes())
}

fn full_hash(p: &Path) -> Option<[u8; 32]> {
    let mut hasher = blake3::Hasher::new();
    hasher.update_mmap(p).ok()?;
    Some(*hasher.finalize().as_bytes())
}

fn local_snapshots() -> usize {
    std::process::Command::new("tmutil")
        .args(["listlocalsnapshots", "/"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().filter(|l| l.contains("com.apple")).count())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Read-only dry run over the real disk: `cargo test --release real_scan -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_scan() {
        let cancel = AtomicBool::new(false);
        let emit = |_p: Progress| {};
        let r = Scanner { cancel: &cancel, emit: &emit }.run();
        let g = |b: u64| format!("{:.1} GB", b as f64 / GB as f64);
        println!("took {} ms, files {}, scanned {}, used {}, unreadable {}, fda {}", r.duration_ms, r.file_count, g(r.scanned_bytes), g(r.volume_used), r.unreadable, r.full_disk_access);
        for c in &r.categories { println!("  cat {:10} {}", c.key, g(c.bytes)); }
        println!("-- top folders depth<=3");
        let mut f: Vec<_> = r.folders.iter().filter(|f| f.path.matches('/').count() <= 3).collect();
        f.sort_by(|a, b| b.size.cmp(&a.size));
        for x in f.iter().take(25) { println!("  {:>9} {}", g(x.size), x.path); }
        println!("-- big files"); for x in r.big_files.iter().take(15) { println!("  {:>9} {} {} {}", g(x.size), x.kind, x.trashable, x.path); }
        println!("-- junk ({})", r.junk.len()); for x in r.junk.iter().take(20) { println!("  {:>9} [{}] {} {} | {:?}", g(x.size), x.group, x.trashable, x.title, x.path); }
        println!("-- system"); for x in &r.system { println!("  {:>9} [{}] {} | {:?}", g(x.size), x.group, x.title, x.path); }
        println!("-- dups ({}) wasted {}", r.duplicates.len(), g(r.duplicates.iter().map(|d| d.wasted).sum()));
        for d in r.duplicates.iter().take(8) { println!("  {:>9} x{} {}", g(d.wasted), d.files.len(), d.files[0].path); }
        println!("json size {} KB", serde_json::to_vec(&r).unwrap().len() / 1024);
        if let Ok(out) = std::env::var("ROOMY_SCAN_OUT") {
            std::fs::write(out, serde_json::to_vec(&r).unwrap()).unwrap();
        }
    }
}
