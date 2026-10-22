import { Search, X } from "lucide-react";
import type { KeyboardEvent, ReactNode, Ref } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Defaults to `placeholder` — pass a label when the field has a visible one. */
  ariaLabel?: string;
  id?: string;
  /** Applied to the relative wrapper (sizing / flex behaviour lives with the caller). */
  className?: string;
  /** `sm`: a 32 px field with the data text size (a sidebar). */
  size?: "default" | "sm";
  /** Renders a ghost clear button inside the field once there is a value. */
  clearable?: boolean;
  clearLabel?: string;
  /** The clear button's action. Default: `onChange("")`. */
  onClear?: () => void;
  /** Shown at the field's right end while it is empty, e.g. a shortcut keycap. */
  hint?: ReactNode;
  inputRef?: Ref<HTMLInputElement>;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  /** The id of a help text for the field. */
  describedBy?: string;
  /** The field's shortcut, e.g. "/". */
  keyShortcuts?: string;
}

/**
 * The icon + input + optional inline clear "search field" pattern.
 *
 * Callers own the query state and any surrounding toolbar chrome; this only
 * owns the field itself so the pattern isn't re-implemented per surface
 * (see `ListFilterBar` and the json-render `SearchInput` component).
 */
export function SearchBox({
  value,
  onChange,
  placeholder,
  ariaLabel,
  id,
  className,
  size = "default",
  clearable = false,
  clearLabel = "Clear search",
  onClear,
  hint,
  inputRef,
  onKeyDown,
  describedBy,
  keyShortcuts,
}: SearchBoxProps) {
  const showHint = Boolean(hint) && !value;
  const small = size === "sm";
  return (
    <div className={cn("relative min-w-0", className)}>
      <Search
        className={cn(
          "pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground",
          small ? "left-2.5 size-3.5" : "left-3 size-4",
        )}
      />
      <Input
        ref={inputRef}
        id={id}
        aria-label={ariaLabel ?? placeholder}
        aria-describedby={describedBy}
        aria-keyshortcuts={keyShortcuts}
        placeholder={placeholder}
        value={value}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        className={cn(
          small ? "h-8 pl-8 text-data md:text-data" : "pl-9",
          (clearable && value) || showHint ? "pr-9" : undefined,
        )}
      />
      {showHint ? (
        <span className="pointer-events-none absolute right-2.5 top-1/2 inline-flex -translate-y-1/2">
          {hint}
        </span>
      ) : null}
      {clearable && value ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={clearLabel}
          className={cn(
            "absolute top-1/2 -translate-y-1/2 text-muted-foreground",
            small ? "right-1 size-6" : "right-1 size-7",
          )}
          // The field keeps the focus, so typing goes on after a clear.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => (onClear ? onClear() : onChange(""))}
        >
          <X className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
