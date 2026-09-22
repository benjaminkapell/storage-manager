import { CircleCheck, TriangleAlert, Trash2, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { TrashItem } from "../App";
import { api, type TrashResult } from "../lib/api";
import { baseName, size } from "../lib/format";
import { Button } from "./ui";

export function ConfirmTrash({ items, busy, onCancel, onConfirm }: { items: TrashItem[]; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const total = items.reduce((a, i) => a + i.size, 0);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-[oklch(0.2_0.01_170/0.35)] p-6" onClick={() => !busy && onCancel()}>
      <div role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(e) => e.stopPropagation()}
        className="rise w-full max-w-[440px] rounded-2xl border border-line bg-surface p-6 shadow-[0_20px_60px_oklch(0.2_0.02_170/0.3)]">
        <span className="mb-4 grid size-10 place-items-center rounded-xl bg-accent-soft text-accent-ink"><Trash2 size={19} /></span>
        <h2 id="confirm-title" className="text-[17px] font-semibold">
          Move {items.length === 1 ? `“${items[0].label ?? baseName(items[0].path)}”` : `${items.length} items`} to the Trash?
        </h2>
        <p className="mt-2 leading-relaxed text-ink-2">
          That's <strong className="num text-ink">{size(total)}</strong>. Nothing is gone for good: you can still get
          everything back from the Trash until you empty it.
        </p>
        {items.length > 1 && (
          <ul className="mt-4 max-h-36 overflow-y-auto rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2">
            {items.slice(0, 50).map((i) => (
              <li key={i.path} className="flex justify-between gap-3 py-0.5">
                <span className="truncate">{i.label ?? baseName(i.path)}</span>
                <span className="num shrink-0">{size(i.size)}</span>
              </li>
            ))}
            {items.length > 50 && <li className="py-0.5">and {items.length - 50} more</li>}
          </ul>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button ref={confirmRef} variant="primary" icon={Trash2} onClick={onConfirm} disabled={busy}>
            {busy ? "Moving..." : "Move to Trash"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export interface ToastData { moved: number; bytes: number; failed: TrashResult[] }

export function Toast({ data, onClose }: { data: ToastData; onClose: () => void }) {
  useEffect(() => {
    if (data.failed.length) return;
    const t = setTimeout(onClose, 12000);
    return () => clearTimeout(t);
  }, [data, onClose]);
  const bad = data.failed.length > 0;
  return (
    <div className="pointer-events-none fixed bottom-5 left-[228px] right-0 z-50 flex justify-center px-10">
    <div role="status" className="rise pointer-events-auto w-full max-w-[560px] rounded-2xl border border-line bg-surface p-4 shadow-[0_12px_40px_oklch(0.2_0.02_170/0.22)]">
      <div className="flex gap-3">
        {bad ? <TriangleAlert size={20} className="mt-0.5 shrink-0 text-warn" /> : <CircleCheck size={20} className="mt-0.5 shrink-0 text-accent" />}
        <div className="flex-1">
          {data.moved > 0 && (
            <p className="font-medium">
              Moved {data.moved} item{data.moved > 1 ? "s" : ""} to the Trash.
              <span className="font-normal text-ink-2"> Empty the Trash to actually get the <span className="num">{size(data.bytes)}</span> back.</span>
            </p>
          )}
          {bad && (
            <div className="mt-1 text-[13px] text-ink-2">
              <p>{data.failed.length} item{data.failed.length > 1 ? "s" : ""} couldn't be moved:</p>
              <ul className="mt-1 max-h-24 overflow-y-auto">
                {data.failed.slice(0, 6).map((f) => <li key={f.path} className="truncate">{baseName(f.path)}: {f.error}</li>)}
              </ul>
            </div>
          )}
          {data.moved > 0 && <Button className="mt-3" icon={Trash2} onClick={() => api.open("trash")}>Open Trash</Button>}
        </div>
        <button onClick={onClose} aria-label="Close" className="grid size-7 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"><X size={15} /></button>
      </div>
    </div>
    </div>
  );
}

/** Sticky bar at the bottom of a list once something is selected. */
export function SelectionBar({ count, bytes, onClear, onTrash }: { count: number; bytes: number; onClear: () => void; onTrash: () => void }) {
  if (count === 0) return null;
  return (
    <div className="rise fixed bottom-5 left-[228px] right-0 z-30 flex justify-center px-10 pointer-events-none">
      <div className="pointer-events-auto flex w-full max-w-[640px] items-center gap-3 rounded-2xl border border-line bg-surface py-2.5 pr-2.5 pl-5 shadow-[0_12px_40px_oklch(0.2_0.02_170/0.2)]">
        <p className="flex-1">
          <span className="font-semibold">{count} selected</span>
          <span className="num text-ink-2"> · {size(bytes)}</span>
        </p>
        <Button variant="ghost" onClick={onClear}>Clear</Button>
        <Button variant="primary" icon={Trash2} onClick={onTrash}>Move to Trash</Button>
      </div>
    </div>
  );
}
