import { Search, X } from "lucide-react";
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
  /** Renders a ghost clear button inside the field once there is a value. */
  clearable?: boolean;
  clearLabel?: string;
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
  clearable = false,
  clearLabel = "Clear search",
}: SearchBoxProps) {
  return (
    <div className={cn("relative min-w-0", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        id={id}
        aria-label={ariaLabel ?? placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn("pl-9", clearable && value ? "pr-9" : undefined)}
      />
      {clearable && value ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={clearLabel}
          className="absolute right-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground"
          onClick={() => onChange("")}
        >
          <X className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
