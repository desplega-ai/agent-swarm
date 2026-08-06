"use client";

import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";

// Hand-written in the lucide-animated (pqoqubbw) vendored-icon pattern — the
// registry has no `list-todo` — using lucide's exact `list-todo` path data so
// the glyph stays pixel-identical to the static icon. Hovering pops the
// checkmark (transform-only — a pathLength draw-in would blank the check on
// quick pass-overs).

export interface ListTodoIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface ListTodoIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const ListTodoIcon = forwardRef<ListTodoIconHandle, ListTodoIconProps>(
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
          <path d="M13 5h8" />
          <path d="M13 12h8" />
          <path d="M13 19h8" />
          <rect x="3" y="4" width="6" height="6" rx="1" />
          <motion.path
            d="m3 17 2 2 4-4"
            style={{ transformBox: "view-box", originX: "6px", originY: "17px" }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            variants={{
              normal: { scale: 1 },
              animate: { scale: [1, 1.25, 1] },
            }}
          />
        </motion.svg>
      </div>
    );
  },
);

ListTodoIcon.displayName = "ListTodoIcon";

export { ListTodoIcon };
