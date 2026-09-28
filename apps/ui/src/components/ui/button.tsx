import { cva, type VariantProps } from "class-variance-authority";
import { CheckIcon } from "lucide-react";
import {
  AnimatePresence,
  motion,
  type Transition,
  useReducedMotion,
  type Variants,
} from "motion/react";
import { Slot } from "radix-ui";
import type * as React from "react";
import { useEffect } from "react";

import { cn } from "@/lib/utils";

// Relative on purpose: the root `bun test` run cannot resolve ui's `@/` alias,
// so ui tests mock each aliased module they reach. A relative import keeps
// every test that renders Button from needing its own Spinner mock.
import { Spinner } from "./spinner";

const buttonVariants = cva(
  // Transitions live in globals.css ("Button motion", keyed on
  // [data-slot="button"]): colors follow the hover-linger timing while the
  // press scale keeps its own fast-in / eased-out timing — a per-property
  // split Tailwind utilities can't express. Don't re-add `transition-*` here.
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium active:scale-[0.98] motion-reduce:active:scale-100 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/60 focus-visible:ring-2 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        "destructive-outline":
          "border bg-background shadow-xs border-status-error/30 text-status-error-strong hover:bg-status-error/10 dark:bg-input/30",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // Small/icon sizes press one step deeper (0.97): on a 24-36px control a
      // 2% scale is sub-pixel and reads as nothing. tailwind-merge keeps the
      // size entry's `active:scale-*` over the base 0.98.
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3 active:scale-[0.97]",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5 active:scale-[0.97]",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9 active:scale-[0.97]",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3 active:scale-[0.97]",
        "icon-sm": "size-8 active:scale-[0.97]",
        "icon-lg": "size-10 active:scale-[0.97]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export type ButtonStatus = "idle" | "loading" | "success";

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /**
     * Status variant (from chanhdai's Status Button): the label swaps to a
     * spinner while "loading" and to a check on "success", at a fixed width.
     * Controlled: derive it from the mutation. Omit it for a plain button.
     * Ignored with `asChild`.
     */
    status?: ButtonStatus;
    /** Shown next to the check on "success", e.g. "Saved" for a "Save" button. */
    successLabel?: React.ReactNode;
    /** Called with "idle" `successDuration` ms after the status turns "success". */
    onStatusChange?: (status: ButtonStatus) => void;
    successDuration?: number;
  };

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  status,
  successLabel,
  onStatusChange,
  successDuration,
  ...props
}: ButtonProps) {
  if (status !== undefined && !asChild) {
    return (
      <StatusButton
        className={className}
        variant={variant}
        size={size}
        status={status}
        successLabel={successLabel}
        onStatusChange={onStatusChange}
        successDuration={successDuration}
        {...props}
      />
    );
  }

  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

const swapVariants: Variants = {
  initial: { opacity: 0, y: 8, filter: "blur(4px)" },
  animate: { opacity: 1, y: 0, filter: "blur(0px)" },
  exit: { opacity: 0, y: -8, filter: "blur(4px)" },
};

const reducedMotionVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
};

// A spring keeps its velocity when the status changes mid-swap; a
// cubic-bezier would restart from zero.
const swapTransition: Transition = { type: "spring", duration: 0.3, bounce: 0 };

// Bounce only on the entrance, and only on movement: opacity and blur would
// overshoot.
const successVariants: Variants = {
  ...swapVariants,
  animate: {
    ...swapVariants.animate,
    transition: {
      type: "spring",
      duration: 0.45,
      bounce: 0.35,
      opacity: swapTransition,
      filter: swapTransition,
    },
  },
};

function StatusButton({
  className,
  variant,
  size,
  status,
  successLabel,
  onStatusChange,
  successDuration = 1500,
  onClick,
  children,
  ...props
}: Omit<ButtonProps, "asChild" | "status"> & { status: ButtonStatus }) {
  const shouldReduceMotion = useReducedMotion();

  useEffect(() => {
    if (status !== "success" || !onStatusChange) return;
    const timeoutId = window.setTimeout(() => onStatusChange("idle"), successDuration);
    return () => window.clearTimeout(timeoutId);
  }, [status, successDuration, onStatusChange]);

  const isBusy = status !== "idle";
  const variants = shouldReduceMotion ? reducedMotionVariants : swapVariants;
  const transition = shouldReduceMotion ? { duration: 0 } : swapTransition;
  const successContent = (
    <>
      <CheckIcon />
      {successLabel ?? <span className="sr-only">Success</span>}
    </>
  );

  return (
    <button
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-status={status}
      aria-busy={status === "loading"}
      // Neither `disabled` nor `aria-disabled` while busy: the button keeps
      // focus and its normal look (callers style `aria-disabled` as blocked),
      // and presses are ignored meanwhile, including a form's implicit submit.
      onClick={(event) => {
        if (isBusy) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      className={cn(
        buttonVariants({ variant, size }),
        "inline-grid justify-items-center *:col-start-1 *:row-start-1 *:flex *:items-center *:gap-[inherit]",
        className,
      )}
      {...props}
    >
      {/* Invisible copies of the widest states keep the button's width fixed. */}
      <span aria-hidden className="invisible">
        {children}
      </span>
      <span aria-hidden className="invisible">
        {successContent}
      </span>
      <AnimatePresence initial={false}>
        {status === "idle" && (
          <motion.span
            key="idle"
            variants={variants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={transition}
          >
            {children}
          </motion.span>
        )}
        {status === "loading" && (
          <motion.span
            key="loading"
            role="status"
            variants={variants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={transition}
          >
            <Spinner aria-hidden />
            <span className="sr-only">Loading</span>
          </motion.span>
        )}
        {status === "success" && (
          <motion.span
            key="success"
            role="status"
            variants={shouldReduceMotion ? variants : successVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={transition}
          >
            {successContent}
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}

export { Button, buttonVariants };
