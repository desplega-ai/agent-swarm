import { cn } from "@/lib/utils";

/**
 * The passage a comment is about, two lines at most. A `span`, so it also
 * fits inside a button. `struck`: the passage is no longer in the file.
 */
export function QuoteExcerpt({
  text,
  struck,
  className,
}: {
  text: string;
  struck?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "line-clamp-2 border-l-2 border-border pl-2 text-left text-xs text-muted-foreground",
        struck && "line-through",
        className,
      )}
    >
      {text}
    </span>
  );
}
