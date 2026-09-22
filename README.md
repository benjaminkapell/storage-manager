# Roomy

A local Mac app that shows where your storage and memory went, in plain language.

- **Overview**: free space, what kind of files fill the disk, quick wins
- **Where it went**: every folder, biggest first, click to drill in
- **Clean-up**: app caches, coding leftovers (node_modules, Rust `target`, `.venv`, npm/pip caches, Xcode), old installers, logs
- **Duplicates**: byte-identical copies (BLAKE3), always keeps at least one
- **Big files**: everything over 200 MB plus your largest apps
- **System data**: Photos, iPhone backups, Messages, Mail, app data, Docker, temp files, swap, Time Machine snapshots, each with "how to shrink it" steps
- **Memory**: memory pressure, swap, uptime, top apps with a polite Quit button

Everything runs on your Mac. Nothing is uploaded. Roomy **only moves things to the Trash** (never deletes permanently), and refuses anything outside your home folder, inside app bundles or the Photos library, or core folders (see `src-tauri/src/safety.rs`).

## Build

```sh
npm install
npm run app          # -> src-tauri/target/release/bundle/macos/Roomy.app
npm run tauri dev    # development
```

Give Roomy **Full Disk Access** (System Settings > Privacy & Security) so it can measure Mail, Messages and Safari data.

Stack: Tauri 2, Rust (jwalk parallel walk, blake3, sysinfo, trash), React 19, Tailwind 4.

Dev checks: `cargo test` (safety rules), `cargo test --release real_scan -- --ignored --nocapture` (read-only scan of your disk, prints a summary).
