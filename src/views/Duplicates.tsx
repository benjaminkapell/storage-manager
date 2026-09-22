import { CopyCheck, Info } from "lucide-react";
import { useMemo, useState } from "react";
import type { ViewProps } from "../App";
import { SelectionBar } from "../components/TrashFlow";
import { Badge, Button, Card, Empty, PageHeader } from "../components/ui";
import { baseName, size } from "../lib/format";
import { useSelection } from "../lib/useSelection";
import { FileRow } from "./BigFiles";

const PAGE = 40;

export default function Duplicates({ scan, onTrash }: ViewProps) {
  const groups = scan.duplicates;
  const sizes = useMemo(() => new Map(groups.flatMap((g) => g.files.filter((f) => f.trashable).map((f) => [f.path, f.size] as const))), [groups]);
  const s = useSelection(sizes);
  const [shown, setShown] = useState(PAGE);
  const [warn, setWarn] = useState<string | null>(null);
  const total = groups.reduce((a, g) => a + g.wasted, 0);

  // Never let every copy of a file be selected: at least one always stays.
  const toggle = (groupIdx: number, path: string, on: boolean) => {
    const g = groups[groupIdx];
    if (on && g.files.filter((f) => f.path !== path && !s.sel.has(f.path)).length === 0) {
      setWarn(path);
      return;
    }
    setWarn(null);
    s.toggle(path, on);
  };

  const selectExtras = () => {
    s.setMany(groups.flatMap((g) => g.files.slice(1).filter((f) => f.trashable).map((f) => f.path)), true);
    // Make sure the kept copy isn't selected.
    s.setMany(groups.map((g) => g.files[0].path), false);
  };

  return (
    <div>
      <PageHeader
        title="Duplicates"
        lead={<>Files that exist more than once with exactly the same content. Removing the extra copies would give back <strong className="num text-ink">{size(total)}</strong>. Roomy always keeps at least one copy.</>}
      >
        {groups.length > 0 && <Button variant="primary" icon={CopyCheck} onClick={selectExtras}>Select all extra copies</Button>}
      </PageHeader>

      {groups.length === 0 ? (
        <Card><Empty icon={CopyCheck} title="No duplicates found">Every file in your folders is one of a kind.</Empty></Card>
      ) : (
        <>
          <p className="mb-4 flex gap-2 rounded-xl bg-surface-2 px-4 py-3 text-[13px] leading-relaxed text-ink-2">
            <Info size={16} className="mt-0.5 shrink-0" />
            <span>"Select all extra copies" keeps the <strong className="text-ink">oldest copy</strong> of each file, which is usually the original. Check that the one you keep is in the folder you want.</span>
          </p>
          <div className="flex flex-col gap-3">
            {groups.slice(0, shown).map((g, gi) => (
              <Card key={g.files[0].path} className="overflow-hidden">
                <div className="flex items-baseline justify-between gap-4 border-b border-line px-5 py-3">
                  <h3 className="truncate font-semibold">{baseName(g.files[0].path)}</h3>
                  <span className="shrink-0 text-[13px] text-ink-2">
                    {g.files.length} copies of <span className="num">{size(g.size)}</span> · save <strong className="num text-accent-ink">{size(g.wasted)}</strong>
                  </span>
                </div>
                <ul className="divide-y divide-line">
                  {g.files.map((f, i) => (
                    <FileRow key={f.path} f={f} checked={s.sel.has(f.path)} onCheck={(v) => toggle(gi, f.path, v)}
                      badge={<>
                        {i === 0 && <Badge tone="safe">Oldest</Badge>}
                        {warn === f.path && <Badge tone="check">Keep at least one copy</Badge>}
                      </>} />
                  ))}
                </ul>
              </Card>
            ))}
          </div>
          {shown < groups.length && (
            <div className="mt-4 flex justify-center">
              <Button onClick={() => setShown((n) => n + PAGE)}>Show more ({groups.length - shown} left)</Button>
            </div>
          )}
        </>
      )}
      <SelectionBar count={s.sel.size} bytes={s.bytes} onClear={s.clear} onTrash={() => onTrash(s.items, s.clear)} />
    </div>
  );
}
