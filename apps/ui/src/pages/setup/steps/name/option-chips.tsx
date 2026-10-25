import { Check } from "lucide-react";
import { type KeyboardEvent, useId, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * A wrapping row of single-select chips (radio group semantics, roving tab
 * stop, arrow keys) for answer lists too long for a `SegmentedControl`.
 * Styled like the Approvals option chips. With `groups`, each option shows
 * under the heading of its `group`; the arrow keys still walk all options.
 */
export function OptionChips<T extends string>({
  options,
  groups,
  value,
  onValueChange,
  "aria-label": ariaLabel,
}: {
  options: ReadonlyArray<{ value: T; label: string; group?: string }>;
  groups?: ReadonlyArray<{ id: string; label: string }>;
  value: T | null;
  onValueChange: (value: T) => void;
  "aria-label": string;
}) {
  const id = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const tabStop = Math.max(
    options.findIndex((option) => option.value === value),
    0,
  );

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    buttons.current[next]?.focus();
    onValueChange(options[next].value);
  }

  function chips(items: typeof options) {
    return (
      <div className="flex flex-wrap gap-2">
        {items.map((option) => {
          const index = options.indexOf(option);
          const selected = option.value === value;
          return (
            // biome-ignore lint/a11y/useSemanticElements: a chip button; roving tabindex and arrow keys follow the WAI-ARIA radio group pattern
            <button
              key={option.value}
              ref={(el) => {
                buttons.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={index === tabStop ? 0 : -1}
              onClick={() => onValueChange(option.value)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "flex min-h-11 items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm transition-[background-color,border-color,color] duration-150 ease-snappy outline-none focus-visible:ring-2 focus-visible:ring-ring/60 sm:min-h-8",
                selected
                  ? "border-primary/60 bg-primary/10 font-medium text-foreground"
                  : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-full border",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground/40",
                )}
              >
                {selected ? <Check className="size-3" strokeWidth={3} /> : null}
              </span>
              {option.label}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex flex-col gap-3">
      {groups
        ? groups.map((group) => (
            // biome-ignore lint/a11y/useSemanticElements: a labeled subset inside the radio group, not a fieldset
            <div key={group.id} role="group" aria-labelledby={`${id}-${group.id}`}>
              <p id={`${id}-${group.id}`} className="mb-1.5 text-xs text-muted-foreground">
                {group.label}
              </p>
              {chips(options.filter((option) => option.group === group.id))}
            </div>
          ))
        : chips(options)}
    </div>
  );
}
