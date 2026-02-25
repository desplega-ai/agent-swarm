import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface JsonViewerProps {
  data: unknown;
  title?: string;
  defaultExpanded?: boolean;
  className?: string;
}

export function JsonViewer({ data, title, defaultExpanded = false, className }: JsonViewerProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const formatted = typeof data === "string" ? data : JSON.stringify(data, null, 2);

  if (title) {
    return (
      <div className={cn("rounded-md border border-border/50", className)}>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center gap-2 px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          {title}
        </button>
        {expanded && (
          <pre className="overflow-auto border-t border-border/50 bg-muted/30 p-3 text-xs font-mono leading-relaxed text-foreground/80 max-h-96">
            {formatted}
          </pre>
        )}
      </div>
    );
  }

  return (
    <pre
      className={cn(
        "overflow-auto rounded-md bg-muted/30 p-3 text-xs font-mono leading-relaxed text-foreground/80 max-h-96",
        className,
      )}
    >
      {formatted}
    </pre>
  );
}
