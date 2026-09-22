import clsx from "clsx";
import { AppWindow, Archive, Code, File, FileText, FileVideo, FolderSearch, Image, Music, Package, PartyPopper, type LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { ViewProps } from "../App";
import { SelectionBar } from "../components/TrashFlow";
import { Button, Card, Checkbox, Empty, PageHeader } from "../components/ui";
import { api, type CategoryKey, type FileItem } from "../lib/api";
import { ago, baseName, CATEGORY, parentOf, prettyPath, size } from "../lib/format";
import { useSelection } from "../lib/useSelection";

export const CAT_ICON: Record<CategoryKey, LucideIcon> = {
  videos: FileVideo, photos: Image, music: Music, documents: FileText, archives: Archive, apps: AppWindow, dev: Code, system: Package, other: File,
};

export function FileRow({ f, checked, onCheck, badge, dim }: { f: FileItem; checked: boolean; onCheck?: (v: boolean) => void; badge?: React.ReactNode; dim?: boolean }) {
  const Icon = CAT_ICON[f.category] ?? File;
  const lockedWhy = f.kind === "app" && !f.trashable
    ? "To remove an app, drag it from Applications to the Trash in Finder. Some apps (like Adobe) have their own uninstaller."
    : undefined;
  return (
    <li className={clsx("flex items-center gap-1 pr-4 transition-colors duration-100", checked ? "bg-accent-soft/50" : "hover:bg-surface-2/50", dim && "opacity-70")}>
      {onCheck ? <Checkbox checked={checked} onChange={onCheck} disabled={!f.trashable} label={`Select ${baseName(f.path)}`} /> : <span className="w-3" />}
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2" style={{ color: `var(--c-${f.category})` }}><Icon size={16} /></span>
      <div className="ml-2.5 min-w-0 flex-1 py-2.5">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium selectable">{baseName(f.path)}</span>
          {badge}
        </div>
        <div className="truncate text-[12px] text-ink-3" title={lockedWhy}>
          {lockedWhy ? "Remove it in Finder or with its uninstaller · " : ""}{prettyPath(parentOf(f.path) ?? "")} · changed {ago(f.modified)}
        </div>
      </div>
      <span className="num w-20 shrink-0 text-right font-medium">{size(f.size)}</span>
      <button onClick={() => api.reveal(f.path)} title="Show in Finder" aria-label={`Show ${baseName(f.path)} in Finder`}
        className="ml-2 grid size-8 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"><FolderSearch size={15} /></button>
    </li>
  );
}

export default function BigFiles({ scan, onTrash }: ViewProps) {
  const [filter, setFilter] = useState<CategoryKey | "all">("all");
  const sizes = useMemo(() => new Map(scan.bigFiles.filter((f) => f.trashable).map((f) => [f.path, f.size])), [scan.bigFiles]);
  const s = useSelection(sizes);
  const cats = useMemo(() => {
    const m = new Map<CategoryKey, number>();
    for (const f of scan.bigFiles) m.set(f.category, (m.get(f.category) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [scan.bigFiles]);
  const list = filter === "all" ? scan.bigFiles : scan.bigFiles.filter((f) => f.category === filter);

  return (
    <div>
      <PageHeader
        title="Big files"
        lead="Everything over 200 MB in your folders, plus your largest apps. Only you know what's still important, so nothing here is selected for you."
      />
      {scan.bigFiles.length === 0 ? (
        <Card><Empty icon={PartyPopper} title="No big files left">Nothing over 200 MB in your folders.</Empty></Card>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Filter by type">
            {([["all", scan.bigFiles.length], ...cats] as [CategoryKey | "all", number][]).map(([k, n]) => (
              <button key={k} role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}
                className={clsx("h-8 rounded-full px-3 text-[13px] transition-colors duration-100",
                  filter === k ? "bg-ink font-medium text-surface" : "border border-line bg-surface text-ink-2 hover:text-ink")}>
                {k === "all" ? "All" : CATEGORY[k].label} <span className="num opacity-60">{n}</span>
              </button>
            ))}
          </div>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              {list.map((f) => <FileRow key={f.path} f={f} checked={s.sel.has(f.path)} onCheck={(v) => s.toggle(f.path, v)} />)}
            </ul>
          </Card>
          {list.some((f) => f.kind === "app") && (
            <p className="mt-3 flex items-center gap-2 px-1 text-[12px] text-ink-3">
              Apps in the Applications folder are locked here. <Button variant="ghost" className="h-6 px-1.5 text-[12px]" onClick={() => api.reveal("/Applications")}>Open Applications</Button>
            </p>
          )}
        </>
      )}
      <SelectionBar count={s.sel.size} bytes={s.bytes} onClear={s.clear} onTrash={() => onTrash(s.items, s.clear)} />
    </div>
  );
}
