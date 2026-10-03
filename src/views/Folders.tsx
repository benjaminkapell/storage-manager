import { ChevronRight, FolderSearch, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ViewProps } from "../App";
import { Button, Card, PageHeader, SizeBar } from "../components/ui";
import { api } from "../lib/api";
import { ago, folderLabel, parentOf, prettyPath, size } from "../lib/format";

export default function Folders({ scan, go }: ViewProps) {
  const [path, setPath] = useState("/");
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);

  const { bySize, children } = useMemo(() => {
    const bySize = new Map(scan.folders.map((f) => [f.path, f.size]));
    const children = new Map<string, string[]>();
    for (const f of scan.folders) {
      const p = parentOf(f.path);
      if (p === null) continue;
      if (!children.has(p)) children.set(p, []);
      children.get(p)!.push(f.path);
    }
    for (const list of children.values()) list.sort((a, b) => (bySize.get(b) ?? 0) - (bySize.get(a) ?? 0));
    return { bySize, children };
  }, [scan.folders]);

  const kids = children.get(path) ?? [];
  const total = bySize.get(path) ?? 0;
  const inKids = kids.reduce((a, k) => a + (bySize.get(k) ?? 0), 0);
  const rest = total - inKids;
  const max = Math.max(bySize.get(kids[0]) ?? 0, rest);

  // The scan can be days old: check what's still really there.
  const kidsKey = kids.join("\n");
  useEffect(() => {
    setNote(null);
    const check = [path, ...kidsKey.split("\n").filter(Boolean)];
    api.pathsExist(check).then((ok) => setGone(new Set(check.filter((_, i) => !ok[i]))));
  }, [path, kidsKey]);
  const here = gone.has(path);

  const reveal = async (p: string) => {
    try {
      const fallback = await api.reveal(p);
      setNote(fallback ? `"${folderLabel(p)}" no longer exists, so Finder opened ${prettyPath(fallback)}, the closest folder that's still there.` : null);
    } catch (e) {
      setNote(String(e));
    }
  };

  const crumbs: string[] = [];
  for (let p: string | null = path; p !== null; p = parentOf(p)) crumbs.unshift(p);

  return (
    <div>
      <PageHeader
        title="Where it went"
        lead="Every folder on your Mac, biggest first. Click a folder to look inside. Folders under 100 MB are grouped as smaller items."
      />

      <nav aria-label="Folder path" className="mb-3 flex flex-wrap items-center gap-1 text-[13px]">
        {crumbs.map((c, i) => (
          <span key={c} className="flex items-center gap-1">
            {i > 0 && <ChevronRight size={13} className="text-ink-3" />}
            <button onClick={() => setPath(c)} className={i === crumbs.length - 1 ? "font-semibold text-ink" : "rounded px-1 text-ink-2 hover:bg-surface-2 hover:text-ink"}>
              {folderLabel(c)}
            </button>
          </span>
        ))}
      </nav>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-4 border-b border-line bg-surface-2/50 px-5 py-3">
          <div className="min-w-0">
            <div className="truncate font-semibold">{folderLabel(path)}</div>
            <div className="truncate text-[12px] text-ink-3">{prettyPath(path)}</div>
          </div>
          <div className="flex items-center gap-3">
            <span className="num text-[15px] font-semibold">{size(total)}</span>
            {path !== "/" && <Button icon={FolderSearch} onClick={() => reveal(path)}>Show in Finder</Button>}
          </div>
        </div>
        {(note || here) && (
          <div className="flex items-start gap-3 border-b border-line bg-warn-soft px-5 py-3 text-[13px]">
            <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warn-ink" />
            <p className="flex-1 leading-relaxed">
              {note ?? `This folder was deleted after your last scan (${ago(scan.finishedAt)}), so the sizes here are out of date.`}
            </p>
            {here && <Button icon={RefreshCw} onClick={() => go("overview")}>Scan again</Button>}
          </div>
        )}
        <ul className="divide-y divide-line">
          {kids.map((k) => {
            const s = bySize.get(k) ?? 0;
            const missing = gone.has(k);
            const deeper = !missing && (children.get(k)?.length ?? 0) > 0;
            return (
              <li key={k}>
                <button
                  onClick={() => deeper && setPath(k)}
                  disabled={missing}
                  className="group grid disabled:opacity-55 w-full grid-cols-[minmax(0,1fr)_minmax(120px,220px)_76px_28px] items-center gap-4 px-5 py-3 text-left transition-colors duration-100 hover:bg-surface-2/60"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{folderLabel(k)}</div>
                    <div className="truncate text-[12px] text-ink-3">{missing ? "Gone since your last scan" : `${Math.round((s / Math.max(total, 1)) * 100)}% of this folder`}</div>
                  </div>
                  <SizeBar value={s} max={max} color={missing ? "var(--c-system)" : undefined} />
                  <span className="num text-right font-medium">{size(s)}</span>
                  {missing ? <span /> : deeper ? <ChevronRight size={16} className="text-ink-3 group-hover:text-ink" /> : <span
                    role="button" tabIndex={0} title="Show in Finder" aria-label="Show in Finder"
                    onClick={(e) => { e.stopPropagation(); reveal(k); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); reveal(k); } }}
                    className="grid size-7 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"><FolderSearch size={15} /></span>}
                </button>
              </li>
            );
          })}
          {rest > 50e6 && (
            <li className="grid grid-cols-[minmax(0,1fr)_minmax(120px,220px)_76px_28px] items-center gap-4 px-5 py-3 text-ink-2">
              <div>
                <div>Smaller items</div>
                <div className="text-[12px] text-ink-3">Files and folders under 100 MB each</div>
              </div>
              <SizeBar value={rest} max={max} color="var(--c-system)" />
              <span className="num text-right">{size(rest)}</span>
              <span />
            </li>
          )}
        </ul>
      </Card>
      <p className="mt-3 px-1 text-[12px] text-ink-3">
        Sizes are from your last scan ({ago(scan.finishedAt)}). Anything deleted since then still counts until you scan again.
      </p>
    </div>
  );
}
