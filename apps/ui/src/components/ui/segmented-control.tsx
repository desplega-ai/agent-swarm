import { motion, type Transition } from "motion/react";
import { Fragment, type KeyboardEvent, type ReactNode, useId, useRef } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Same spring as the `/setup` stepper pill. */
const SPRING: Transition = { type: "spring", stiffness: 520, damping: 42, mass: 0.9 };

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Shown on hover and focus. */
  tooltip?: ReactNode;
  /**
   * Unavailable: cannot be picked, but stays hoverable and reachable by the
   * arrow keys, so its tooltip (the reason) shows on hover and focus. Screen
   * readers get the tooltip as the option's description.
   */
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  /** `null` selects no option (for example, a mixed state). */
  value: T | null;
  onValueChange: (value: T) => void;
  options: readonly SegmentedControlOption<T>[];
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** `default` is the 36px control height, `sm` is 28px. */
  size?: "default" | "sm";
  disabled?: boolean;
  className?: string;
}

/**
 * A row of mutually exclusive options (radio group semantics). An amber pill
 * sits behind the selected option and slides to a new one on a spring
 * (transform only; reduced motion drops the slide). Arrow keys, Home, and
 * End move the selection like native radios. On an unavailable option they
 * move focus only: its reason shows, and the selection stays. Clicking the
 * selected option calls `onValueChange` again, so a caller can use it as a
 * retry.
 */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  size = "default",
  disabled = false,
  className,
}: SegmentedControlProps<T>) {
  // One pill per control, so two controls never share a slide.
  const pillId = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const pickable = (index: number) => !disabled && !options[index]?.disabled;
  const checkedIndex = options.findIndex((option) => option.value === value);
  // Roving tab stop: the selected option, else the first one that can be
  // picked, else the first one (an unavailable option still shows its reason).
  const firstPickable = options.findIndex((_, index) => pickable(index));
  const tabStop = checkedIndex >= 0 ? checkedIndex : Math.max(firstPickable, 0);

  // Focus follows the arrow keys over every option. Only an available one is
  // selected: an unavailable one gets focus, so its tooltip shows the reason.
  function moveTo(index: number) {
    buttons.current[index]?.focus();
    if (pickable(index)) onValueChange(options[index].value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const count = options.length;
    let target: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        target = (index + 1) % count;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        target = (index - 1 + count) % count;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = count - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    moveTo(target);
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-disabled={disabled || undefined}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5",
        size === "sm" ? "h-7" : "h-9",
        disabled && "opacity-50",
        className,
      )}
    >
      {options.map((option, index) => {
        const checked = index === checkedIndex;
        const unavailable = !disabled && option.disabled;
        // The reason of an unavailable option, for screen readers (hover and
        // focus show the same text in the tooltip).
        const reasonId = unavailable && option.tooltip ? `${pillId}-reason-${index}` : undefined;
        const button = (
          // biome-ignore lint/a11y/useSemanticElements: a button hosts the tooltip trigger and the pill; roving tabindex and arrow keys follow the WAI-ARIA radio group pattern
          <button
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            // `aria-disabled`, not `disabled`: an unavailable option stays
            // hoverable and focusable, so its tooltip can show the reason.
            aria-disabled={unavailable || undefined}
            // Only when set: an explicit `undefined` would override the
            // description the tooltip trigger adds while it is open.
            {...(reasonId ? { "aria-describedby": reasonId } : {})}
            disabled={disabled}
            tabIndex={index === tabStop ? 0 : -1}
            onClick={() => {
              if (pickable(index)) onValueChange(option.value);
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "relative isolate inline-flex h-full min-w-0 items-center justify-center gap-1.5 rounded-[5px] font-medium whitespace-nowrap outline-none transition-colors hover-linger",
              "focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3.5 [&_svg]:shrink-0",
              size === "sm" ? "px-2 text-xs" : "px-3 text-xs",
              checked
                ? "text-primary-foreground"
                : "text-muted-foreground enabled:hover:text-foreground",
              unavailable && "cursor-not-allowed opacity-50 enabled:hover:text-muted-foreground",
            )}
          >
            {checked ? (
              <motion.span
                layoutId={pillId}
                transition={SPRING}
                // Motion corrects the radius under layout scale only when it is a style.
                style={{ borderRadius: 5 }}
                aria-hidden="true"
                className="absolute inset-0 -z-10 bg-primary shadow-xs"
              />
            ) : null}
            {option.label}
          </button>
        );
        return (
          <Fragment key={option.value}>
            {reasonId ? (
              <span id={reasonId} className="sr-only">
                {option.tooltip}
              </span>
            ) : null}
            {option.tooltip ? (
              <Tooltip>
                <TooltipTrigger asChild>{button}</TooltipTrigger>
                <TooltipContent side="top" className="max-w-72">
                  {option.tooltip}
                </TooltipContent>
              </Tooltip>
            ) : (
              button
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
