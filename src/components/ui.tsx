import clsx from "clsx";
import { Check, Lock, type LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({ variant = "secondary", icon: Icon, className, children, ...rest }: ComponentProps<"button"> & { variant?: Variant; icon?: LucideIcon }) {
  return (
    <button
      {...rest}
      className={clsx(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium whitespace-nowrap transition-[background-color,color,transform] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45",
        variant === "primary" && "bg-accent text-white hover:bg-accent-hover dark:text-[oklch(0.18_0.02_180)]",
        variant === "secondary" && "border border-line bg-surface text-ink shadow-[0_1px_1px_oklch(0.4_0.02_170/0.05)] hover:bg-surface-2",
        variant === "ghost" && "text-ink-2 hover:bg-surface-2 hover:text-ink",
        variant === "danger" && "bg-danger text-white hover:brightness-95",
        className,
      )}
    >
      {Icon && <Icon size={15} strokeWidth={2} className="-ml-0.5" />}
      {children}
    </button>
  );
}

export function Checkbox({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  if (disabled) {
    return (
      <span title="Roomy leaves this alone to keep your Mac safe. Use Show in Finder." className="grid size-11 shrink-0 place-items-center text-ink-3">
        <Lock size={14} />
      </span>
    );
  }
  return (
    <button
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      className="group grid size-11 shrink-0 place-items-center"
    >
      <span className={clsx(
        "grid size-[18px] place-items-center rounded-[5px] border transition-colors duration-100",
        checked ? "border-accent bg-accent text-white dark:text-[oklch(0.18_0.02_180)]" : "border-ink-3/60 bg-surface group-hover:border-accent",
      )}>
        {checked && <Check size={13} strokeWidth={3} />}
      </span>
    </button>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "safe" | "check" | "guide"; children: ReactNode }) {
  return (
    <span className={clsx(
      "inline-flex h-5 items-center rounded-md px-1.5 text-[11px] font-semibold whitespace-nowrap",
      tone === "neutral" && "bg-surface-2 text-ink-2",
      tone === "safe" && "bg-accent-soft text-accent-ink",
      tone === "check" && "bg-warn-soft text-warn-ink",
      tone === "guide" && "bg-surface-2 text-ink-2",
    )}>
      {children}
    </span>
  );
}

export function PageHeader({ title, lead, children }: { title: string; lead: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-[62ch]">
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.02em]">{title}</h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-ink-2">{lead}</p>
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </header>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx("rounded-2xl border border-line bg-surface shadow-card", className)}>{children}</div>;
}

export function Empty({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <span className="mb-4 grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent-ink"><Icon size={22} /></span>
      <h2 className="text-[17px] font-semibold">{title}</h2>
      {children && <div className="mt-1.5 max-w-[46ch] text-ink-2">{children}</div>}
    </div>
  );
}

/** Horizontal bar used in lists: fills relative to the biggest item. */
export function SizeBar({ value, max, color = "var(--accent)" }: { value: number; max: number; color?: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
      <div className="h-full rounded-full" style={{ width: `${Math.max(1.5, (value / Math.max(max, 1)) * 100)}%`, background: color }} />
    </div>
  );
}
