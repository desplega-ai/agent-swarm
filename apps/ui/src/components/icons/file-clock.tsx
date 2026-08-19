"use client";

import type { Variants } from "motion/react";
import { domMin, LazyMotion, m, useAnimation, useReducedMotion } from "motion/react";
import { forwardRef, type HTMLAttributes, useCallback, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";
export interface FileClockIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface FileClockIconProps
  extends Omit<
    HTMLAttributes<HTMLDivElement>,
    | "color"
    | "onDrag"
    | "onDragStart"
    | "onDragEnd"
    | "onAnimationStart"
    | "onAnimationEnd"
    | "onAnimationIteration"
  > {
  size?: number;
  duration?: number;
  isAnimated?: boolean;
  color?: string;
}

const FileClockIcon = forwardRef<FileClockIconHandle, FileClockIconProps>(
  (
    {
      onMouseEnter,
      onMouseLeave,
      className,
      size = 24,
      duration = 1,
      isAnimated = true,
      color,
      ...props
    },
    ref,
  ) => {
    const controls = useAnimation();
    const reduced = useReducedMotion();
    const isControlled = useRef(false);

    useImperativeHandle(ref, () => {
      isControlled.current = true;
      return {
        startAnimation: () => (reduced ? controls.start("normal") : controls.start("animate")),
        stopAnimation: () => controls.start("normal"),
      };
    });

    const handleEnter = useCallback(
      (e?: React.MouseEvent<HTMLDivElement>) => {
        if (!isAnimated || reduced) return;
        if (!isControlled.current) void controls.start("animate");
        else if (e) onMouseEnter?.(e);
      },
      [controls, reduced, isAnimated, onMouseEnter],
    );

    const handleLeave = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (!isControlled.current) {
          void controls.start("normal");
        } else {
          if (e) onMouseLeave?.(e);
        }
      },
      [controls, onMouseLeave],
    );

    // Transform-only (no pathLength/opacity draw-in): the glyph must stay
    // whole on quick pass-overs. The file stays put; the clock dial pops and
    // its hands sweep back and settle — "time passing", never a blank face.
    const dialVariants: Variants = {
      normal: { scale: 1 },
      animate: {
        scale: [1, 1.1, 1],
        transition: {
          duration: 0.22 * duration,
          ease: [0.34, 1.4, 0.64, 1],
        },
      },
    };

    const handsVariants: Variants = {
      normal: { rotate: 0 },
      animate: {
        rotate: [0, -40, 12, 0],
        transition: {
          duration: 0.24 * duration,
          delay: 0.06 * duration,
          ease: [0.34, 1.4, 0.64, 1],
        },
      },
    };

    return (
      <LazyMotion features={domMin} strict>
        <m.div
          className={cn("inline-flex items-center justify-center", className)}
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
          {...props}
          style={{ color, ...props.style }}
        >
          <m.svg
            xmlns="http://www.w3.org/2000/svg"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            animate={controls}
            initial="normal"
          >
            <path d="M16 22h2a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v2.85" />
            <path d="M14 2v5a1 1 0 0 0 1 1h5" />
            <m.circle
              cx="8"
              cy="16"
              r="6"
              variants={dialVariants}
              style={{ transformBox: "view-box", originX: "8px", originY: "16px" }}
            />
            <m.path
              d="M8 14v2.2l1.6 1"
              variants={handsVariants}
              style={{ transformBox: "view-box", originX: "8px", originY: "16px" }}
            />
          </m.svg>
        </m.div>
      </LazyMotion>
    );
  },
);

FileClockIcon.displayName = "FileClockIcon";
export { FileClockIcon };
