//! Looking inside Google Chrome: how its memory splits across tabs, extensions and
//! Chrome itself (from process command lines), plus a per-tab list via AppleScript.

use serde::Serialize;
use std::process::Command;
use sysinfo::System;

const CHROME_APP: &str = "/Google Chrome.app/";

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChromeBreakdown {
    pub running: bool,
    pub total: u64,
    pub tabs: u64,
    pub tab_processes: u32,
    pub extensions: u64,
    pub extension_processes: u32,
    pub graphics: u64,
    pub browser: u64,
    pub helpers: u64,
}

/// Uses the process list already refreshed by `memory::snapshot` (with command lines).
pub fn breakdown(sys: &System) -> ChromeBreakdown {
    let mut b = ChromeBreakdown::default();
    for p in sys.processes().values() {
        let Some(exe) = p.exe().map(|e| e.to_string_lossy().to_string()) else { continue };
        if !exe.contains(CHROME_APP) {
            continue;
        }
        b.running = true;
        let cmd: Vec<String> = p.cmd().iter().map(|a| a.to_string_lossy().to_string()).collect();
        let has = |flag: &str| cmd.iter().any(|a| a == flag || a.starts_with(&format!("{flag}=")));
        let kind = cmd.iter().find_map(|a| a.strip_prefix("--type=")).unwrap_or("");
        let mem = p.memory();
        b.total += mem;
        match kind {
            "renderer" if has("--extension-process") => { b.extensions += mem; b.extension_processes += 1; }
            "renderer" => { b.tabs += mem; b.tab_processes += 1; }
            "gpu-process" => b.graphics += mem,
            "" => b.browser += mem,
            _ => b.helpers += mem,
        }
    }
    b
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub id: String,
    pub window: u32,
    pub title: String,
    pub url: String,
    /// JavaScript memory the page reports, when Chrome allows asking.
    pub memory: Option<u64>,
    /// "measured" | "sleeping" (Chrome's Memory Saver unloaded it) | "unknown"
    pub state: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabList {
    /// false when Chrome's "Allow JavaScript from Apple Events" is off.
    pub can_measure: bool,
    pub tabs: Vec<Tab>,
}

const FIELD: char = '\u{1f}';
const ROW: char = '\u{1e}';

// One pass over every normal window. Once Chrome says JavaScript from Apple Events
// is off we stop asking, so listing stays fast.
const LIST_SCRIPT: &str = r#"
on run
  set US to (ASCII character 31)
  set RS to (ASCII character 30)
  set out to ""
  set allowed to true
  tell application "Google Chrome"
    set wi to 0
    repeat with w in windows
      set wi to wi + 1
      if mode of w is not "incognito" then
        repeat with t in tabs of w
          set m to "unknown"
          if allowed then
            try
              with timeout of 4 seconds
                set r to execute t javascript "(performance.memory ? performance.memory.totalJSHeapSize : -1) + ''"
              end timeout
              if r is missing value then
                set m to "sleeping"
              else
                set m to r
              end if
            on error errMsg
              if errMsg contains "turned off" or errMsg contains "Apple Events" then
                set allowed to false
                set m to "blocked"
              end if
            end try
          end if
          set out to out & wi & US & (id of t) & US & (title of t) & US & (URL of t) & US & m & RS
        end repeat
      end if
    end repeat
  end tell
  return out
end run
"#;

fn run_script(script: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("osascript");
    cmd.arg("-e").arg(script);
    for a in args {
        cmd.arg(a);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).trim_end_matches('\n').to_string());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    if err.contains("-1743") || err.contains("Not authorized") {
        Err("not-allowed".into())
    } else if err.contains("-600") || err.contains("isn\u{2019}t running") || err.contains("isn't running") {
        Err("not-running".into())
    } else {
        Err(err.trim().to_string())
    }
}

pub fn list_tabs() -> Result<TabList, String> {
    let raw = run_script(LIST_SCRIPT, &[])?;
    let mut can_measure = true;
    let mut tabs = Vec::new();
    for row in raw.split(ROW).filter(|r| !r.trim().is_empty()) {
        let f: Vec<&str> = row.split(FIELD).collect();
        if f.len() < 5 {
            continue;
        }
        let m = f[4].trim();
        let (memory, state) = match m {
            "sleeping" => (None, "sleeping"),
            "blocked" | "unknown" => {
                if m == "blocked" {
                    can_measure = false;
                }
                (None, "unknown")
            }
            v => match v.parse::<i64>() {
                Ok(n) if n >= 0 => (Some(n as u64), "measured"),
                _ => (None, "unknown"),
            },
        };
        tabs.push(Tab {
            window: f[0].trim().parse().unwrap_or(0),
            id: f[1].trim().to_string(),
            title: f[2].to_string(),
            url: f[3].to_string(),
            memory,
            state,
        });
    }
    if tabs.iter().all(|t| t.state == "unknown") && !tabs.is_empty() {
        can_measure = false;
    }
    Ok(TabList { can_measure, tabs })
}

/// "show" brings the tab to the front, "close" closes it (Chrome can reopen it with Cmd+Shift+T).
pub fn tab_action(id: &str, action: &str) -> Result<(), String> {
    if !id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Unknown tab".into());
    }
    let script = match action {
        "close" => r#"
on run argv
  set tid to (item 1 of argv) as integer
  tell application "Google Chrome"
    repeat with w in windows
      repeat with t in tabs of w
        if id of t is tid then
          close t
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "gone"
end run"#,
        "show" => r#"
on run argv
  set tid to (item 1 of argv) as integer
  tell application "Google Chrome"
    repeat with w in windows
      set i to 0
      repeat with t in tabs of w
        set i to i + 1
        if id of t is tid then
          set active tab index of w to i
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "gone"
end run"#,
        _ => return Err("Unknown action".into()),
    };
    run_script(script, &[id]).map(|_| ())
}
