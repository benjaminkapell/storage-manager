import clsx from "clsx";
import { ArrowUpRight, Info, LoaderCircle, Moon, RefreshCw, ShieldAlert, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge, Button, Card, SizeBar } from "../components/ui";
import { api, type ChromeBreakdown, type ChromeTab, type ChromeTabList } from "../lib/api";
import { memSize } from "../lib/format";

const PARTS: { key: keyof ChromeBreakdown; label: string; color: string }[] = [
  { key: "tabs", label: "Tabs", color: "var(--accent)" },
  { key: "extensions", label: "Extensions", color: "var(--c-music)" },
  { key: "graphics", label: "Graphics", color: "var(--c-apps)" },
  { key: "browser", label: "Chrome itself", color: "var(--c-system)" },
  { key: "helpers", label: "Helpers", color: "var(--c-other)" },
];

const host = (url: string) => {
  try { return new URL(url).hostname.replace(/^www\./, "") || url; } catch { return url; }
};

type Load = { kind: "idle" } | { kind: "loading" } | { kind: "error"; reason: string } | { kind: "done"; list: ChromeTabList };

export default function ChromeTabs({ chrome }: { chrome: ChromeBreakdown }) {
  const [load, setLoad] = useState<Load>({ kind: "idle" });
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [notice, setNotice] = useState<Record<string, string>>({});

  const explain = (e: unknown) => {
    const r = String(e);
    if (r === "gone") return "This tab was already closed. Click Refresh to update the list.";
    if (r === "not-allowed") return "Roomy isn't allowed to control Chrome. Allow it in System Settings, Privacy & Security, Automation.";
    if (r === "not-running") return "Chrome isn't open anymore.";
    return `Chrome didn't respond: ${r}`;
  };
  const say = (id: string, msg?: string) => setNotice((n) => { const next = { ...n }; if (msg) next[id] = msg; else delete next[id]; return next; });
  const show = async (t: ChromeTab) => {
    say(t.id);
    try { await api.chromeTab(t.id, "show"); } catch (e) { say(t.id, explain(e)); }
  };

  const fetchTabs = async () => {
    setLoad({ kind: "loading" });
    try {
      const list = await api.chromeTabs();
      setClosed(new Set());
      setLoad({ kind: "done", list });
    } catch (e) {
      setLoad({ kind: "error", reason: String(e) });
    }
  };

  const tabs = useMemo(() => {
    if (load.kind !== "done") return [];
    const live = load.list.tabs.filter((t) => !closed.has(t.id));
    const rank = (t: ChromeTab) => (t.state === "sleeping" ? -1 : (t.memory ?? 0));
    return load.list.canMeasure ? [...live].sort((a, b) => rank(b) - rank(a)) : live;
  }, [load, closed]);

  const copies = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tabs) m.set(t.url, (m.get(t.url) ?? 0) + 1);
    return m;
  }, [tabs]);

  const close = async (t: ChromeTab) => {
    setClosed((s) => new Set(s).add(t.id));
    try {
      await api.chromeTab(t.id, "close");
    } catch (e) {
      if (String(e) === "gone") return; // already closed in Chrome: keep it off the list
      setClosed((s) => { const n = new Set(s); n.delete(t.id); return n; });
      say(t.id, explain(e));
    }
  };

  const sleeping = tabs.filter((t) => t.state === "sleeping").length;
  const maxMem = Math.max(1, ...tabs.map((t) => t.memory ?? 0));
  const visible = showAll ? tabs : tabs.slice(0, 25);
  const dupCount = [...copies.values()].reduce((a, n) => a + (n > 1 ? n - 1 : 0), 0);

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2 className="text-[15px] font-semibold">Inside Google Chrome</h2>
        <span className="num text-[13px] text-ink-2">{memSize(chrome.total)} in total</span>
      </div>
      <Card className="overflow-hidden">
        <div className="p-5">
          <div className="flex h-3 overflow-hidden rounded-full bg-surface-2" role="img" aria-label="How Chrome's memory is split">
            {PARTS.map((p) => {
              const v = chrome[p.key] as number;
              return v > 0 ? <div key={p.key} title={`${p.label}: ${memSize(v)}`} style={{ width: `${(v / chrome.total) * 100}%`, background: p.color }} className="border-r border-surface last:border-r-0" /> : null;
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[13px]">
            {PARTS.map((p) => {
              const v = chrome[p.key] as number;
              if (v <= 0) return null;
              return (
                <span key={p.key} className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-[3px]" style={{ background: p.color }} />
                  <span className="text-ink-2">{p.label}</span>
                  <span className="num font-medium">{memSize(v)}</span>
                </span>
              );
            })}
          </div>
          {chrome.extensions > 700 * 1024 ** 2 && (
            <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
              Your {chrome.extensionProcesses} extensions use <strong className="num text-ink">{memSize(chrome.extensions)}</strong> all the time, even when you don't use them.
              Removing the ones you don't need (in Chrome: Extensions menu, puzzle icon, Manage Extensions) frees that memory for good.
            </p>
          )}
        </div>

        <div className="border-t border-line">
          {load.kind === "idle" && (
            <div className="flex flex-wrap items-center gap-4 px-5 py-4">
              <p className="flex-1 text-[13.5px] leading-relaxed text-ink-2">
                See every open tab and which ones use the most memory. The first time, macOS asks if Roomy may control Chrome: click <strong className="text-ink">OK</strong>.
              </p>
              <Button variant="primary" onClick={fetchTabs}>Show my tabs</Button>
            </div>
          )}

          {load.kind === "loading" && (
            <div className="flex items-center gap-3 px-5 py-4 text-ink-2">
              <LoaderCircle size={16} className="animate-spin text-accent motion-reduce:animate-none" /> Asking Chrome about your tabs. With lots of tabs this takes a few seconds.
            </div>
          )}

          {load.kind === "error" && (
            <div className="flex flex-wrap items-start gap-4 px-5 py-4">
              <ShieldAlert size={18} className="mt-0.5 shrink-0 text-warn-ink" />
              <div className="flex-1 text-[13.5px] leading-relaxed text-ink-2">
                {load.reason === "not-allowed" ? (
                  <>Roomy isn't allowed to talk to Chrome yet. In the settings that open, find <strong className="text-ink">Roomy</strong> and turn on <strong className="text-ink">Google Chrome</strong>, then try again.</>
                ) : load.reason === "not-running" ? (
                  <>Chrome isn't open right now.</>
                ) : (
                  <>Chrome didn't answer: {load.reason}</>
                )}
              </div>
              {load.reason === "not-allowed" && <Button onClick={() => api.open("automation")}>Open Settings</Button>}
              <Button icon={RefreshCw} onClick={fetchTabs}>Try again</Button>
            </div>
          )}

          {load.kind === "done" && (
            <>
              {!load.list.canMeasure && (
                <div className="flex flex-wrap items-start gap-4 border-b border-line bg-warn-soft/60 px-5 py-4">
                  <Info size={18} className="mt-0.5 shrink-0 text-warn-ink" />
                  <div className="min-w-[280px] flex-1 text-[13.5px] leading-relaxed text-ink-2">
                    <p className="font-medium text-ink">To see memory per tab, turn on one setting in Chrome</p>
                    <p className="mt-1">In Chrome's menu bar, click <strong className="text-ink">View</strong>, then <strong className="text-ink">Developer</strong>, then <strong className="text-ink">Allow JavaScript from Apple Events</strong>. Then click Check again.</p>
                    <p className="mt-1 text-[12.5px] text-ink-3">
                      Good to know: this lets apps you've allowed to control Chrome (like Roomy) read your open pages. Roomy only asks each tab how much memory it uses.
                      You can switch it off again the same way when you're done.
                    </p>
                  </div>
                  <Button icon={RefreshCw} onClick={fetchTabs}>Check again</Button>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-[13px] text-ink-2">
                <span className="flex-1">
                  <strong className="num text-ink">{tabs.length}</strong> tabs open
                  {sleeping > 0 && <> · <span className="num">{sleeping}</span> sleeping</>}
                  {dupCount > 0 && <> · <span className="num">{dupCount}</span> open twice or more</>}
                  {load.list.canMeasure && " · biggest first"}
                </span>
                <Button variant="ghost" icon={RefreshCw} onClick={fetchTabs}>Refresh</Button>
              </div>

              <ul className="divide-y divide-line border-t border-line">
                {visible.map((t) => (
                  <li key={t.id} className={clsx("grid items-center gap-3 px-5 py-2.5", load.list.canMeasure ? "grid-cols-[28px_minmax(0,1fr)_minmax(80px,160px)_70px_auto]" : "grid-cols-[28px_minmax(0,1fr)_auto]")}>
                    <span aria-hidden className="grid size-7 place-items-center rounded-lg bg-surface-2 text-[12px] font-semibold text-ink-2 uppercase">{host(t.url).charAt(0)}</span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{t.title || host(t.url)}</span>
                        {t.state === "sleeping" && <Badge><Moon size={11} className="mr-1" />Sleeping</Badge>}
                        {(copies.get(t.url) ?? 0) > 1 && <Badge tone="check">Open {copies.get(t.url)} times</Badge>}
                      </div>
                      <div className="truncate text-[12px] text-ink-3">{host(t.url)}</div>
                      {notice[t.id] && <div role="alert" className="mt-0.5 text-[12px] text-warn-ink">{notice[t.id]}</div>}
                    </div>
                    {load.list.canMeasure && (
                      <>
                        {t.memory != null ? <SizeBar value={t.memory} max={maxMem} /> : <span />}
                        <span className="num text-right text-[13px] font-medium">{t.memory != null ? memSize(t.memory) : t.state === "sleeping" ? "almost 0" : "?"}</span>
                      </>
                    )}
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" className="h-7 px-2" icon={ArrowUpRight} onClick={() => show(t)}>Go to tab</Button>
                      <Button variant="ghost" className="h-7 px-2" icon={X} onClick={() => close(t)} title="Close this tab. Reopen it in Chrome with Cmd+Shift+T.">Close</Button>
                    </div>
                  </li>
                ))}
              </ul>
              {tabs.length > 25 && (
                <div className="flex justify-center border-t border-line py-3">
                  <Button variant="ghost" onClick={() => setShowAll((v) => !v)}>{showAll ? "Show fewer" : `Show all ${tabs.length} tabs`}</Button>
                </div>
              )}
              <div className="border-t border-line bg-surface-2/50 px-5 py-3 text-[12.5px] leading-relaxed text-ink-3">
                {load.list.canMeasure && <p>Each number is the memory the website itself uses. Chrome adds a bit on top, and tabs from the same website sometimes share memory, so see the numbers as a ranking.</p>}
                <p>Closed a tab by mistake? In Chrome press <strong>Cmd+Shift+T</strong> to bring it back. Tip: turn on <strong>Memory Saver</strong> in Chrome (Settings, Performance) so tabs you don't look at go to sleep by themselves.</p>
              </div>
            </>
          )}
        </div>
      </Card>
    </section>
  );
}
