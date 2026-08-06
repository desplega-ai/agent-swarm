import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/**
 * The collapse pattern (DESIGN.md § Motion) as a reusable wrapper: height +
 * fade through AnimatePresence, exits faster than enters, snappy curve, and a
 * fade-only path under reduced motion. `speed="fast"` is the tier for
 * frequently-toggled surfaces (log-row expanders) — the more often an
 * interaction happens, the less motion it gets.
 */

const SNAPPY = [0.2, 0, 0, 1] as const;

const TIMINGS = {
  default: { enter: 0.2, exit: 0.15 },
  fast: { enter: 0.15, exit: 0.12 },
} as const;

export type RevealSpeed = keyof typeof TIMINGS;
export type RevealAxis = "y" | "x";

export function useRevealMotion(speed: RevealSpeed = "default", axis: RevealAxis = "y") {
  const reduceMotion = useReducedMotion();
  const { enter, exit } = TIMINGS[speed];
  if (reduceMotion) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0, transition: { duration: exit } },
      transition: { duration: enter },
    };
  }
  const closed = axis === "y" ? { height: 0, opacity: 0 } : { width: 0, opacity: 0 };
  const opened =
    axis === "y" ? { height: "auto" as const, opacity: 1 } : { width: "auto" as const, opacity: 1 };
  return {
    initial: closed,
    animate: opened,
    exit: { ...closed, transition: { duration: exit, ease: SNAPPY } },
    transition: { duration: enter, ease: SNAPPY },
  };
}

export function AnimatedReveal({
  open,
  speed = "default",
  axis = "y",
  className,
  children,
}: {
  open: boolean;
  speed?: RevealSpeed;
  /** "y" = height reveal (sections, log rows); "x" = width reveal (side
   * rails — the CHILD carries the fixed width, e.g. `w-48`, so "auto"
   * measures it). */
  axis?: RevealAxis;
  className?: string;
  children: React.ReactNode;
}) {
  const revealMotion = useRevealMotion(speed, axis);
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div className={cn("overflow-hidden", className)} {...revealMotion}>
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
