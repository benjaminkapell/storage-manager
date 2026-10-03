import clsx from "clsx";
import { BatteryCharging, BatteryFull, BatteryLow, BellRing, CircleCheck, Info, Moon, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, Card, PageHeader, SizeBar } from "../components/ui";
import { api, type BatteryAudit, type BatteryFinding, type Night } from "../lib/api";

const TONE = {
  bad: { icon: TriangleAlert, chip: "bg-danger-soft text-danger", bar: "var(--danger)" },
  warn: { icon: TriangleAlert, chip: "bg-warn-soft text-warn-ink", bar: "var(--warn)" },
  info: { icon: Info, chip: "bg-surface-2 text-ink-2", bar: "var(--accent)" },
} as const;

const rateTone = (r: number) => (r >= 3 ? "bad" : r >= 1.5 ? "warn" : "info");

function nightLabel(n: Night) {
  const start = new Date(n.start * 1000);
  const h = start.getHours();
  const overnight = new Date(n.end * 1000).toDateString() !== start.toDateString() || h >= 20 || h < 5;
  const when = overnight ? "night" : h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  // A night that starts after midnight belongs to the evening before.
  const day = new Date(start);
  if (h < 5) day.setDate(day.getDate() - 1);
  const days = Math.round((new Date(new Date().toDateString()).getTime() - new Date(day.toDateString()).getTime()) / 86400000);
  if (days === 0) return when === "night" ? "Tonight" : `This ${when}`;
  if (days === 1) return when === "night" ? "Last night" : `Yesterday ${when}`;
  return `${day.toLocaleDateString(undefined, { weekday: "long" })} ${when}`;
}

const clock = (secs: number) => new Date(secs * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export default function Battery() {
  const [a, setA] = useState<BatteryAudit | null>(null);
  const [checking, setChecking] = useState(false);
  const [auto, setAuto] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    try { setA(await api.batteryAudit()); } finally { setChecking(false); }
  }, []);

  useEffect(() => {
    api.batteryLast().then((last) => { if (last) setA((cur) => cur ?? last); });
    api.batteryAuto().then(setAuto);
    check();
  }, [check]);

  const toggleAuto = async () => {
    setErr(null);
    try { setAuto(await api.batteryAuto(!auto)); } catch (e) { setErr(String(e)); }
  };

  if (!a) return <PageHeader title="Battery" lead="Reading your Mac's sleep history. This takes a few seconds..." />;
  if (!a.hasBattery) return <PageHeader title="Battery" lead="This Mac has no battery, so there's nothing to check here." />;

  const worst = a.findings.find((f) => f.severity === "bad") ? "bad" : a.findings.find((f) => f.severity === "warn") ? "warn" : "ok";
  const lastNight = a.nights.find((n) => n.drainPerHour !== null);
  const maxRate = Math.max(3, ...a.nights.map((n) => n.drainPerHour ?? 0));
  const ChargeIcon: LucideIcon = a.charging ? BatteryCharging : (a.charge ?? 100) < 20 ? BatteryLow : BatteryFull;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Battery" lead="Why your battery runs down, especially while the lid is closed, and what to switch off.">
        <Button icon={RefreshCw} onClick={check} disabled={checking}>{checking ? "Checking..." : "Check again"}</Button>
      </PageHeader>

      <Card className="p-6">
        <div className="flex items-start gap-4">
          <span className={clsx("grid size-11 shrink-0 place-items-center rounded-2xl",
            worst === "ok" && "bg-accent-soft text-accent-ink", worst === "warn" && "bg-warn-soft text-warn-ink", worst === "bad" && "bg-danger-soft text-danger")}>
            {worst === "ok" ? <CircleCheck size={22} /> : <TriangleAlert size={22} />}
          </span>
          <div className="flex-1">
            <h2 className="text-[20px] font-semibold tracking-[-0.01em]">
              {worst === "bad" ? "Something is draining your battery" : worst === "warn" ? "A few things are wasting battery" : "Your battery looks healthy"}
            </h2>
            <p className="mt-0.5 text-ink-2">
              {worst === "ok" ? "Nothing unusual while asleep or awake." : "Fix the items below from top to bottom. The first one matters most."}
            </p>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-5">
          <Stat label="Battery now" value={a.charge !== null ? `${a.charge}%` : "Unknown"} icon={ChargeIcon}>
            {a.charging ? "Charging" : a.onPower ? "Plugged in" : "On battery"}
          </Stat>
          <Stat label="Battery health" value={a.maxCapacity !== null ? `${a.maxCapacity}%` : (a.health ?? "Unknown")}>
            {a.cycles !== null ? `${a.cycles} charge cycles. ` : ""}{(a.maxCapacity ?? 100) >= 80 ? "Normal wear, nothing to replace." : "Worn. Consider a battery service."}
          </Stat>
          <Stat label="Last time the lid was closed" value={lastNight ? `-${(lastNight.startCharge ?? 0) - (lastNight.endCharge ?? 0)}%` : "No data"} icon={Moon}>
            {lastNight ? `${lastNight.drainPerHour!.toFixed(1)}% an hour over ${Math.round(lastNight.hours)} hours. Healthy is under 1%.` : "Close the lid on battery and check back."}
          </Stat>
        </div>
      </Card>

      {a.findings.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="px-1 text-[15px] font-semibold">What's draining it</h2>
          {a.findings.map((f) => <FindingCard key={f.id} f={f} onDone={check} />)}
        </section>
      )}

      {a.nights.length > 0 && (
        <section>
          <div className="mb-2 flex items-baseline justify-between px-1">
            <h2 className="text-[15px] font-semibold">While the lid was closed</h2>
            <span className="text-[12px] text-ink-3">Battery used per hour asleep</span>
          </div>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              {a.nights.slice(0, 7).map((n) => (
                <li key={n.start} className="grid grid-cols-[minmax(0,1fr)_minmax(120px,240px)_minmax(150px,auto)] items-center gap-4 px-5 py-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{nightLabel(n)}</div>
                    <div className="truncate text-[12px] text-ink-3">
                      {clock(n.start)} to {clock(n.end)} · woke {n.wakes} times
                      {n.stuckAudio ? ` · ${n.stuckAudio} stayed connected` : ""}
                    </div>
                  </div>
                  {n.drainPerHour !== null ? <SizeBar value={n.drainPerHour} max={maxRate} color={TONE[rateTone(n.drainPerHour)].bar} /> : <span />}
                  <span className="num text-right text-[13px]">
                    {n.drainPerHour === null ? <span className="text-ink-3">Plugged in</span> : (
                      <>
                        <strong className={clsx(n.drainPerHour >= 3 && "text-danger", n.drainPerHour >= 1.5 && n.drainPerHour < 3 && "text-warn-ink")}>
                          {n.drainPerHour.toFixed(1)}% an hour
                        </strong>
                        <span className="text-ink-3"> · {n.startCharge}% → {n.endCharge}%</span>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      <Card className="flex items-start gap-4 p-5">
        <BellRing size={20} className="mt-0.5 shrink-0 text-accent-ink" />
        <div className="flex-1">
          <h2 className="font-semibold">Check automatically</h2>
          <p className="mt-1 max-w-[70ch] text-[13.5px] leading-relaxed text-ink-2">
            Roomy checks quietly at 9:00, 14:00 and 20:00. If your Mac was asleep then, it checks right after it wakes up. You only get a
            notification when something new is wrong, never for the same thing twice in a row.
          </p>
          <p className="mt-1.5 text-[12px] text-ink-3">
            {err ?? `Last checked ${new Date(a.checkedAt * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`}
          </p>
        </div>
        <button
          role="switch"
          aria-checked={!!auto}
          aria-label="Check automatically"
          onClick={toggleAuto}
          disabled={auto === null}
          className={clsx("relative mt-1 h-6 w-10 shrink-0 rounded-full transition-colors duration-150", auto ? "bg-accent" : "bg-line")}
        >
          <span className={clsx("absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-150", auto && "translate-x-4")} />
        </button>
      </Card>
    </div>
  );
}

function Stat({ label, value, icon: Icon, children }: { label: string; value: string; icon?: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[12.5px] text-ink-2">{label}</div>
      <div className="num flex items-center gap-1.5 text-[18px] font-semibold tracking-[-0.01em]">
        {Icon && <Icon size={18} className="text-ink-3" />}{value}
      </div>
      <p className="text-[12px] leading-snug text-ink-3">{children}</p>
    </div>
  );
}

function FindingCard({ f, onDone }: { f: BatteryFinding; onDone: () => void }) {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const t = TONE[f.severity];
  const act = f.action;
  const needsConfirm = act?.kind === "stop" || act?.kind === "quit";
  const label = f.actionLabel ?? (act?.kind === "quit" ? "Quit it" : null);

  const run = async () => {
    if (!act) return;
    setBusy(true);
    setMsg(null);
    try {
      if (act.kind === "stop") {
        const done = await api.batteryStop(act.pids);
        setMsg(done.length === act.pids.length ? "Stopped." : `Stopped ${done.length} of ${act.pids.length}. The rest were already gone or aren't Roomy's to stop.`);
      } else if (act.kind === "quit") {
        await api.quitApp(act.appPath);
      } else if (act.kind === "fixSettings") {
        await api.batteryFixSettings();
        setMsg("Done. Power Nap and network keep-alive are off on battery.");
      } else {
        await api.open(act.place);
      }
      setAsk(false);
      if (act.kind !== "open") setTimeout(onDone, 1200);
    } catch (e) {
      setMsg(String(e));
    }
    setBusy(false);
  };

  return (
    <Card className="p-5">
      <div className="flex items-start gap-4">
        <span className={clsx("grid size-9 shrink-0 place-items-center rounded-xl", t.chip)}><t.icon size={18} /></span>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{f.title}</h3>
          <p className="mt-1 max-w-[75ch] text-[13.5px] leading-relaxed text-ink-2">{f.detail}</p>
          {f.items.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1.5 rounded-xl bg-surface-2 px-4 py-3">
              {f.items.map((i, k) => (
                <li key={k} className="flex flex-wrap items-baseline justify-between gap-x-4 text-[13px]">
                  <span className="font-medium">{i.label}</span>
                  <span className="text-ink-3">{i.detail}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 max-w-[75ch] text-[13.5px] leading-relaxed"><strong>What to do:</strong> {f.fix}</p>
          {msg && <p className="mt-2 text-[13px] text-accent-ink">{msg}</p>}
        </div>
        {act && label && (
          <div className="flex shrink-0 gap-1">
            {needsConfirm && ask ? (
              <>
                <Button variant="ghost" onClick={() => setAsk(false)} disabled={busy}>Keep</Button>
                <Button variant="primary" onClick={run} disabled={busy}>{busy ? "Working..." : act.kind === "stop" ? `Stop ${act.pids.length}` : "Quit it"}</Button>
              </>
            ) : (
              <Button variant={f.severity === "info" ? "secondary" : "primary"} onClick={() => (needsConfirm ? setAsk(true) : run())} disabled={busy}>
                {busy ? "Working..." : label}
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
