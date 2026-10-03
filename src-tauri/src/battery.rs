//! Battery check: what drains the battery while the lid is closed, and what
//! burns it while the Mac is open. Everything comes from tools macOS already
//! ships (pmset, ps, lsof, system_profiler), so no special permission is needed.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Night {
    pub start: i64,
    pub end: i64,
    pub hours: f64,
    pub start_charge: Option<u32>,
    pub end_charge: Option<u32>,
    pub plugged_in: bool,
    /// Percent of battery lost per hour while asleep (None when plugged in).
    pub drain_per_hour: Option<f64>,
    pub wakes: u32,
    /// Share of the "sleep" that was actually spent awake in the background.
    pub awake_share: f64,
    pub top_reason: Option<String>,
    pub kept_awake_by: Vec<String>,
    /// Bluetooth audio device that kept playing to nothing while asleep.
    pub stuck_audio: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Action {
    /// Stop these processes (and their children).
    Stop { pids: Vec<i32> },
    /// Quit a normal app.
    Quit { app_path: String },
    /// Turn off Power Nap and network keep-alive on battery (asks for the password).
    FixSettings,
    /// Open a place in System Settings.
    Open { place: String },
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub label: String,
    pub detail: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// Stable id so the background check only notifies once per problem.
    pub id: String,
    /// "bad" | "warn" | "info"
    pub severity: String,
    pub title: String,
    pub detail: String,
    pub fix: String,
    pub items: Vec<Item>,
    pub action: Option<Action>,
    pub action_label: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatteryAudit {
    pub checked_at: i64,
    pub has_battery: bool,
    pub charge: Option<u32>,
    pub charging: bool,
    pub on_power: bool,
    pub max_capacity: Option<u32>,
    pub cycles: Option<u32>,
    pub health: Option<String>,
    pub uptime_days: f64,
    pub nights: Vec<Night>,
    pub findings: Vec<Finding>,
}

// ---------- small helpers ----------

fn run(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd).args(args).stderr(Stdio::null()).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// "2026-10-03 03:00:04 +0200" -> unix seconds.
fn parse_time(s: &str) -> Option<i64> {
    let n = |a: usize, b: usize| s.get(a..b)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0, 4)?, n(5, 7)?, n(8, 10)?, n(11, 13)?, n(14, 16)?, n(17, 19)?);
    let sign = if s.get(20..21)? == "-" { -1 } else { 1 };
    let off = sign * (n(21, 23)? * 3600 + n(23, 25)? * 60);
    Some(days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se - off)
}

fn charge_of(line: &str) -> Option<u32> {
    let i = line.find("Charge:")? + 7;
    let rest = &line[i..];
    rest[..rest.find('%')?].trim().parse().ok()
}

/// Trailing "45 secs" on a pmset line = how long that state lasted.
fn trailing_secs(line: &str) -> i64 {
    let t = line.trim_end();
    let Some(t) = t.strip_suffix("secs") else { return 0 };
    t.trim_end().rsplit(' ').next().and_then(|n| n.parse().ok()).unwrap_or(0)
}

fn wake_reason(line: &str) -> String {
    let l = line.to_lowercase();
    if l.contains("bluetooth") || l.contains("wifibt") {
        "Bluetooth or Wi-Fi".into()
    } else if l.contains("rtc") || l.contains("maintenance") || l.contains("sleepservice") {
        "Scheduled macOS background jobs".into()
    } else if l.contains("usb") || l.contains("thunderbolt") {
        "A plugged-in accessory".into()
    } else if l.contains("notification") {
        "A notification (call or message)".into()
    } else {
        "Something inside macOS".into()
    }
}

fn friendly_process(p: &str) -> Option<String> {
    Some(match p {
        "AddressBookSourceSync" | "contactsd" | "AddressBookManager" => "Contacts sync",
        "bluetoothd" => "Bluetooth",
        "coreaudiod" => "Audio",
        "apsd" => "Apple push notifications",
        "sharingd" => "AirDrop / Handoff",
        "mds" | "mds_stores" | "mdworker" | "mdworker_shared" => "Spotlight search indexing",
        "photoanalysisd" | "photolibraryd" => "Photos analysis",
        "cloudd" | "bird" => "iCloud sync",
        "backupd" => "Time Machine",
        "softwareupdated" => "Software Update",
        "powerd" | "mDNSResponder" | "kernel_task" | "runningboardd" | "dasd" | "PowerUIAgent" => return None,
        other => other,
    }.to_string())
}

// ---------- the sleep log ----------

#[derive(Default)]
struct Open {
    start: i64,
    start_charge: Option<u32>,
    /// Last moment (and charge) seen on battery, before any charger was connected.
    on_batt: Option<(i64, u32)>,
    plugged: bool,
    wakes: u32,
    awake: i64,
    reasons: HashMap<String, u32>,
    keepers: HashMap<String, u32>,
    audio_mac: Option<String>,
}

impl Open {
    fn track(&mut self, t: i64, line: &str) {
        if line.contains("Using AC") {
            self.plugged = true;
        } else if !self.plugged {
            if let Some(c) = charge_of(line) { self.on_batt = Some((t, c)); }
        }
    }
}

fn audio_mac(line: &str) -> Option<String> {
    let i = line.find("com.apple.audio.")? + 16;
    let mac = line.get(i..i + 17)?;
    let ok = mac.chars().enumerate().all(|(k, c)| if k % 3 == 2 { c == '-' || c == ':' } else { c.is_ascii_hexdigit() });
    (ok && line[i + 17..].starts_with(":output")).then(|| mac.replace('-', ":"))
}

/// Walk `pmset -g log` and cut it into lid-closed periods ("nights").
pub fn nights() -> Vec<Night> {
    let Ok(mut child) = Command::new("pmset").args(["-g", "log"]).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else { return vec![] };
    let Some(out) = child.stdout.take() else { return vec![] };
    let mut done: Vec<Night> = vec![];
    let mut open: Option<Open> = None;

    for line in BufReader::new(out).lines().map_while(Result::ok) {
        if line.len() < 30 || !line.as_bytes()[0].is_ascii_digit() {
            continue;
        }
        let kind = line.get(26..46).unwrap_or("").trim_end();
        let Some(t) = parse_time(&line) else { continue };
        match kind {
            "Sleep" => {
                let o = open.get_or_insert_with(|| Open { start: t, start_charge: charge_of(&line), plugged: line.contains("Using AC"), ..Default::default() });
                o.track(t, &line);
            }
            "DarkWake" => {
                if let Some(o) = open.as_mut() {
                    o.wakes += 1;
                    o.awake += trailing_secs(&line);
                    *o.reasons.entry(wake_reason(&line)).or_default() += 1;
                    o.track(t, &line);
                }
            }
            "Wake" => {
                let by_user = ["lid", "pwrbtn", "UserActivity", "HID"].iter().any(|k| line.contains(k));
                if let Some(o) = open.as_mut() {
                    o.track(t, &line);
                    if !by_user {
                        o.wakes += 1;
                        *o.reasons.entry(wake_reason(&line)).or_default() += 1;
                        continue;
                    }
                }
                if let Some(o) = open.take() {
                    done.push(finish(o, t));
                }
            }
            "Assertions" => {
                let Some(o) = open.as_mut() else { continue };
                if let Some(mac) = audio_mac(&line) { o.audio_mac = Some(mac); }
                if !line.contains(" Released ") { continue; }
                // "PID 69923(AddressBookSourceSync) Created ..."
                if let (Some(a), Some(b)) = (line.find('('), line.find(')')) {
                    if a < b {
                        if let Some(n) = friendly_process(&line[a + 1..b]) {
                            *o.keepers.entry(n).or_default() += 1;
                        }
                    }
                }
            }
            _ => {}
        }
    }
    let _ = child.wait();
    if let Some(o) = open.take() {
        let t = now();
        if t - o.start > 3600 { done.push(finish(o, t)); }
    }
    let mut nights: Vec<Night> = done.into_iter().filter(|n| n.hours >= 1.0).collect();
    nights.reverse();
    nights.truncate(10);
    // Name Bluetooth headphones that held audio open.
    if nights.iter().any(|n| n.stuck_audio.is_some()) {
        let names = bluetooth_names();
        for n in nights.iter_mut() {
            if let Some(mac) = &n.stuck_audio {
                n.stuck_audio = Some(names.get(&mac.to_uppercase()).cloned().unwrap_or_else(|| "Bluetooth headphones or a speaker".into()));
            }
        }
    }
    nights
}

fn finish(o: Open, end: i64) -> Night {
    let secs = (end - o.start).max(1);
    let hours = secs as f64 / 3600.0;
    // Measure only the time on battery: stop at the moment a charger was connected.
    let (drain, end_charge) = match (o.start_charge, o.on_batt) {
        (Some(a), Some((t, b))) if (t - o.start) as f64 >= 3600.0 => (Some((a as f64 - b as f64).max(0.0) / ((t - o.start) as f64 / 3600.0)), Some(b)),
        (_, Some((_, b))) => (None, Some(b)),
        _ => (None, None),
    };
    fn top(m: &HashMap<String, u32>) -> Vec<(&String, &u32)> {
        let mut v: Vec<_> = m.iter().collect();
        v.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
        v
    }
    Night {
        start: o.start,
        end,
        hours,
        start_charge: o.start_charge,
        end_charge,
        plugged_in: drain.is_none(),
        drain_per_hour: drain,
        wakes: o.wakes,
        awake_share: (o.awake as f64 / secs as f64).min(1.0),
        top_reason: top(&o.reasons).first().map(|(k, _)| (*k).clone()),
        kept_awake_by: top(&o.keepers).into_iter().filter(|(_, n)| **n >= 10).take(3).map(|(k, _)| k.clone()).collect(),
        stuck_audio: o.audio_mac,
    }
}

fn bluetooth_names() -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&run("system_profiler", &["SPBluetoothDataType", "-json"])) else { return out };
    fn walk(v: &serde_json::Value, out: &mut HashMap<String, String>) {
        match v {
            serde_json::Value::Object(m) => {
                for (k, val) in m {
                    if let Some(addr) = val.get("device_address").and_then(|a| a.as_str()) {
                        out.insert(addr.to_uppercase(), k.clone());
                    }
                    walk(val, out);
                }
            }
            serde_json::Value::Array(a) => a.iter().for_each(|x| walk(x, out)),
            _ => {}
        }
    }
    walk(&v, &mut out);
    out
}

// ---------- what's running now ----------

struct Proc {
    pid: i32,
    ppid: i32,
    uid: u32,
    cpu: f64,
    cpu_secs: i64,
    age_secs: i64,
    tty: bool,
    /// Executable name as macOS reports it ("node", "Python", "claude", "fseventsd").
    name: String,
    command: String,
}

fn hms(s: &str) -> i64 {
    // ps time formats: "[[dd-]hh:]mm:ss[.cc]"
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse::<i64>().unwrap_or(0), r),
        None => (0, s),
    };
    let rest = rest.split('.').next().unwrap_or("");
    let parts: Vec<i64> = rest.split(':').map(|p| p.parse().unwrap_or(0)).collect();
    let secs = parts.iter().fold(0, |acc, p| acc * 60 + p);
    days * 86400 + secs
}

fn processes() -> Vec<Proc> {
    // `comm` is the real executable (may contain spaces), `command` the full command line.
    let names: HashMap<i32, String> = run("ps", &["-Axo", "pid=,comm="])
        .lines()
        .filter_map(|l| {
            let (pid, comm) = l.trim_start().split_once(' ')?;
            let comm = comm.trim();
            Some((pid.parse().ok()?, comm.rsplit('/').next().unwrap_or(comm).to_string()))
        })
        .collect();
    run("ps", &["-Axo", "pid=,ppid=,uid=,pcpu=,time=,etime=,tty=,command="])
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let pid = it.next()?.parse().ok()?;
            let ppid = it.next()?.parse().ok()?;
            let uid = it.next()?.parse().ok()?;
            let cpu = it.next()?.parse().ok()?;
            let cpu_secs = hms(it.next()?);
            let age_secs = hms(it.next()?);
            let tty = it.next()? != "??";
            let command = it.collect::<Vec<_>>().join(" ");
            let name = names.get(&pid).cloned().unwrap_or_default();
            Some(Proc { pid, ppid, uid, cpu, cpu_secs, age_secs, tty, name, command })
        })
        .collect()
}

fn outer_app(cmd: &str) -> Option<String> {
    cmd.find(".app/").map(|i| cmd[..i + 4].to_string()).filter(|p| p.starts_with('/'))
}

fn cwd_of(pid: i32) -> Option<String> {
    run("lsof", &["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"]).lines().find_map(|l| l.strip_prefix('n').map(String::from))
}

fn days(secs: i64) -> String {
    let d = secs / 86400;
    if d >= 1 { format!("{d} day{}", if d > 1 { "s" } else { "" }) } else { format!("{} hours", (secs / 3600).max(1)) }
}

fn short_path(p: &str) -> String {
    let home = crate::safety::home();
    if p.starts_with(&home) { format!("~{}", &p[home.len()..]) } else { p.to_string() }
}

const SERVER_TOOLS: &[&str] = &["node", "next-server", "python", "Python", "ruby", "bun", "deno", "php", "java"];

fn is_server_tool(p: &Proc) -> bool {
    SERVER_TOOLS.iter().any(|t| p.name.starts_with(t))
}

pub fn my_uid() -> u32 {
    unsafe { libc::getuid() }
}

/// Only these may be stopped from Roomy: the user's own dev tools and Claude sessions.
pub fn may_stop(pid: i32) -> bool {
    let me = my_uid();
    processes().iter().any(|p| p.pid == pid && p.uid == me && (is_server_tool(p) || p.name.starts_with("npm") || p.name == "claude"))
}

pub fn stop(pids: &[i32]) -> Vec<i32> {
    let all = processes();
    let mut stopped = vec![];
    for &pid in pids {
        if pid <= 1 || !may_stop(pid) {
            continue;
        }
        // Children first (vite's esbuild, next's workers), then the process itself.
        for c in all.iter().filter(|p| p.ppid == pid) {
            unsafe { libc::kill(c.pid, libc::SIGTERM) };
        }
        if unsafe { libc::kill(pid, libc::SIGTERM) } == 0 {
            stopped.push(pid);
        }
    }
    stopped
}

fn pmset_battery_settings() -> HashMap<String, String> {
    let out = run("pmset", &["-g", "custom"]);
    let mut in_batt = false;
    let mut m = HashMap::new();
    for l in out.lines() {
        if l.starts_with("Battery Power") { in_batt = true; continue; }
        if l.starts_with("AC Power") { in_batt = false; continue; }
        if in_batt {
            let mut it = l.split_whitespace();
            if let (Some(k), Some(v)) = (it.next(), it.next()) { m.insert(k.to_string(), v.to_string()); }
        }
    }
    m
}

fn uptime_secs() -> i64 {
    sysinfo::System::uptime() as i64
}

// ---------- the audit ----------

pub fn audit() -> BatteryAudit {
    let power: serde_json::Value = serde_json::from_str(&run("system_profiler", &["SPPowerDataType", "-json"])).unwrap_or_default();
    let info = power["SPPowerDataType"].as_array().and_then(|a| a.iter().find(|x| x["_name"] == "spbattery_information")).cloned();
    let has_battery = info.is_some();
    let info = info.unwrap_or_default();
    let charge_info = &info["sppower_battery_charge_info"];
    let health_info = &info["sppower_battery_health_info"];
    let batt = run("pmset", &["-g", "batt"]);

    let nights = if has_battery { nights() } else { vec![] };
    let mut findings = vec![];

    // 1. Battery lost while the lid was closed.
    if let Some(n) = nights.iter().find(|n| n.drain_per_hour.is_some()) {
        let rate = n.drain_per_hour.unwrap_or(0.0);
        let lost = n.start_charge.unwrap_or(0).saturating_sub(n.end_charge.unwrap_or(0));
        if rate >= 1.5 && lost >= 5 {
            let mut why = vec![];
            if let Some(dev) = &n.stuck_audio {
                why.push(Item { label: format!("{dev} kept an audio connection open"), detail: "Bluetooth audio that never closed. Your Mac kept waking up to look after it.".into() });
            }
            if let Some(r) = &n.top_reason {
                why.push(Item { label: format!("Most wake-ups came from: {r}"), detail: format!("{} wake-ups, about {} an hour", n.wakes, (n.wakes as f64 / n.hours).round()) });
            }
            for k in &n.kept_awake_by {
                why.push(Item { label: format!("{k} kept it awake"), detail: "Running again and again while the lid was closed".into() });
            }
            let fix = if n.stuck_audio.is_some() || n.top_reason.as_deref() == Some("Bluetooth or Wi-Fi") {
                "Before you close the lid, disconnect your headphones (or switch Bluetooth off in Control Center). If it keeps happening, remove the headphones in Bluetooth settings and pair them again."
            } else {
                "Restart your Mac, and turn off Power Nap below. If it keeps happening, quit apps before closing the lid."
            };
            findings.push(Finding {
                id: format!("sleep-drain:{}", n.start),
                severity: if rate >= 3.0 { "bad" } else { "warn" }.into(),
                title: format!("Lost {lost}% while the lid was closed"),
                detail: format!(
                    "Over {:.0} hours asleep your Mac used {:.1}% an hour. A healthy Mac uses well under 1% an hour asleep. It woke up {} times and was really awake {:.0}% of that time.",
                    n.hours, rate, n.wakes, n.awake_share * 100.0
                ),
                fix: fix.into(),
                items: why,
                action: Some(Action::Open { place: "bluetooth".into() }),
                action_label: Some("Bluetooth settings".into()),
            });
        }
    }

    let procs = processes();
    let me = my_uid();

    // 2. Things using lots of power right now / for a long time.
    let mut hogs: BTreeMap<String, (f64, i64, Option<String>)> = BTreeMap::new();
    for p in &procs {
        let avg = if p.age_secs > 0 { p.cpu_secs as f64 / p.age_secs as f64 * 100.0 } else { 0.0 };
        let sustained = (p.cpu >= 40.0 && p.age_secs > 1800) || (avg >= 15.0 && p.age_secs > 6 * 3600);
        if !sustained { continue; }
        let name = p.name.clone();
        if name == "kernel_task" || name == "WindowServer" || name == "top" || name == "ps" { continue; }
        let app = outer_app(&p.command).filter(|a| !a.starts_with("/System/"));
        let label = match &app {
            Some(a) => a.rsplit('/').next().unwrap_or(a).trim_end_matches(".app").to_string(),
            None => match name.as_str() {
                "fseventsd" => "File change tracker (part of macOS)".into(),
                "contactsd" | "AddressBookManager" | "AddressBookSourceSync" => "Contacts sync (part of macOS)".into(),
                "mds" | "mds_stores" | "mdworker_shared" => "Spotlight search indexing (part of macOS)".into(),
                "photoanalysisd" => "Photos analysis (part of macOS)".into(),
                "mobileassetd" => "macOS downloading system files".into(),
                n => n.into(),
            },
        };
        let e = hogs.entry(label).or_insert((0.0, 0, app));
        e.0 = e.0.max(p.cpu.max(avg));
        e.1 = e.1.max(p.age_secs);
    }
    if !hogs.is_empty() {
        let mut v: Vec<_> = hogs.into_iter().collect();
        v.sort_by(|a, b| b.1 .0.partial_cmp(&a.1 .0).unwrap_or(std::cmp::Ordering::Equal));
        let any_system = v.iter().any(|(_, (_, _, app))| app.is_none());
        let single_app = if v.len() == 1 { v[0].1 .2.clone() } else { None };
        findings.push(Finding {
            id: format!("hogs:{}", v.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(",")),
            severity: if v.iter().any(|(_, (c, _, _))| *c >= 60.0) { "bad" } else { "warn" }.into(),
            title: if v.len() == 1 { format!("{} is working non-stop", v[0].0) } else { format!("{} things are working non-stop", v.len()) },
            detail: "These keep the processor busy all the time, which drains the battery and warms up your Mac even when you're not doing anything.".into(),
            fix: if any_system {
                "Parts of macOS stuck like this almost always calm down after a restart. Save your work and restart.".into()
            } else {
                "Quit the app and open it again.".into()
            },
            items: v.iter().map(|(k, (c, age, _))| Item { label: k.clone(), detail: format!("{}, running for {}", if *c >= 95.0 { "Keeps a whole processor core busy".to_string() } else { format!("About {c:.0}% of one processor core") }, days(*age)) }).collect(),
            action: single_app.map(|a| Action::Quit { app_path: a }),
            action_label: None,
        });
    }

    // 3. Forgotten dev servers (node/python/... listening on a port for over a day).
    let mut ports: HashMap<i32, Vec<String>> = HashMap::new();
    let mut cur = 0;
    for l in run("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]).lines() {
        if let Some(p) = l.strip_prefix('p') { cur = p.parse().unwrap_or(0); }
        if let Some(n) = l.strip_prefix('n') {
            let port = n.rsplit(':').next().unwrap_or("").to_string();
            let v = ports.entry(cur).or_default();
            if !v.contains(&port) { v.push(port); }
        }
    }
    // Jobs launchd keeps alive on purpose (they'd just come back).
    let managed: Vec<i32> = run("launchctl", &["list"]).lines().filter_map(|l| l.split_whitespace().next()?.parse().ok()).collect();
    let by_pid: HashMap<i32, &Proc> = procs.iter().map(|p| (p.pid, p)).collect();
    let mut servers: Vec<(i32, i64, String)> = vec![];
    for p in procs.iter().filter(|p| p.uid == me && ports.contains_key(&p.pid) && p.age_secs > 86400) {
        // Skip tools that live inside a normal app (Claude, ChatGPT ship their own node).
        if !is_server_tool(p) || (p.command.contains(".app/") && !p.name.starts_with("Python")) { continue; }
        // Climb to the npm/node launcher ("npm run dev" > "next dev" > next-server) so stopping it stops everything.
        let mut root = p;
        while let Some(parent) = by_pid.get(&root.ppid) {
            if parent.pid <= 1 || parent.uid != me || !(parent.name.starts_with("npm") || parent.name == "node") { break; }
            root = parent;
        }
        if managed.contains(&root.pid) || servers.iter().any(|s| s.0 == root.pid) { continue; }
        let place = cwd_of(p.pid).map(|c| short_path(&c)).unwrap_or_else(|| p.name.clone());
        let place = match ports.get(&p.pid) { Some(v) if !v.is_empty() => format!("{place}  (port {})", v.join(", ")), _ => place };
        servers.push((root.pid, p.age_secs, place));
    }
    if !servers.is_empty() {
        servers.sort_by(|a, b| b.1.cmp(&a.1));
        findings.push(Finding {
            id: format!("servers:{}", servers.len()),
            severity: if servers.len() >= 3 { "warn" } else { "info" }.into(),
            title: format!("{} coding project{} still running in the background", servers.len(), if servers.len() > 1 { "s" } else { "" }),
            detail: "Preview servers from coding sessions keep running after you're done. Each one watches your files and wakes your Mac up for nothing.".into(),
            fix: "Stop the ones you're not using. Nothing is deleted. You can start them again any time.".into(),
            items: servers.iter().map(|(_, age, place)| Item { label: place.clone(), detail: format!("Running for {}", days(*age)) }).collect(),
            action: Some(Action::Stop { pids: servers.iter().map(|s| s.0).collect() }),
            action_label: Some("Stop all".into()),
        });
    }

    // 4. Old Claude Code sessions left open in Terminal.
    let mine_parent: Vec<i32> = { let s = std::process::id() as i32; procs.iter().filter(|p| p.pid == s).map(|p| p.ppid).collect() };
    let old: Vec<&Proc> = procs
        .iter()
        .filter(|p| p.uid == me && p.tty && p.age_secs > 3 * 86400 && p.name == "claude" && !p.command.contains("--bg-") && !mine_parent.contains(&p.pid))
        .collect();
    if old.len() >= 2 {
        let oldest = old.iter().map(|p| p.age_secs).max().unwrap_or(0);
        findings.push(Finding {
            id: format!("claude:{}", old.len()),
            severity: if old.len() >= 5 { "warn" } else { "info" }.into(),
            title: format!("{} old Claude Code sessions are still open", old.len()),
            detail: format!("Some have been open for {}. Each keeps memory busy and wakes up now and then.", days(oldest)),
            fix: "Stop them. Conversations are saved, and you can pick one up again with \"claude \u{2011}\u{2011}resume\".".into(),
            items: vec![],
            action: Some(Action::Stop { pids: old.iter().map(|p| p.pid).collect() }),
            action_label: Some("Stop old sessions".into()),
        });
    }

    // 5. Settings that wake the Mac while asleep.
    let s = pmset_battery_settings();
    let nap = s.get("powernap").map(|v| v == "1").unwrap_or(false);
    let keep = s.get("tcpkeepalive").map(|v| v == "1").unwrap_or(false);
    if has_battery && (nap || keep) {
        let mut items = vec![];
        if nap { items.push(Item { label: "Power Nap is on".into(), detail: "Your Mac wakes up about every 15 minutes while asleep to check mail and run background jobs".into() }); }
        if keep { items.push(Item { label: "Network stays connected while asleep".into(), detail: "Gives Wi-Fi and Bluetooth more reasons to wake your Mac".into() }); }
        findings.push(Finding {
            id: "settings".into(),
            severity: "info".into(),
            title: "Sleep settings allow extra wake-ups on battery".into(),
            detail: "These only change what happens on battery. When it's plugged in, nothing changes.".into(),
            fix: "Turn them off on battery. macOS will ask for your password once.".into(),
            items,
            action: Some(Action::FixSettings),
            action_label: Some("Turn off on battery".into()),
        });
    }

    // 6. No restart for a long time.
    let up = uptime_secs();
    if up > 14 * 86400 {
        findings.push(Finding {
            id: "uptime".into(),
            severity: "warn".into(),
            title: format!("No restart in {}", days(up)),
            detail: "Little parts of macOS get stuck over time and quietly burn battery. A restart clears them all.".into(),
            fix: "Save your work and restart (Apple menu > Restart).".into(),
            items: vec![],
            action: None,
            action_label: None,
        });
    }

    let order = |s: &str| match s { "bad" => 0, "warn" => 1, _ => 2 };
    findings.sort_by_key(|f| order(&f.severity));

    BatteryAudit {
        checked_at: now(),
        has_battery,
        charge: charge_info["sppower_battery_state_of_charge"].as_u64().map(|v| v as u32),
        charging: charge_info["sppower_battery_is_charging"] == "TRUE",
        on_power: batt.contains("AC Power"),
        max_capacity: health_info["sppower_battery_health_maximum_capacity"].as_str().and_then(|s| s.trim_end_matches('%').trim().parse().ok()),
        cycles: health_info["sppower_battery_cycle_count"].as_u64().map(|v| v as u32),
        health: health_info["sppower_battery_health"].as_str().map(String::from),
        uptime_days: up as f64 / 86400.0,
        nights,
        findings,
    }
}

pub fn fix_settings() -> Result<(), String> {
    let out = Command::new("osascript")
        .args(["-e", "do shell script \"/usr/bin/pmset -b powernap 0 tcpkeepalive 0\" with administrator privileges with prompt \"Roomy wants to turn off Power Nap and network keep-alive on battery.\""])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err("Nothing changed. The password window was closed.".into()) }
}

// ---------- automatic check ----------

pub const AGENT_LABEL: &str = "app.roomy.battery-check";

fn data_dir() -> std::path::PathBuf {
    let d = dirs::data_dir().unwrap_or_else(|| std::path::PathBuf::from("/tmp")).join("app.roomy.storage");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn agent_path() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_default().join("Library/LaunchAgents").join(format!("{AGENT_LABEL}.plist"))
}

pub fn last_audit() -> Option<BatteryAudit> {
    serde_json::from_slice(&std::fs::read(data_dir().join("battery-last.json")).ok()?).ok()
}

pub fn save_audit(a: &BatteryAudit) {
    if let Ok(j) = serde_json::to_vec(a) { let _ = std::fs::write(data_dir().join("battery-last.json"), j); }
}

pub fn auto_check_enabled() -> bool {
    agent_path().exists()
}

pub fn set_auto_check(on: bool) -> Result<(), String> {
    let path = agent_path();
    let domain = format!("gui/{}", my_uid());
    let _ = Command::new("launchctl").args(["bootout", &format!("{domain}/{AGENT_LABEL}")]).output();
    if !on {
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::write(data_dir().join("battery-auto-off"), b"1");
        return Ok(());
    }
    let _ = std::fs::remove_file(data_dir().join("battery-auto-off"));
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.to_string_lossy().replace('&', "&amp;").replace('<', "&lt;");
    let times: String = [9, 14, 20].iter().map(|h| format!("<dict><key>Hour</key><integer>{h}</integer><key>Minute</key><integer>0</integer></dict>")).collect();
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>{AGENT_LABEL}</string>
  <key>ProgramArguments</key><array><string>{exe}</string><string>--battery-check</string></array>
  <key>StartCalendarInterval</key><array>{times}</array>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
</dict></plist>
"#
    );
    if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
    std::fs::write(&path, plist).map_err(|e| e.to_string())?;
    let out = Command::new("launchctl").args(["bootstrap", &domain, &path.to_string_lossy()]).output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}

/// Turn the automatic check on the first time Roomy runs (unless it was switched off),
/// and keep the agent pointing at the current app location.
pub fn ensure_auto_check() {
    if data_dir().join("battery-auto-off").exists() { return; }
    let exe = std::env::current_exe().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
    // Don't install from a development build.
    if !exe.contains(".app/") { return; }
    let current = std::fs::read_to_string(agent_path()).unwrap_or_default();
    if !current.contains(&exe) { let _ = set_auto_check(true); }
}

fn notify(title: &str, body: &str) {
    let _ = mac_notification_sys::set_application("app.roomy.storage");
    if mac_notification_sys::send_notification(title, None, body, None).is_err() {
        let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
        let _ = Command::new("osascript").args(["-e", &format!("display notification \"{}\" with title \"{}\"", esc(body), esc(title))]).output();
    }
}

/// Runs headless from launchd: check, remember, and notify only about new problems.
pub fn background_check() {
    let a = audit();
    save_audit(&a);
    let state_file = data_dir().join("battery-notified.json");
    let mut seen: HashMap<String, i64> = std::fs::read(&state_file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let t = now();
    seen.retain(|_, at| t - *at < 30 * 86400);
    // Same problem again: remind after 3 days at most.
    let fresh: Vec<&Finding> = a
        .findings
        .iter()
        .filter(|f| f.severity != "info" && seen.get(&f.id).map(|at| t - at > 3 * 86400).unwrap_or(true))
        .collect();
    if let Some(first) = fresh.first() {
        let body = if fresh.len() > 1 { format!("{} and {} more. Open Roomy > Battery to fix it.", first.title, fresh.len() - 1) } else { format!("{} Open Roomy > Battery to fix it.", first.title) };
        notify("Your battery is draining", &body);
        for f in fresh { seen.insert(f.id.clone(), t); }
    }
    if let Ok(j) = serde_json::to_vec(&seen) { let _ = std::fs::write(state_file, j); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_times_and_fields() {
        let l = "2026-10-03 03:00:04 +0200 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to SMC.OutboxNotEmpty smc.70070000 wifibt bluetooth-pcie/ Using BATT (Charge:57%) 45 secs   ";
        assert_eq!(parse_time(l), Some(1790989204));
        assert_eq!(charge_of(l), Some(57));
        assert_eq!(trailing_secs(l), 45);
        assert_eq!(wake_reason(l), "Bluetooth or Wi-Fi");
        assert_eq!(l.get(26..46).unwrap().trim_end(), "DarkWake");
        assert_eq!(audio_mac("PID 191(coreaudiod) TurnedOff PreventUserIdleSystemSleep \"com.apple.audio.68-F2-1F-61-B0-29:output.context\""), Some("68:F2:1F:61:B0:29".into()));
        assert_eq!(hms("38-19:34:06"), 38 * 86400 + 19 * 3600 + 34 * 60 + 6);
        assert_eq!(hms("896:22.49"), 896 * 60 + 22);
    }

    #[test]
    #[ignore]
    fn real_audit() {
        let a = audit();
        println!("{}", serde_json::to_string_pretty(&a).unwrap());
    }
}
