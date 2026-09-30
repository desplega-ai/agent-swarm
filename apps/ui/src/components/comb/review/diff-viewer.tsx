// Ported from agent-fs `live/src/components/viewers/DiffViewer.tsx` (agent-fs
// 0.15.0), same props. Comb changes: line numbers come from `diffLines`
// (agent-fs's own numbers when it sends them, else live/'s count), status
// tokens replace the green and red palette literals, long unchanged runs fold
// ("Show 24 unchanged lines"), a row marks the lines left out between hunks,
// long lines wrap at spaces (`break-words`, not `break-all`), and each
// changed line tells screen readers whether it was added or removed.

import { ChevronsUpDown, Ellipsis } from "lucide-react";
import { useMemo, useState } from "react";
import type { DiffChange } from "@/lib/agent-fs/types";
import { type DiffLine, diffLines, diffRows } from "@/lib/comb/diff-lines";
import { cn } from "@/lib/utils";

interface DiffViewerProps {
  changes: DiffChange[];
  className?: string;
}

function unchangedLines(count: number) {
  return `${count} unchanged ${count === 1 ? "line" : "lines"}`;
}

export function DiffViewer({ changes, className }: DiffViewerProps) {
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(() => new Set());
  const rows = useMemo(() => diffRows(diffLines(changes), unfolded), [changes, unfolded]);

  return (
    <div className={cn("overflow-auto font-mono text-xs", className)}>
      {rows.map((row) => {
        if (row.kind === "line") return <Line key={`l${row.index}`} line={row.line} />;
        if (row.kind === "gap") {
          return (
            <div
              key={`g${row.before}`}
              className="flex items-center gap-2 border-y border-dashed border-border-subtle py-1 pl-24 text-muted-foreground"
            >
              <Ellipsis className="size-3.5" aria-hidden />
              {unchangedLines(row.lines)}
            </div>
          );
        }
        return (
          <button
            key={`f${row.id}`}
            type="button"
            onClick={() => setUnfolded((current) => new Set(current).add(row.id))}
            className="hover-linger flex w-full items-center gap-2 border-y border-border-subtle bg-muted/40 py-1 pl-24 text-left text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
          >
            <ChevronsUpDown className="size-3.5" aria-hidden />
            Show {unchangedLines(row.lines)}
          </button>
        );
      })}
    </div>
  );
}

function Line({ line }: { line: DiffLine }) {
  // Only agent-fs's "\ No newline at end of file" note is an unchanged line
  // without numbers (`diffLines` numbers every line when agent-fs sends none).
  if (line.type === "context" && line.oldLine === undefined && line.newLine === undefined) {
    return <div className="pl-24 text-muted-foreground italic">{line.content.trim()}</div>;
  }
  return (
    <div
      className={cn(
        "flex",
        line.type === "add" && "bg-status-success/10",
        line.type === "remove" && "bg-status-error/10",
      )}
    >
      <span className="w-10 shrink-0 select-none pr-1 text-right tabular-nums text-muted-foreground/50">
        {line.oldLine ?? ""}
      </span>
      <span className="w-10 shrink-0 select-none pr-1 text-right tabular-nums text-muted-foreground/50">
        {line.newLine ?? ""}
      </span>
      <span
        aria-hidden
        className={cn(
          "w-4 shrink-0 select-none text-center",
          line.type === "add" && "text-status-success-strong",
          line.type === "remove" && "text-status-error-strong",
        )}
      >
        {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-4">
        {line.type === "context" ? null : (
          <span className="sr-only">{line.type === "add" ? "Added: " : "Removed: "}</span>
        )}
        {line.content}
      </span>
    </div>
  );
}
