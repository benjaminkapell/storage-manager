import { invoke } from "@tauri-apps/api/core";

export type CategoryKey = "apps" | "system" | "videos" | "photos" | "music" | "dev" | "documents" | "archives" | "other";

export interface FileItem {
  path: string;
  size: number;
  modified: number;
  kind: "file" | "app" | "library";
  category: CategoryKey;
  trashable: boolean;
}
export interface Finding {
  id: string;
  path: string | null;
  title: string;
  detail: string;
  size: number;
  group: string;
  safety: "safe" | "check" | "guide";
  trashable: boolean;
  howTo: string | null;
}
export interface DupGroup { size: number; wasted: number; files: FileItem[] }
export interface ScanResult {
  finishedAt: number;
  durationMs: number;
  cancelled: boolean;
  volumeTotal: number;
  volumeUsed: number;
  volumeFree: number;
  scannedBytes: number;
  fileCount: number;
  unreadable: number;
  fullDiskAccess: boolean;
  categories: { key: CategoryKey; bytes: number }[];
  folders: { path: string; size: number }[];
  bigFiles: FileItem[];
  junk: Finding[];
  system: Finding[];
  duplicates: DupGroup[];
}
export interface Progress { phase: "walking" | "duplicates"; files: number; bytes: number; current: string; done: number; total: number }
export interface DiskInfo { total: number; used: number; free: number; fullDiskAccess: boolean; scanning: boolean; home: string }
export interface AppUsage { name: string; bytes: number; processes: number; appPath: string | null; isSystem: boolean }
export interface ChromeBreakdown {
  running: boolean; total: number; tabs: number; tabProcesses: number; extensions: number;
  extensionProcesses: number; graphics: number; browser: number; helpers: number;
}
export interface MemoryInfo {
  total: number; used: number; available: number; swapTotal: number; swapUsed: number;
  pressure: number; uptimeSecs: number; apps: AppUsage[]; chrome: ChromeBreakdown;
}
export interface ChromeTab { id: string; window: number; title: string; url: string; memory: number | null; state: "measured" | "sleeping" | "unknown" }
export interface ChromeTabList { canMeasure: boolean; tabs: ChromeTab[] }
export interface TrashResult { path: string; ok: boolean; error: string | null }

export const api = {
  diskInfo: () => invoke<DiskInfo>("disk_info"),
  startScan: () => invoke<void>("start_scan"),
  cancelScan: () => invoke<void>("cancel_scan"),
  loadLastScan: () => invoke<ScanResult | null>("load_last_scan"),
  memoryInfo: () => invoke<MemoryInfo>("memory_info"),
  trash: (paths: string[]) => invoke<TrashResult[]>("trash_paths", { paths }),
  reveal: (path: string) => invoke<void>("reveal", { path }),
  chromeTabs: () => invoke<ChromeTabList>("chrome_tabs"),
  chromeTab: (id: string, action: "show" | "close") => invoke<void>("chrome_tab", { id, action }),
  open: (place: "full-disk-access" | "storage-settings" | "trash" | "activity-monitor" | "automation") => invoke<void>("open_place", { place }),
  quitApp: (appPath: string) => invoke<void>("quit_app", { appPath }),
};
