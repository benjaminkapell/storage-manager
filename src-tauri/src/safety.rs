//! Rules for what Roomy is allowed to move to the Trash. The UI only offers
//! the button when `can_trash` says yes, and `trash_paths` checks again.

use std::path::Path;

pub fn home() -> String {
    dirs::home_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| "/Users/unknown".into())
}

/// "/System/Volumes/Data/Users/ben/x" -> "/Users/ben/x" (same file via firmlink).
pub fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    match s.strip_prefix("/System/Volumes/Data") {
        Some("") => "/".into(),
        Some(rest) if rest.starts_with('/') => rest.to_string(),
        _ => s.to_string(),
    }
}

/// Folders macOS shows as a single file. Never reach inside them.
pub fn is_package_ext(ext: &str) -> bool {
    matches!(
        ext,
        "app" | "photoslibrary" | "fcpbundle" | "logicx" | "musiclibrary" | "tvlibrary" | "imovielibrary"
            | "photolibrary" | "aplibrary" | "band" | "framework" | "bundle" | "plugin" | "kext" | "xcarchive"
            | "lrlibrary" | "cocatalog" | "dvdmedia" | "sparsebundle" | "rtfd" | "pages" | "key" | "numbers"
    )
}

/// Places inside ~/Library that only hold rebuildable or explicitly chosen items.
const LIBRARY_ALLOWED: &[&str] = &[
    "Library/Caches/",
    "Library/Logs",
    "Library/Developer/Xcode/DerivedData",
    "Library/Developer/Xcode/iOS DeviceSupport",
    "Library/Developer/Xcode/watchOS DeviceSupport",
    "Library/Developer/CoreSimulator/Caches",
    "Library/Application Support/MobileSync/Backup/",
    "Library/pnpm",
];

const PROTECTED: &[&str] = &[
    "", "Library", "Documents", "Desktop", "Downloads", "Pictures", "Movies", "Music", "Applications",
    "Public", ".Trash", "Library/Caches", "Library/Application Support", "Library/Developer",
    "Library/Application Support/MobileSync/Backup", "Library/Mobile Documents",
];

pub fn can_trash(path: &str) -> bool {
    let h = home();
    let Some(rel) = path.strip_prefix(&format!("{h}/")) else { return false };
    let rel = rel.trim_end_matches('/');
    if PROTECTED.contains(&rel) || rel.split('/').any(|c| c == "..") {
        return false;
    }
    if rel.starts_with(".Trash/") || rel.contains(".photoslibrary") {
        return false;
    }
    // Nothing *inside* an app or library bundle. The bundle itself is fine.
    let parts: Vec<&str> = rel.split('/').collect();
    for c in &parts[..parts.len().saturating_sub(1)] {
        if let Some(i) = c.rfind('.') {
            if i > 0 && is_package_ext(&c[i + 1..].to_ascii_lowercase()) {
                return false;
            }
        }
    }
    if rel.starts_with("Library/") || rel == "Library" {
        // A trailing "/" means "things inside it", otherwise the folder itself counts too.
        return LIBRARY_ALLOWED.iter().any(|a| match a.strip_suffix('/') {
            Some(_) => rel.starts_with(a),
            None => rel == *a || rel.starts_with(&format!("{a}/")),
        });
    }
    // Hidden folders at the top of home are mostly app settings. Allow only known developer caches.
    if rel.starts_with('.') {
        return [".npm", ".cache", ".cargo/registry", ".gradle/caches", ".bun/install/cache"].iter().any(|a| rel == *a || rel.starts_with(&format!("{a}/")))
            || parts.iter().any(|c| *c == "node_modules" || *c == "target" || *c == ".venv" || *c == "venv" || *c == "__pycache__");
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules() {
        let h = home();
        assert!(!can_trash("/System/Library/foo"));
        assert!(!can_trash("/Applications/Safari.app"));
        assert!(!can_trash(&h));
        assert!(!can_trash(&format!("{h}/Documents")));
        assert!(!can_trash(&format!("{h}/Library/Preferences/x.plist")));
        assert!(!can_trash(&format!("{h}/Library/Caches")));
        assert!(!can_trash(&format!("{h}/Pictures/Photos Library.photoslibrary")));
        assert!(!can_trash(&format!("{h}/Movies/Big.fcpbundle/inner/file.mov")));
        assert!(!can_trash(&format!("{h}/.ssh/id_ed25519")));
        assert!(can_trash(&format!("{h}/Movies/Big.fcpbundle")));
        assert!(can_trash(&format!("{h}/Library/Caches/com.spotify.client")));
        assert!(can_trash(&format!("{h}/Library/Logs")));
        assert!(can_trash(&format!("{h}/Library/Developer/Xcode/DerivedData")));
        assert!(can_trash(&format!("{h}/Downloads/movie.mp4")));
        assert!(can_trash(&format!("{h}/code/app/node_modules")));
        assert!(can_trash(&format!("{h}/.npm")));
    }
}
