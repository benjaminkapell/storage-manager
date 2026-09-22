import { useCallback, useMemo, useState } from "react";

/** Tracks selected paths and the total size of what's selected. */
export function useSelection(sizes: Map<string, number>, labels?: Map<string, string>) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const toggle = useCallback((path: string, on: boolean) => {
    setSel((prev) => {
      const next = new Set(prev);
      if (on) next.add(path); else next.delete(path);
      return next;
    });
  }, []);
  const setMany = useCallback((paths: string[], on: boolean) => {
    setSel((prev) => {
      const next = new Set(prev);
      for (const p of paths) { if (on) next.add(p); else next.delete(p); }
      return next;
    });
  }, []);
  const clear = useCallback(() => setSel(new Set()), []);
  // Drop selections for items that disappeared (e.g. after moving them to the Trash).
  const live = useMemo(() => new Set([...sel].filter((p) => sizes.has(p))), [sel, sizes]);
  const bytes = useMemo(() => [...live].reduce((a, p) => a + (sizes.get(p) ?? 0), 0), [live, sizes]);
  const items = useMemo(() => [...live].map((path) => ({ path, size: sizes.get(path) ?? 0, label: labels?.get(path) })), [live, sizes, labels]);
  return { sel: live, toggle, setMany, clear, bytes, items };
}
