import clsx from "clsx";
import { Activity, CircleCheck, HardDrive, Info, Power, RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Card, PageHeader, SizeBar } from "../components/ui";
import { api, type AppUsage, type MemoryInfo } from "../lib/api";
import { duration, memSize as size } from "../lib/format";

const STATUS = {
  1: { word: "Comfortable", tone: "ok", text: "Your Mac has enough memory for what's open right now." },
  2: { word: "Getting tight", tone: "warn", text: "Apps are competing for memory. Your Mac is starting to borrow space from the disk, which slows things down." },
  4: { word: "Under pressure", tone: "bad", text: "Memory is full. Quitting a few apps from the list below will make your Mac feel faster straight away." },
} as const;

export default function Memory({ diskFreePct }: { diskFreePct: number }) {
  const [m, setM] = useState<MemoryInfo | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => api.memoryInfo().then((v) => alive && setM(v));
    tick();
    const t = setInterval(tick, 2500);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!m) return <PageHeader title="Memory" lead="Measuring..." />;

  const st = STATUS[(m.pressure >= 4 ? 4 : m.pressure >= 2 ? 2 : 1) as 1 | 2 | 4];
  const usedPct = m.used / m.total;
  const maxApp = m.apps[0]?.bytes ?? 1;
  const days = m.uptimeSecs / 86400;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Memory"
        lead="Memory (RAM) is your Mac's short-term workspace for open apps. Storage is the long-term shelf for files. They're different, but they affect each other."
      >
        <Button icon={Activity} onClick={() => api.open("activity-monitor")}>Activity Monitor</Button>
      </PageHeader>

      <Card className="p-6">
        <div className="flex items-start gap-4">
          <span className={clsx("grid size-11 shrink-0 place-items-center rounded-2xl",
            st.tone === "ok" && "bg-accent-soft text-accent-ink", st.tone === "warn" && "bg-warn-soft text-warn-ink", st.tone === "bad" && "bg-danger-soft text-danger")}>
            {st.tone === "ok" ? <CircleCheck size={22} /> : <TriangleAlert size={22} />}
          </span>
          <div className="flex-1">
            <h2 className="text-[20px] font-semibold tracking-[-0.01em]">{st.word}</h2>
            <p className="mt-0.5 text-ink-2">{st.text}</p>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-5">
          <Stat label="Memory in use" value={`${size(m.used)} of ${size(m.total)}`}>
            <SizeBar value={m.used} max={m.total} color={usedPct > 0.9 ? "var(--warn)" : "var(--accent)"} />
          </Stat>
          <Stat label="Borrowed from the disk (swap)" value={m.swapUsed > 0 ? size(m.swapUsed) : "Nothing"}>
            <p className="text-[12px] leading-snug text-ink-3">
              {m.swapUsed > 2e9 ? "Your Mac ran out of memory at some point and parked things on the disk. That's slow." : "Little or none: good."}
            </p>
          </Stat>
          <Stat label="Running without a restart" value={duration(m.uptimeSecs)}>
            <p className="text-[12px] leading-snug text-ink-3">{days > 7 ? "A restart clears leftovers and gives memory a fresh start." : "Recently restarted: good."}</p>
          </Stat>
        </div>
      </Card>

      {diskFreePct < 0.1 && (
        <Card className="flex items-start gap-4 border-warn/40 bg-warn-soft p-5 shadow-none">
          <HardDrive size={20} className="mt-0.5 shrink-0 text-warn-ink" />
          <div>
            <h2 className="font-semibold">Your full disk is making memory worse</h2>
            <p className="mt-1 max-w-[75ch] text-[13.5px] leading-relaxed text-ink-2">
              When memory runs out, macOS parks things on the disk. With almost no free space, it has nowhere to put them, so everything
              slows down. Freeing up 30 to 50 GB of storage will help memory as much as quitting apps.
            </p>
          </div>
        </Card>
      )}

      <Card className="flex items-start gap-3 p-5">
        <Info size={18} className="mt-0.5 shrink-0 text-accent-ink" />
        <div className="text-[13.5px] leading-relaxed text-ink-2">
          <strong className="text-ink">Why memory always looks "full":</strong> macOS uses spare memory on purpose to keep recently used apps and
          files ready, and hands it back instantly when needed. A high number is normal. What matters is the status at the top: if it says
          Comfortable, memory isn't what's slowing you down.
        </div>
      </Card>

      <section>
        <div className="mb-2 flex items-baseline justify-between px-1">
          <h2 className="text-[15px] font-semibold">What's using memory</h2>
          <span className="text-[12px] text-ink-3">Updates every few seconds</span>
        </div>
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {m.apps.map((a) => <AppRow key={a.appPath ?? a.name} a={a} max={maxApp} />)}
          </ul>
        </Card>
        {days > 7 && (
          <p className="mt-3 flex items-center gap-2 px-1 text-[13px] text-ink-2">
            <RotateCcw size={14} /> Tip: restart your Mac about once a week. It's the easiest speed-up there is.
          </p>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, children }: { label: string; value: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="text-[12.5px] text-ink-2">{label}</div>
        <div className="num text-[18px] font-semibold tracking-[-0.01em]">{value}</div>
      </div>
      {children}
    </div>
  );
}

function AppRow({ a, max }: { a: AppUsage; max: number }) {
  const [ask, setAsk] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [quitting, setQuitting] = useState(false);
  const quit = async () => {
    if (!a.appPath) return;
    setQuitting(true);
    try { await api.quitApp(a.appPath); setAsk(false); } catch (e) { setErr(String(e)); }
    setQuitting(false);
  };
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_minmax(100px,200px)_80px_150px] items-center gap-4 px-5 py-3">
      <div className="min-w-0">
        <div className="truncate font-medium">{a.name}</div>
        <div className="truncate text-[12px] text-ink-3">
          {err ?? (a.isSystem ? "Part of macOS" : a.processes > 1 ? `${a.processes} parts running` : "1 part running")}
        </div>
      </div>
      <SizeBar value={a.bytes} max={max} color={a.isSystem ? "var(--c-system)" : "var(--accent)"} />
      <span className="num text-right font-medium">{size(a.bytes)}</span>
      <div className="flex justify-end gap-1">
        {a.appPath && !ask && <Button variant="ghost" icon={Power} onClick={() => setAsk(true)}>Quit</Button>}
        {a.appPath && ask && (
          <>
            <Button variant="ghost" onClick={() => setAsk(false)} disabled={quitting}>Keep</Button>
            <Button variant="primary" onClick={quit} disabled={quitting}>{quitting ? "Quitting" : "Quit it"}</Button>
          </>
        )}
      </div>
    </li>
  );
}
