import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A name filter box: a search icon, the input, and a clear button. Escape
 * clears it. The tree (`tree-rail.tsx`) and the folder header
 * (`folder-view.tsx`) use it.
 */
export function FilterInput({
  value,
  onChange,
  label,
  compact = false,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The placeholder and the accessible name ("Filter files"). */
  label: string;
  /** The tree's smaller box. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("relative flex items-center", className)}>
      <Search
        className={cn(
          "pointer-events-none absolute text-muted-foreground",
          compact ? "left-2 size-3.5" : "left-2.5 size-4",
        )}
        aria-hidden
      />
      <Input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            event.stopPropagation();
            onChange("");
          }
        }}
        placeholder={label}
        aria-label={label}
        className={cn(
          "w-full [&::-webkit-search-cancel-button]:hidden",
          compact ? "h-7 pr-7 pl-7 text-xs md:text-xs" : "h-8 pr-8 pl-8",
        )}
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear filter"
          onClick={() => onChange("")}
          className="absolute right-1.5 flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
