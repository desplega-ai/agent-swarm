import { useState } from "react";
import { Streamdown } from "streamdown";
import { cn, normalizeNewlines } from "@/lib/utils";

interface CollapsibleDescriptionProps {
  text: string;
  /** Tailwind class for the muted/foreground text color. Defaults to "text-foreground". */
  textClassName?: string;
}

export function CollapsibleDescription({
  text,
  textClassName = "text-foreground",
}: CollapsibleDescriptionProps) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 120 || text.includes("\n");

  if (!isLong) {
    return (
      <div className={cn("text-sm leading-relaxed", textClassName)}>
        <Streamdown>{normalizeNewlines(text)}</Streamdown>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {expanded ? (
        <div className={cn("text-sm leading-relaxed max-h-[60vh] overflow-y-auto", textClassName)}>
          <Streamdown>{normalizeNewlines(text)}</Streamdown>
        </div>
      ) : (
        <p className={cn("text-sm leading-relaxed line-clamp-1", textClassName)}>
          {text.split("\n")[0]}
        </p>
      )}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {expanded ? "Show less" : "Show more"}
      </button>
    </div>
  );
}
