import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const SNAPPY = [0.2, 0, 0, 1] as const;

/**
 * Next slides the new step in from the right, Back from the left. The old
 * step leaves the other way, faster than the new one enters.
 */
const SLIDE: Variants = {
  enter: (direction: 1 | -1) => ({ opacity: 0, x: direction * 28 }),
  center: { opacity: 1, x: 0, transition: { duration: 0.26, ease: SNAPPY } },
  exit: (direction: 1 | -1) => ({
    opacity: 0,
    x: direction * -20,
    transition: { duration: 0.14, ease: SNAPPY },
  }),
};

/** Reduced motion keeps only the fade (same pattern as `AnimatedReveal`). */
const FADE: Variants = {
  enter: { opacity: 0 },
  center: { opacity: 1, transition: { duration: 0.2, ease: SNAPPY } },
  exit: { opacity: 0, transition: { duration: 0.12, ease: SNAPPY } },
};

/**
 * Crossfades step content keyed by `stepKey`. `popLayout` takes the leaving
 * step out of the flow at once, so the new step lays out immediately and the
 * two animate together (no blank gap, no height jump under the fixed footer).
 * The step is a flex column that fills the height the parent gives it.
 */
export function StepTransition({
  stepKey,
  direction,
  className,
  children,
}: {
  stepKey: string;
  direction: 1 | -1;
  className?: string;
  children: ReactNode;
}) {
  const variants = useReducedMotion() ? FADE : SLIDE;
  return (
    <div className={cn("relative flex flex-col", className)}>
      <AnimatePresence mode="popLayout" initial={false} custom={direction}>
        <motion.div
          key={stepKey}
          custom={direction}
          variants={variants}
          initial="enter"
          animate="center"
          exit="exit"
          className="flex flex-1 flex-col"
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
