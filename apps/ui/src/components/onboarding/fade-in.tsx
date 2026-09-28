import { motion } from "motion/react";
import type { ReactNode } from "react";

const SNAPPY = [0.2, 0, 0, 1] as const;

/**
 * Enter motion for `/setup` content that swaps in place (a form replaced by
 * its result, a new integration pane): a short fade and rise. Give it a `key`
 * at the call site to replay on each swap. Reduced motion keeps the fade only
 * (`MotionConfig reducedMotion="user"`).
 */
export function FadeIn({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: SNAPPY, delay }}
    >
      {children}
    </motion.div>
  );
}
