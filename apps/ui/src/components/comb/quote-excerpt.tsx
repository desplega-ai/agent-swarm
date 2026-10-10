import { cn } from "@/lib/utils";

/**
 * The passage a comment is about, two lines at most. A `span`, so it also
 * fits inside a button. `struck`: the passage is no longer in the file.
 * `mono`: the file is code or text, so the quote uses the file's font.
 */
export function QuoteExcerpt({
  text,
  struck,
  mono,
  className,
}: {
  text: string;
  struck?: boolean;
  mono?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "line-clamp-2 border-l-2 border-border pl-2 text-left text-xs text-muted-foreground",
        struck && "line-through",
        mono && "font-mono",
        className,
      )}
    >
      {text}
    </span>
  );
}
