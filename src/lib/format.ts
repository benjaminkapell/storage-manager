import type { CategoryKey } from "./api";

/** Sizes the way Finder shows them (1 GB = 1,000,000,000 bytes). */
export function size(bytes: number): string {
  if (bytes < 1e3) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1e3;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Memory the way Apple labels it (24 GB of RAM = 24 x 1024^3 bytes). */
export function memSize(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1).replace(/\.0$/, "")} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function ago(secs: number): string {
  if (!secs) return "unknown";
  const d = (Date.now() / 1000 - secs) / 86400;
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  if (d < 30) return `${Math.floor(d)} days ago`;
  if (d < 365) { const m = Math.floor(d / 30); return `${m} month${m > 1 ? "s" : ""} ago`; }
  const y = Math.floor(d / 365);
  return `${y} year${y > 1 ? "s" : ""} ago`;
}

export function duration(secs: number): string {
  const d = Math.floor(secs / 86400);
  if (d >= 1) return `${d} day${d > 1 ? "s" : ""}`;
  const h = Math.floor(secs / 3600);
  if (h >= 1) return `${h} hour${h > 1 ? "s" : ""}`;
  return `${Math.max(1, Math.floor(secs / 60))} minutes`;
}

export const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
export const parentOf = (p: string) => (p === "/" ? null : p.slice(0, p.lastIndexOf("/")) || "/");

let home = "";
export function setHome(h: string) { home = h; }
export function prettyPath(p: string): string {
  return home && p.startsWith(home) ? "Home" + p.slice(home.length) : p;
}
export function guessHome(paths: string[]): string {
  const m = paths.map((p) => /^\/Users\/[^/]+/.exec(p)?.[0]).find(Boolean);
  return m ?? "";
}

export const CATEGORY: Record<CategoryKey, { label: string; hint: string }> = {
  system: { label: "App data & macOS", hint: "Settings, caches and files apps keep for themselves" },
  apps: { label: "Apps", hint: "Programs installed on your Mac" },
  videos: { label: "Videos", hint: "Movies, clips and recordings" },
  dev: { label: "Coding files", hint: "Projects, code packages and developer tools" },
  other: { label: "Other files", hint: "Everything else in your folders" },
  music: { label: "Music & audio", hint: "Songs, samples and recordings" },
  photos: { label: "Photos & images", hint: "Pictures, including the Photos app" },
  archives: { label: "Zips & installers", hint: "Compressed files and app installers" },
  documents: { label: "Documents", hint: "PDFs, Word, Pages, spreadsheets and slides" },
};

/** Friendly names for well-known folders in the "Where it went" view. */
export function folderLabel(p: string): string {
  if (p === "/") return "Your whole Mac";
  if (home && p === home) return "Your home folder";
  const rel = home && p.startsWith(home + "/") ? p.slice(home.length + 1) : null;
  const known: Record<string, string> = {
    Library: "Library (hidden app data)",
    "Library/Caches": "Caches (temporary app files)",
    "Library/Application Support": "Application Support (app data)",
    "Library/Containers": "Containers (app data)",
    "Library/Group Containers": "Group Containers (shared app data)",
    ".npm": ".npm (code download cache)",
    ".cache": ".cache (developer tool cache)",
  };
  if (rel && known[rel]) return known[rel];
  const sys: Record<string, string> = {
    "/Applications": "Applications",
    "/Library": "System-wide Library",
    "/private": "Hidden macOS files",
    "/private/var": "macOS working files",
    "/private/var/folders": "Temporary files",
    "/private/var/vm": "Memory overflow (swap)",
    "/Users": "Users",
    "/System": "macOS extras",
    "/opt": "Developer tools (Homebrew)",
    "/usr": "Command-line tools",
  };
  return sys[p] ?? baseName(p);
}
