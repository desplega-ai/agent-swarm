"use client";

import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";

// Hand-written in the lucide-animated (pqoqubbw) vendored-icon pattern — the
// registry has no `cable` — using lucide's exact `cable` path data so the
// glyph stays pixel-identical to the static icon. Hovering sways the cable
// run between the two plugs (transform-only — the old pathLength re-draw
// blanked the cable on quick pass-overs).

export interface CableIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface CableIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const CableIcon = forwardRef<CableIconHandle, CableIconProps>(
  ({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
    const controls = useAnimation();
    const isControlledRef = useRef(false);

    useImperativeHandle(ref, () => {
      isControlledRef.current = true;

      return {
        startAnimation: () => controls.start("animate"),
        stopAnimation: () => controls.start("normal"),
      };
    });

    const handleMouseEnter = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) {
          onMouseEnter?.(e);
        } else {
          controls.start("animate");
        }
      },
      [controls, onMouseEnter],
    );

    const handleMouseLeave = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) {
          onMouseLeave?.(e);
        } else {
          controls.start("normal");
        }
      },
      [controls, onMouseLeave],
    );

    return (
      <div
        className={cn(className)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        {...props}
      >
        <motion.svg
          aria-hidden="true"
          animate={controls}
          fill="none"
          height={size}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width={size}
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M17 19a1 1 0 0 1-1-1v-2a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a1 1 0 0 1-1 1z" />
          <path d="M17 21v-2" />
          <motion.path
            d="M19 14V6.5a1 1 0 0 0-7 0v11a1 1 0 0 1-7 0V10"
            transition={{ duration: 0.3, ease: [0.2, 0, 0, 1] }}
            variants={{
              normal: { x: 0 },
              animate: { x: [0, -0.9, 0.9, 0] },
            }}
          />
          <path d="M21 21v-2" />
          <path d="M3 5V3" />
          <path d="M4 10a2 2 0 0 1-2-2V6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2a2 2 0 0 1-2 2z" />
          <path d="M7 5V3" />
        </motion.svg>
      </div>
    );
  },
);

CableIcon.displayName = "CableIcon";

export { CableIcon };
