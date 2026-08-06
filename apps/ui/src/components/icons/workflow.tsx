"use client";

import type { Transition, Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";

export interface WorkflowIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface WorkflowIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const TRANSITION: Transition = {
  duration: 0.24,
  ease: "easeOut",
};

// Transform-only (no pathLength/opacity draw-in): the glyph must stay whole
// on quick pass-overs. The two nodes "ping" in sequence — a scale pulse
// around each rect's own center — while the connector stays put.
const VARIANTS: Variants = {
  normal: {
    scale: 1,
  },
  animate: (custom: number) => ({
    scale: [1, 1.15, 1],
    transition: {
      ...TRANSITION,
      delay: 0.06 * custom,
    },
  }),
};

const WorkflowIcon = forwardRef<WorkflowIconHandle, WorkflowIconProps>(
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
          <motion.rect
            animate={controls}
            custom={0}
            height="8"
            rx="2"
            style={{ transformBox: "view-box", originX: "7px", originY: "7px" }}
            variants={VARIANTS}
            width="8"
            x="3"
            y="3"
          />
          <path d="M7 11v4a2 2 0 0 0 2 2h4" />
          <motion.rect
            animate={controls}
            custom={1}
            height="8"
            rx="2"
            style={{ transformBox: "view-box", originX: "17px", originY: "17px" }}
            variants={VARIANTS}
            width="8"
            x="13"
            y="13"
          />
        </svg>
      </div>
    );
  },
);

WorkflowIcon.displayName = "WorkflowIcon";

export { WorkflowIcon };
