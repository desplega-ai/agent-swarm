"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";

export interface ClipboardCheckIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface ClipboardCheckIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

// Transform-only, and visible at rest: the old variant kept the check at
// opacity 0 until hover, so the sidebar glyph was missing its checkmark and
// the draw-in blanked on quick pass-overs. Now the check pops ("re-checked").
const CHECK_VARIANTS: Variants = {
  normal: {
    scale: 1,
    transition: {
      duration: 0.25,
      ease: "easeOut",
    },
  },
  animate: {
    scale: [1, 1.25, 1],
    transition: {
      duration: 0.3,
      ease: "easeOut",
    },
  },
};

const ClipboardCheckIcon = forwardRef<ClipboardCheckIconHandle, ClipboardCheckIconProps>(
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
        <svg
          aria-hidden="true"
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
          <rect height="4" rx="1" ry="1" width="8" x="8" y="2" />
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          <motion.path
            animate={controls}
            d="m9 14 2 2 4-4"
            initial="normal"
            style={{ transformBox: "view-box", originX: "12px", originY: "13px" }}
            variants={CHECK_VARIANTS}
          />
        </svg>
      </div>
    );
  },
);

ClipboardCheckIcon.displayName = "ClipboardCheckIcon";

export { ClipboardCheckIcon };
