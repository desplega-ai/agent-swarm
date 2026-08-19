"use client";

import type { Variants } from "motion/react";
import { domMin, LazyMotion, m, useAnimation, useReducedMotion } from "motion/react";
import { forwardRef, type HTMLAttributes, useCallback, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";
export interface BookOpenIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface BookOpenIconProps
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

const BookOpenIcon = forwardRef<BookOpenIconHandle, BookOpenIconProps>(
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
      (e?: React.MouseEvent<HTMLDivElement>) => {
        if (!isControlled.current) void controls.start("normal");
        else if (e) onMouseLeave?.(e);
      },
      [controls, onMouseLeave],
    );

    const iconVariants: Variants = {
      normal: { scale: 1, rotate: 0 },
      animate: {
        scale: [1, 1.05, 0.97, 1],
        rotate: [0, -2, 2, 0],
        transition: { duration: 0.3 * duration, ease: [0.2, 0, 0, 1] },
      },
    };

    const pagesVariants: Variants = {
      normal: { scale: 1, opacity: 1 },
      animate: {
        scale: [1, 1.05, 0.98, 1],
        opacity: [0.9, 1, 1],
        transition: { duration: 0.24 * duration, ease: [0.2, 0, 0, 1], delay: 0.06 },
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
            variants={iconVariants}
          >
            {/* Static spine — a pathLength draw-in blanked it on quick
                pass-overs; the whole-icon wiggle carries the gesture. */}
            <path d="M12 7v14" />
            <m.path
              d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"
              variants={pagesVariants}
              initial="normal"
              animate={controls}
            />
          </m.svg>
        </m.div>
      </LazyMotion>
    );
  },
);

BookOpenIcon.displayName = "BookOpenIcon";
export { BookOpenIcon };
