// Ported from agent-fs `live/src/components/viewers/DiffViewer.tsx` (agent-fs
// 0.15.0), plus a `label`. Comb changes: line numbers come from `diffLines`
// (agent-fs's own numbers when it sends them, else live/'s count), status
// tokens replace the green and red palette literals, a row marks the lines
// left out between hunks, a diff past `DIFF_MAX_ROWS` rows ends in a "too
// large" row, long lines wrap at spaces (`break-words`, not `break-all`),
// screen readers skip the line numbers, and each changed line tells them
// whether it was added or removed.

import { Ellipsis, FileWarning } from "lucide-react";
import { useMemo } from "react";
import type { DiffChange } from "@/lib/agent-fs/types";
import { type DiffLine, diffLines, diffRows } from "@/lib/comb/diff-lines";
import { cn } from "@/lib/utils";

interface DiffViewerProps {
  changes: DiffChange[];
  /** The accessible name of the diff ("Changes from v1 to v3"). */
  label: string;
  className?: string;
}

function lineCount(count: number) {
  return `${count.toLocaleString()} ${count === 1 ? "line" : "lines"}`;
}

export function DiffViewer({ changes, label, className }: DiffViewerProps) {
  const rows = useMemo(() => diffRows(diffLines(changes)), [changes]);

  return (
    <section aria-label={label} className={cn("overflow-auto font-mono text-xs", className)}>
      {rows.map((row) => {
        if (row.kind === "line") return <Line key={`l${row.index}`} line={row.line} />;
        if (row.kind === "gap") {
          return (
            <div
              key={`g${row.before}`}
              className="flex items-center gap-2 border-y border-dashed border-border-subtle py-1 pl-24 text-muted-foreground"
            >
              <Ellipsis className="size-3.5" aria-hidden />
              {lineCount(row.lines)} unchanged
            </div>
          );
        }
        return (
          <div
            key="cap"
            className="flex items-start gap-2 border-t border-border-subtle px-4 py-3 font-sans text-sm text-muted-foreground"
          >
            <FileWarning className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Diff too large: the last {lineCount(row.lines)} {row.lines === 1 ? "is" : "are"} not
              shown. Download both versions, or open the file in agent-fs.
            </span>
          </div>
        );
      })}
    </section>
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
      <span
        aria-hidden
        className="w-10 shrink-0 select-none pr-1 text-right tabular-nums text-muted-foreground/50"
      >
        {line.oldLine ?? ""}
      </span>
      <span
        aria-hidden
        className="w-10 shrink-0 select-none pr-1 text-right tabular-nums text-muted-foreground/50"
      >
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
