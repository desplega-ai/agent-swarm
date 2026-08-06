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

export function useRevealMotion(speed: RevealSpeed = "default") {
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
  return {
    initial: { height: 0, opacity: 0 },
    animate: { height: "auto", opacity: 1 },
    exit: { height: 0, opacity: 0, transition: { duration: exit, ease: SNAPPY } },
    transition: { duration: enter, ease: SNAPPY },
  };
}

export function AnimatedReveal({
  open,
  speed = "default",
  className,
  children,
}: {
  open: boolean;
  speed?: RevealSpeed;
  className?: string;
  children: React.ReactNode;
}) {
  const revealMotion = useRevealMotion(speed);
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
