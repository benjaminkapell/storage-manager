import { listen } from "@tauri-apps/api/event";
import clsx from "clsx";
import { Copy, Eraser, FileStack, FolderTree, Gauge, MemoryStick, Settings2, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmTrash, Toast, type ToastData } from "./components/TrashFlow";
import { api, type DiskInfo, type Progress, type ScanResult } from "./lib/api";
import { setHome, size } from "./lib/format";
import BigFiles from "./views/BigFiles";
import CleanUp from "./views/CleanUp";
import Duplicates from "./views/Duplicates";
import Folders from "./views/Folders";
import Memory from "./views/Memory";
import Overview from "./views/Overview";
import SystemData from "./views/SystemData";

export type View = "overview" | "folders" | "cleanup" | "duplicates" | "big" | "system" | "memory";
export interface TrashItem { path: string; size: number; label?: string }
export interface ViewProps {
  scan: ScanResult;
  onTrash: (items: TrashItem[], after?: () => void) => void;
  go: (v: View) => void;
}

const removedKey = (s: ScanResult) => `roomy-removed-${s.finishedAt}`;

function loadRemoved(s: ScanResult | null): Set<string> {
  if (!s) return new Set();
  try {
    return new Set(JSON.parse(localStorage.getItem(removedKey(s)) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export default function App() {
  const [view, setView] = useState<View>("overview");
  const [disk, setDisk] = useState<DiskInfo | null>(null);
  const [raw, setRaw] = useState<ScanResult | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [scanning, setScanning] = useState(false);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{ items: TrashItem[]; after?: () => void } | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastData | null>(null);
  const mainRef = useRef<HTMLElement>(null);

  const refreshDisk = useCallback(() => {
    api.diskInfo().then((d) => { setHome(d.home); setDisk(d); setScanning((s) => s || d.scanning); });
  }, []);

  useEffect(() => {
    refreshDisk();
    api.loadLastScan().then((s) => { if (s) { setRaw(s); setRemoved(loadRemoved(s)); } });
    const un1 = listen<Progress>("scan-progress", (e) => setProgress(e.payload));
    const un2 = listen<ScanResult>("scan-done", (e) => {
      setScanning(false);
      setProgress(null);
      if (!e.payload.cancelled) {
        setRaw(e.payload);
        setRemoved(new Set());
      }
      refreshDisk();
    });
    return () => { un1.then((f) => f()); un2.then((f) => f()); };
  }, [refreshDisk]);

  useEffect(() => { mainRef.current?.scrollTo({ top: 0 }); }, [view]);

  const startScan = async () => {
    setProgress(null);
    setScanning(true);
    try { await api.startScan(); } catch { /* already running: progress events will arrive */ }
  };

  // Hide anything already moved to the Trash (including things inside a removed folder).
  const scan = useMemo<ScanResult | null>(() => {
    if (!raw) return null;
    if (removed.size === 0) return raw;
    const gone = (p: string | null) => {
      if (!p) return false;
      for (const r of removed) if (p === r || p.startsWith(r + "/")) return true;
      return false;
    };
    return {
      ...raw,
      bigFiles: raw.bigFiles.filter((f) => !gone(f.path)),
      junk: raw.junk.filter((f) => !gone(f.path)),
      system: raw.system.filter((f) => !gone(f.path)),
      duplicates: raw.duplicates
        .map((g) => ({ ...g, files: g.files.filter((f) => !gone(f.path)) }))
        .filter((g) => g.files.length > 1)
        .map((g) => ({ ...g, wasted: g.size * (g.files.length - 1) })),
    };
  }, [raw, removed]);

  const onTrash = useCallback((items: TrashItem[], after?: () => void) => setConfirm({ items, after }), []);

  const doTrash = async () => {
    if (!confirm) return;
    setBusy(true);
    const results = await api.trash(confirm.items.map((i) => i.path));
    setBusy(false);
    const ok = results.filter((r) => r.ok).map((r) => r.path);
    const failed = results.filter((r) => !r.ok);
    const freed = confirm.items.filter((i) => ok.includes(i.path)).reduce((a, i) => a + i.size, 0);
    setRemoved((prev) => {
      const next = new Set([...prev, ...ok]);
      if (raw) { try { localStorage.setItem(removedKey(raw), JSON.stringify([...next])); } catch { /* storage full: not critical */ } }
      return next;
    });
    confirm.after?.();
    setConfirm(null);
    setToast({ moved: ok.length, bytes: freed, failed });
    refreshDisk();
  };

  const safeJunk = scan?.junk.filter((j) => j.trashable && j.safety === "safe").reduce((a, j) => a + j.size, 0) ?? 0;
  const dupWaste = scan?.duplicates.reduce((a, d) => a + d.wasted, 0) ?? 0;

  const nav: { id: View; label: string; icon: LucideIcon; meta?: string }[] = [
    { id: "overview", label: "Overview", icon: Gauge },
    { id: "folders", label: "Where it went", icon: FolderTree },
    { id: "cleanup", label: "Clean-up", icon: Eraser, meta: scan ? size(safeJunk) : undefined },
    { id: "duplicates", label: "Duplicates", icon: Copy, meta: scan ? size(dupWaste) : undefined },
    { id: "big", label: "Big files", icon: FileStack, meta: scan ? String(scan.bigFiles.length) : undefined },
    { id: "system", label: "System data", icon: Settings2 },
    { id: "memory", label: "Memory", icon: MemoryStick },
  ];

  const freePct = disk ? disk.free / disk.total : 1;
  const needsScan = view !== "overview" && view !== "memory" && !scan;
  const props: ViewProps | null = scan ? { scan, onTrash, go: setView } : null;

  return (
    <div className="flex h-full">
      <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-10 h-10" />

      <aside className="flex w-[228px] shrink-0 flex-col border-r border-line bg-sidebar px-3 pt-12 pb-4">
        <div className="mb-5 flex items-center gap-2.5 px-2.5">
          <span aria-hidden className="grid size-7 place-items-center rounded-lg bg-gradient-to-b from-[#2FA497] to-[#0B6259]">
            <svg width="16" height="16" viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="2.6" rx="1.3" fill="#fff" /><rect x="2" y="6.7" width="8.4" height="2.6" rx="1.3" fill="#fff" fillOpacity=".82" /><rect x="2" y="10.9" width="4.6" height="2.6" rx="1.3" fill="#fff" fillOpacity=".6" /></svg>
          </span>
          <span className="text-[15px] font-semibold tracking-[-0.01em]">Roomy</span>
        </div>
        <nav className="flex flex-col gap-0.5" aria-label="Sections">
          {nav.map((n) => (
            <button
              key={n.id}
              onClick={() => setView(n.id)}
              aria-current={view === n.id ? "page" : undefined}
              className={clsx(
                "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] transition-colors duration-100",
                view === n.id ? "bg-surface font-medium text-ink shadow-card" : "text-ink-2 hover:bg-surface/60 hover:text-ink",
              )}
            >
              <n.icon size={16} className={view === n.id ? "text-accent" : "text-ink-3"} />
              <span className="flex-1">{n.label}</span>
              {n.meta && <span className="num text-[12px] text-ink-3">{n.meta}</span>}
            </button>
          ))}
        </nav>

        <div className="mt-auto px-2.5">
          {disk && (
            <button onClick={() => setView("overview")} className="block w-full text-left">
              <div className="mb-1.5 flex items-baseline justify-between text-[12px]">
                <span className="text-ink-2">Free space</span>
                <span className={clsx("num font-semibold", freePct < 0.1 ? "text-danger" : "text-ink")}>{size(disk.free)}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-line">
                <div className={clsx("h-full rounded-full", freePct < 0.1 ? "bg-danger" : "bg-accent")} style={{ width: `${(1 - freePct) * 100}%` }} />
              </div>
              <div className="num mt-1 text-[11px] text-ink-3">{size(disk.used)} of {size(disk.total)} used</div>
            </button>
          )}
        </div>
      </aside>

      <main ref={mainRef} className="flex-1 overflow-y-auto">
        <div key={view} className="rise mx-auto max-w-[1040px] px-10 pt-12 pb-28">
          {view === "overview" && (
            <Overview disk={disk} scan={scan} progress={progress} scanning={scanning} onScan={startScan} onCancel={() => api.cancelScan()} go={setView} />
          )}
          {view === "memory" && <Memory diskFreePct={freePct} />}
          {needsScan && (
            <Overview disk={disk} scan={null} progress={progress} scanning={scanning} onScan={startScan} onCancel={() => api.cancelScan()} go={setView} compact />
          )}
          {props && view === "folders" && <Folders {...props} />}
          {props && view === "cleanup" && <CleanUp {...props} />}
          {props && view === "duplicates" && <Duplicates {...props} />}
          {props && view === "big" && <BigFiles {...props} />}
          {props && view === "system" && <SystemData {...props} />}
        </div>
      </main>

      {confirm && <ConfirmTrash items={confirm.items} busy={busy} onCancel={() => setConfirm(null)} onConfirm={doTrash} />}
      {toast && <Toast data={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
