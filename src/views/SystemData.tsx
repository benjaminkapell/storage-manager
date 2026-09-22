import { CircleCheck, Settings2 } from "lucide-react";
import { useMemo } from "react";
import type { ViewProps } from "../App";
import { SelectionBar } from "../components/TrashFlow";
import { Button, Card, Empty, PageHeader } from "../components/ui";
import { api } from "../lib/api";
import { size } from "../lib/format";
import { useSelection } from "../lib/useSelection";
import { FindingRow } from "./CleanUp";

const SECTIONS: { title: string; lead: string; groups: string[] }[] = [
  { title: "Your stuff in Apple apps", lead: "Photos, email, messages and phone backups.", groups: ["photos", "backups", "messages", "mail", "icloud"] },
  { title: "Data apps keep for themselves", lead: "Only the app that made it can clean it safely.", groups: ["appdata", "docker"] },
  { title: "macOS itself", lead: "Things macOS manages. A restart often shrinks them.", groups: ["temp", "swap", "snapshots", "hidden"] },
];

export default function SystemData({ scan, onTrash }: ViewProps) {
  const sizes = useMemo(() => new Map(scan.system.filter((f) => f.trashable && f.path).map((f) => [f.path!, f.size])), [scan.system]);
  const labels = useMemo(() => new Map(scan.system.filter((f) => f.path).map((f) => [f.path!, f.title])), [scan.system]);
  const s = useSelection(sizes, labels);

  return (
    <div>
      <PageHeader
        title="System data"
        lead={<>The part of your disk that shows up as "System Data" in Mac settings. Most of it can't simply be thrown away, so each item comes with <strong className="text-ink">How to shrink it</strong> steps.</>}
      >
        <Button icon={Settings2} onClick={() => api.open("storage-settings")}>Mac storage settings</Button>
      </PageHeader>

      {scan.system.length === 0 ? (
        <Card><Empty icon={CircleCheck} title="Nothing big here">No large system data found.</Empty></Card>
      ) : (
        <div className="flex flex-col gap-6">
          {SECTIONS.map((sec) => {
            const list = scan.system.filter((f) => sec.groups.includes(f.group));
            if (list.length === 0) return null;
            return (
              <section key={sec.title}>
                <div className="mb-2 flex items-baseline justify-between px-1">
                  <div>
                    <h2 className="text-[15px] font-semibold">{sec.title}</h2>
                    <p className="text-[13px] text-ink-2">{sec.lead}</p>
                  </div>
                  <span className="num text-[13px] text-ink-2">{size(list.reduce((a, f) => a + f.size, 0))}</span>
                </div>
                <Card className="overflow-hidden">
                  <ul className="divide-y divide-line">
                    {list.map((f) => <FindingRow key={f.id} f={f} checked={s.sel.has(f.path ?? "")} onCheck={f.trashable ? (v) => f.path && s.toggle(f.path, v) : undefined} />)}
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
