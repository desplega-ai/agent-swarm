import { ChevronRight } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A reusable collapsible section with a clickable header that toggles content visibility.
 * Supports two variants:
 * - "plain" (default): minimal styling with just a toggle header
 * - "card": bordered card with optional icon and color theming
 */
/**
 * Read the persisted open/closed state for `persistKey` from `localStorage`,
 * falling back to `defaultOpen` when the key is absent, unparseable, or
 * `localStorage` is unavailable (private mode / quota).
 */
function readPersistedOpen(persistKey: string | undefined, defaultOpen: boolean): boolean {
  if (!persistKey) return defaultOpen;
  try {
    const raw = localStorage.getItem(persistKey);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return defaultOpen;
  } catch {
    return defaultOpen;
  }
}

const SNAPPY = [0.2, 0, 0, 1] as const;

/**
 * Height + fade for the open/close reveal (DESIGN.md § Motion: user-initiated
 * section toggle — 200ms enter, 150ms exit, snappy curve). Under reduced
 * motion the height movement drops and only the fade remains.
 */
function useRevealMotion() {
  const reduceMotion = useReducedMotion();
  if (reduceMotion) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0, transition: { duration: 0.15 } },
      transition: { duration: 0.2 },
    };
  }
  return {
    initial: { height: 0, opacity: 0 },
    animate: { height: "auto", opacity: 1 },
    exit: { height: 0, opacity: 0, transition: { duration: 0.15, ease: SNAPPY } },
    transition: { duration: 0.2, ease: SNAPPY },
  };
}

export function CollapsibleSection({
  title,
  icon: Icon,
  iconColor,
  borderColor,
  bgColor,
  children,
  defaultOpen = false,
  variant = "plain",
  className,
  badge,
  persistKey,
}: {
  title: string;
  icon?: React.ElementType;
  iconColor?: string;
  borderColor?: string;
  bgColor?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  variant?: "plain" | "card";
  className?: string;
  badge?: React.ReactNode;
  /**
   * When set, the open/closed state is persisted to `localStorage` under this
   * key and restored on remount. Absent → pure local `defaultOpen` state.
   */
  persistKey?: string;
}) {
  const [open, setOpen] = useState(() => readPersistedOpen(persistKey, defaultOpen));
  const revealMotion = useRevealMotion();

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (persistKey) {
      try {
        localStorage.setItem(persistKey, String(next));
      } catch {
        // Ignore — private mode / quota. State still toggles in-memory.
      }
    }
  };

  const chevron = (
    <ChevronRight
      className={cn(
        "h-3 w-3 shrink-0 transition-transform duration-150 ease-snappy motion-reduce:transition-none",
        open && "rotate-90",
        variant === "card" ? iconColor : "text-muted-foreground",
      )}
    />
  );

  if (variant === "card") {
    return (
      <div className={cn("rounded-md border shrink-0", borderColor, bgColor, className)}>
        <button
          type="button"
          onClick={toggle}
          className="flex items-center gap-2 w-full px-3 py-2 text-left"
        >
          {chevron}
          {Icon && <Icon className={cn("h-3.5 w-3.5 shrink-0", iconColor)} />}
          <span className={cn("text-xs font-semibold", iconColor)}>{title}</span>
          {badge}
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div className="overflow-hidden" {...revealMotion}>
              <div className="px-3 pb-2.5">{children}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className={cn("space-y-1", className)}>
      <button type="button" onClick={toggle} className="flex items-center gap-1.5 text-left group">
        {chevron}
        {Icon && <Icon className={cn("h-3 w-3 text-muted-foreground", iconColor)} />}
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
          {title}
        </span>
        {badge}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="overflow-hidden" {...revealMotion}>
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
