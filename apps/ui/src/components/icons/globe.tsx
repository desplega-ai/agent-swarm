"use client";

import type { Variants } from "motion/react";
import { domMin, LazyMotion, m, useAnimation, useReducedMotion } from "motion/react";
import { forwardRef, type HTMLAttributes, useCallback, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";
export interface GlobeIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface GlobeIconProps
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

const GlobeIcon = forwardRef<GlobeIconHandle, GlobeIconProps>(
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

    const svgVariants: Variants = {
      normal: {
        scale: 1,
        rotate: 0,
      },
      animate: {
        scale: [1, 1.03, 1],
        rotate: 360,
        transition: {
          rotate: {
            duration: 0.3 * duration,
            ease: "easeOut",
          },
          scale: {
            duration: 0.22 * duration,
            ease: "easeOut",
          },
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
            variants={svgVariants}
          >
            {/* Static geography — the whole-svg spin carries the gesture; the
                old meridian/equator pathLength re-draw blanked them mid-spin
                on quick pass-overs. */}
            <circle cx="12" cy="12" r="10" />
            <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
            <path d="M2 12h20" />
          </m.svg>
        </m.div>
      </LazyMotion>
    );
  },
);

GlobeIcon.displayName = "GlobeIcon";
export { GlobeIcon };
