import clsx from "clsx";
import { ChevronRight, Copy, Eraser, FileStack, LoaderCircle, MemoryStick, RefreshCw, ScanSearch, Settings2, ShieldCheck, TriangleAlert, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { View } from "../App";
import { Button, Card } from "../components/ui";
import { api, type CategoryKey, type DiskInfo, type MemoryInfo, type Progress, type ScanResult } from "../lib/api";
import { ago, CATEGORY, size } from "../lib/format";

interface Props {
  disk: DiskInfo | null;
  scan: ScanResult | null;
  progress: Progress | null;
  scanning: boolean;
  onScan: () => void;
  onCancel: () => void;
  go: (v: View) => void;
  compact?: boolean;
}

export default function Overview({ disk, scan, progress, scanning, onScan, onCancel, go, compact }: Props) {
  const [mem, setMem] = useState<MemoryInfo | null>(null);
  useEffect(() => { if (!compact) api.memoryInfo().then(setMem); }, [compact]);

  const freePct = disk ? disk.free / disk.total : 1;
  const tight = freePct < 0.1;

  if (compact) {
    return (
      <div className="pt-8">
        <ScanPanel scan={null} progress={progress} scanning={scanning} onScan={onScan} onCancel={onCancel} lead="This section fills in after Roomy has looked through your Mac once." />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="mb-1">
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.02em]">Your Mac at a glance</h1>
        {disk && (
          <p className={clsx("mt-1.5 max-w-[64ch] leading-relaxed", tight ? "text-ink" : "text-ink-2")}>
            {tight ? (
              <>Your disk is almost full: only <strong className="num">{size(disk.free)}</strong> is free. Macs slow down when less than
                about 10% is free, because macOS needs spare room to work and to handle memory. Freeing space is the single best thing you can do right now.</>
            ) : (
              <>You have <strong className="num">{size(disk.free)}</strong> free. That's a healthy amount of breathing room.</>
            )}
          </p>
        )}
      </header>

      {disk && !disk.fullDiskAccess && <AccessBanner />}

      {disk && <DiskCard disk={disk} scan={scan} />}

      <ScanPanel scan={scan} progress={progress} scanning={scanning} onScan={onScan} onCancel={onCancel} />

      {scan && !scanning && <QuickWins scan={scan} mem={mem} go={go} />}
    </div>
  );
}

function AccessBanner() {
  return (
    <Card className="flex items-start gap-4 border-warn/40 bg-warn-soft p-5 shadow-none">
      <ShieldCheck size={22} className="mt-0.5 shrink-0 text-warn-ink" />
      <div className="flex-1">
        <h2 className="font-semibold">Let Roomy see everything</h2>
        <p className="mt-1 max-w-[70ch] text-[13.5px] leading-relaxed text-ink-2">
          macOS hides some folders (like Mail and Messages) until you allow it. Roomy only reads them to measure sizes and never
          changes anything without asking.
        </p>
        <ol className="mt-2 list-decimal pl-5 text-[13.5px] leading-relaxed text-ink-2">
          <li>Click <strong className="text-ink">Open Settings</strong>.</li>
          <li>Turn on the switch next to <strong className="text-ink">Roomy</strong>. If it isn't listed, click <strong className="text-ink">+</strong> and pick Roomy from Applications.</li>
          <li>Quit Roomy and open it again, then scan.</li>
        </ol>
      </div>
      <Button onClick={() => api.open("full-disk-access")}>Open Settings</Button>
    </Card>
  );
}

const CAT_ORDER: CategoryKey[] = ["system", "apps", "videos", "dev", "other", "music", "photos", "archives", "documents"];

function DiskCard({ disk, scan }: { disk: DiskInfo; scan: ScanResult | null }) {
  const cats = scan ? CAT_ORDER.map((k) => ({ key: k, bytes: scan.categories.find((c) => c.key === k)?.bytes ?? 0 })).filter((c) => c.bytes > 0) : [];
  const scanned = cats.reduce((a, c) => a + c.bytes, 0);
  const hidden = scan ? Math.max(0, disk.used - scanned) : 0;
  const pct = (b: number) => `${(b / disk.total) * 100}%`;

  return (
    <Card className="p-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-[15px] font-semibold">Storage</h2>
        <p className="num text-[13px] text-ink-2">{size(disk.used)} used of {size(disk.total)}</p>
      </div>

      <div className="mt-4 flex h-5 overflow-hidden rounded-md bg-surface-2" role="img" aria-label={`${size(disk.used)} used, ${size(disk.free)} free`}>
        {scan ? (
          <>
            {cats.map((c) => <div key={c.key} title={`${CATEGORY[c.key].label}: ${size(c.bytes)}`} style={{ width: pct(c.bytes), background: `var(--c-${c.key})` }} className="border-r border-surface last:border-r-0" />)}
            {hidden > 0 && <div title={`macOS and hidden: ${size(hidden)}`} style={{ width: pct(hidden), background: "repeating-linear-gradient(135deg, var(--c-system) 0 4px, transparent 4px 8px)" }} />}
          </>
        ) : (
          <div style={{ width: pct(disk.used) }} className="bg-ink-3/70" />
        )}
      </div>

      {scan ? (
        <div className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-x-6 gap-y-3">
          {cats.map((c) => (
            <div key={c.key} className="flex items-start gap-2.5">
              <span className="mt-1 size-2.5 shrink-0 rounded-[3px]" style={{ background: `var(--c-${c.key})` }} />
              <div className="min-w-0 flex-1">
                <div className="flex justify-between gap-2 text-[13.5px]"><span className="font-medium">{CATEGORY[c.key].label}</span><span className="num text-ink-2">{size(c.bytes)}</span></div>
                <p className="text-[12px] leading-snug text-ink-3">{CATEGORY[c.key].hint}</p>
              </div>
            </div>
          ))}
          {hidden > 0 && (
            <div className="flex items-start gap-2.5">
              <span className="mt-1 size-2.5 shrink-0 rounded-[3px]" style={{ background: "repeating-linear-gradient(135deg, var(--c-system) 0 2px, transparent 2px 4px)" }} />
              <div className="min-w-0 flex-1">
                <div className="flex justify-between gap-2 text-[13.5px]"><span className="font-medium">macOS & hidden</span><span className="num text-ink-2">{size(hidden)}</span></div>
                <p className="text-[12px] leading-snug text-ink-3">macOS itself, snapshots and protected areas</p>
              </div>
            </div>
          )}
          <div className="flex items-start gap-2.5">
            <span className="mt-1 size-2.5 shrink-0 rounded-[3px] border border-line bg-surface-2" />
            <div className="min-w-0 flex-1">
              <div className="flex justify-between gap-2 text-[13.5px]"><span className="font-medium">Free</span><span className="num text-ink-2">{size(disk.free)}</span></div>
              <p className="text-[12px] leading-snug text-ink-3">Room left for new things</p>
            </div>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-[13px] text-ink-3">Scan your Mac to see what's taking the space.</p>
      )}
    </Card>
  );
}

function ScanPanel({ scan, progress, scanning, onScan, onCancel, lead }: { scan: ScanResult | null; progress: Progress | null; scanning: boolean; onScan: () => void; onCancel: () => void; lead?: string }) {
  if (scanning) {
    const walking = !progress || progress.phase === "walking";
    const pct = progress ? Math.min(0.97, progress.total ? progress.done / progress.total : 0) : 0;
    return (
      <Card className="p-6">
        <div className="flex items-center gap-3">
          <LoaderCircle size={18} className="animate-spin text-accent motion-reduce:animate-none" />
          <h2 className="flex-1 text-[15px] font-semibold">{walking ? "Looking through your files" : "Checking look-alike files for exact copies"}</h2>
          <Button variant="ghost" onClick={onCancel}>Stop</Button>
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-surface-2">
          <div className="progress-live h-full rounded-full bg-accent transition-[width] duration-300 ease-out" style={{ width: `${Math.max(3, pct * 100)}%` }} />
        </div>
        <div className="mt-3 flex justify-between gap-4 text-[13px] text-ink-2">
          <span className="num">
            {progress && walking && <>{progress.files.toLocaleString()} files · {size(progress.bytes)} so far</>}
            {progress && !walking && <>{Math.round(pct * 100)}% compared</>}
            {!progress && "Starting..."}
          </span>
          <span>Usually takes about a minute</span>
        </div>
        {progress?.current && <p className="mt-2 truncate text-[12px] text-ink-3" dir="rtl" style={{ textAlign: "left" }}>{progress.current}</p>}
      </Card>
    );
  }

  if (!scan) {
    return (
      <Card className="flex flex-col items-center px-8 py-10 text-center">
        <span className="mb-4 grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent-ink"><ScanSearch size={22} /></span>
        <h2 className="text-[18px] font-semibold">Find out where your space went</h2>
        <p className="mt-1.5 max-w-[52ch] leading-relaxed text-ink-2">
          {lead ?? "Roomy looks through your whole Mac for big files, copies, and leftovers you don't need."} It only looks: nothing is
          removed unless you choose it.
        </p>
        <Button variant="primary" className="mt-5 h-9 px-4 text-[14px]" icon={ScanSearch} onClick={onScan}>Scan my Mac</Button>
      </Card>
    );
  }

  return (
    <div className="flex items-center gap-3 px-1 text-[13px] text-ink-2">
      <span className="flex-1">
        Last checked {ago(scan.finishedAt)} · <span className="num">{scan.fileCount.toLocaleString()}</span> files in {Math.round(scan.durationMs / 1000)} seconds
      </span>
      <Button icon={RefreshCw} onClick={onScan}>Scan again</Button>
    </div>
  );
}

function QuickWins({ scan, mem, go }: { scan: ScanResult; mem: MemoryInfo | null; go: (v: View) => void }) {
  const safe = scan.junk.filter((j) => j.trashable && j.safety === "safe").reduce((a, j) => a + j.size, 0);
  const dup = scan.duplicates.reduce((a, d) => a + d.wasted, 0);
  const bigTrashable = scan.bigFiles.filter((b) => b.trashable);
  const sys = scan.system.filter((s) => s.group !== "hidden").reduce((a, s) => a + s.size, 0);
  const memWord = mem ? (mem.pressure >= 4 ? "Under pressure" : mem.pressure >= 2 ? "Getting tight" : "Comfortable") : "";

  const rows: { icon: LucideIcon; view: View; title: string; value: string; text: string; strong?: boolean }[] = [
    { icon: Eraser, view: "cleanup", title: "Safe clean-up", value: size(safe), strong: true,
      text: "App caches and coding leftovers. They rebuild themselves if they're ever needed again." },
    { icon: Copy, view: "duplicates", title: "Exact duplicates", value: size(dup),
      text: `${scan.duplicates.length} files that exist more than once with identical content.` },
    { icon: FileStack, view: "big", title: "Big files", value: `${bigTrashable.length} files`,
      text: "Your largest files and apps, so you can decide what you still need." },
    { icon: Settings2, view: "system", title: "System data", value: size(sys),
      text: "Backups, Photos, Mail and app data. Step-by-step tips to shrink them." },
  ];

  return (
    <section>
      <h2 className="mb-3 px-1 text-[15px] font-semibold">What you can do</h2>
      <Card className="divide-y divide-line overflow-hidden">
        {rows.map((r) => (
          <button key={r.view} onClick={() => go(r.view)} className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors duration-100 hover:bg-surface-2/60">
            <span className={clsx("grid size-9 shrink-0 place-items-center rounded-xl", r.strong ? "bg-accent text-white dark:text-[oklch(0.18_0.02_180)]" : "bg-surface-2 text-ink-2")}><r.icon size={17} /></span>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{r.title}</div>
              <p className="text-[13px] text-ink-2">{r.text}</p>
            </div>
            <span className={clsx("num text-[15px] font-semibold", r.strong && "text-accent-ink")}>{r.value}</span>
            <ChevronRight size={16} className="text-ink-3" />
          </button>
        ))}
        {mem && (
          <button onClick={() => go("memory")} className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors duration-100 hover:bg-surface-2/60">
            <span className={clsx("grid size-9 shrink-0 place-items-center rounded-xl", mem.pressure >= 2 ? "bg-warn-soft text-warn-ink" : "bg-surface-2 text-ink-2")}>
              {mem.pressure >= 2 ? <TriangleAlert size={17} /> : <MemoryStick size={17} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-medium">Memory</div>
              <p className="text-[13px] text-ink-2">See which apps use the most memory, and why "full" memory is usually fine.</p>
            </div>
            <span className="text-[15px] font-semibold">{memWord}</span>
            <ChevronRight size={16} className="text-ink-3" />
          </button>
        )}
      </Card>
    </section>
  );
}
