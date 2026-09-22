import clsx from "clsx";
import { ChevronDown, CircleCheck, FolderSearch, ListChecks, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { ViewProps } from "../App";
import { SelectionBar } from "../components/TrashFlow";
import { Badge, Button, Card, Checkbox, Empty, PageHeader } from "../components/ui";
import { api, type Finding } from "../lib/api";
import { prettyPath, size } from "../lib/format";
import { useSelection } from "../lib/useSelection";

export const SAFETY_LABEL = { safe: "Rebuilds itself", check: "Check first", guide: "Fix it elsewhere" } as const;

export function FindingRow({ f, checked, onCheck }: { f: Finding; checked?: boolean; onCheck?: (v: boolean) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={clsx("transition-colors duration-100", checked ? "bg-accent-soft/50" : "hover:bg-surface-2/50")}>
      <div className="flex items-center gap-1 pr-4">
        {onCheck ? <Checkbox checked={!!checked} onChange={onCheck} disabled={!f.trashable} label={`Select ${f.title}`} /> : <span className="w-4" />}
        <div className="min-w-0 flex-1 py-3">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{f.title}</span>
            <Badge tone={f.safety}>{f.safety === "safe" && (f.group === "installers" || f.group === "logs") ? "Not needed" : SAFETY_LABEL[f.safety]}</Badge>
          </div>
          <p className="mt-0.5 max-w-[80ch] text-[13px] leading-snug text-ink-2">{f.detail}</p>
          {f.path && <p className="mt-0.5 truncate text-[12px] text-ink-3 selectable">{prettyPath(f.path)}</p>}
          {f.howTo && (
            <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="mt-1.5 inline-flex items-center gap-1 text-[12.5px] font-medium text-accent-ink hover:underline">
              How to shrink it <ChevronDown size={13} className={clsx("transition-transform duration-150", open && "rotate-180")} />
            </button>
          )}
          {open && f.howTo && <p className="mt-1.5 max-w-[80ch] rounded-lg bg-surface-2 px-3 py-2 text-[13px] leading-relaxed text-ink selectable">{f.howTo}</p>}
        </div>
        <span className="num w-20 shrink-0 text-right font-medium">{f.size > 0 ? size(f.size) : ""}</span>
        {f.path ? (
          <button onClick={() => api.reveal(f.path!)} title="Show in Finder" aria-label={`Show ${f.title} in Finder`}
            className="ml-2 grid size-8 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"><FolderSearch size={15} /></button>
        ) : <span className="ml-2 w-8" />}
      </div>
    </li>
  );
}

const GROUPS: { key: string; title: string; lead: string }[] = [
  { key: "cache", title: "App caches", lead: "Temporary files apps keep to load faster." },
  { key: "dev", title: "Coding leftovers", lead: "Downloaded packages and build files from your coding projects." },
  { key: "installers", title: "Installers", lead: "Files used to install apps you already have." },
  { key: "logs", title: "Log files", lead: "Records apps keep for troubleshooting." },
];

export default function CleanUp({ scan, onTrash }: ViewProps) {
  const items = scan.junk.filter((j) => j.group !== "trash");
  const trash = scan.junk.find((j) => j.group === "trash");
  const sizes = useMemo(() => new Map(items.filter((f) => f.trashable && f.path).map((f) => [f.path!, f.size])), [items]);
  const labels = useMemo(() => new Map(items.filter((f) => f.path).map((f) => [f.path!, f.title])), [items]);
  const s = useSelection(sizes, labels);
  const safe = items.filter((f) => f.trashable && f.safety === "safe");
  const safeTotal = safe.reduce((a, f) => a + f.size, 0);

  return (
    <div>
      <PageHeader
        title="Clean-up"
        lead={<>Things your Mac can live without. Items marked <Badge tone="safe">Rebuilds itself</Badge> come back automatically if an app needs them, so removing them is safe. The app may be a little slower the first time.</>}
      >
        {safe.length > 0 && <Button variant="primary" icon={ListChecks} onClick={() => s.setMany(safe.map((f) => f.path!), true)}>Select all safe ({size(safeTotal)})</Button>}
      </PageHeader>

      {trash && trash.size > 100e6 && (
        <Card className="mb-5 flex items-center gap-4 p-5">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-warn-soft text-warn-ink"><Trash2 size={18} /></span>
          <div className="flex-1">
            <div className="font-semibold">Your Trash is holding <span className="num">{size(trash.size)}</span></div>
            <p className="text-[13px] text-ink-2">Files in the Trash still take up space. Right-click the Trash in your Dock and choose Empty Trash to get it back.</p>
          </div>
          <Button onClick={() => api.open("trash")}>Open Trash</Button>
        </Card>
      )}

      {items.length === 0 ? (
        <Card><Empty icon={CircleCheck} title="All clean">No caches or leftovers worth removing right now.</Empty></Card>
      ) : (
        <div className="flex flex-col gap-6">
          {GROUPS.map((g) => {
            const list = items.filter((f) => f.group === g.key);
            if (list.length === 0) return null;
            const t = list.reduce((a, f) => a + f.size, 0);
            return (
              <section key={g.key}>
                <div className="mb-2 flex items-baseline justify-between px-1">
                  <div>
                    <h2 className="text-[15px] font-semibold">{g.title}</h2>
                    <p className="text-[13px] text-ink-2">{g.lead}</p>
                  </div>
                  <span className="num text-[13px] text-ink-2">{size(t)}</span>
                </div>
                <Card className="overflow-hidden">
                  <ul className="divide-y divide-line">
                    {list.map((f) => <FindingRow key={f.id} f={f} checked={s.sel.has(f.path ?? "")} onCheck={(v) => f.path && s.toggle(f.path, v)} />)}
                  </ul>
                </Card>
              </section>
            );
          })}
        </div>
      )}
      <SelectionBar count={s.sel.size} bytes={s.bytes} onClear={s.clear} onTrash={() => onTrash(s.items, s.clear)} />
    </div>
  );
}
