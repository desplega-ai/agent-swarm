/**
 * A tool call's details under its transcript line: the full command (or the
 * tool's input), the output, and how the call ended. The line's collapsible
 * mounts this only while open, so the input is formatted on a click, not on
 * every poll.
 */

import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MessageCopyButton } from "@/components/shared/message-copy-button";
import { prettyJson } from "@/lib/json-value";
import { cn, formatDuration } from "@/lib/utils";
import type { WorkEntry } from "./transcript-rows";

type ToolEntry = Extract<WorkEntry, { kind: "tool" }>;

/** A shell call's command, or undefined for every other tool. */
function commandOf(entry: ToolEntry): string | undefined {
  if (entry.toolKind !== "bash" || !entry.input || typeof entry.input !== "object") return;
  const command = (entry.input as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}

function prettyInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return prettyJson(input);
  if (typeof input === "object" && Object.keys(input).length === 0) return "";
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export function ToolDetails({ entry }: { entry: ToolEntry }) {
  const command = commandOf(entry);
  const input = useMemo(() => command ?? prettyInput(entry.input), [command, entry.input]);
  const output = useMemo(
    () => (entry.output === undefined ? undefined : prettyJson(entry.output)),
    [entry.output],
  );
  const ms = entry.durationMs;
  return (
    <div data-slot="transcript-tool-details" className="flex min-w-0 flex-col gap-2">
      {input ? (
        <DetailBlock label={command === undefined ? "Input" : "Command"} text={input} />
      ) : null}
      <DetailBlock
        label="Output"
        text={output}
        meta={
          <>
            {entry.status === "error" ? (
              <span className="text-status-error-strong">Failed</span>
            ) : null}
            {ms !== undefined ? (
              <span className="font-mono tabular-nums" title="From the call to its result">
                {ms < 1000 ? "<1s" : formatDuration(ms)}
              </span>
            ) : null}
          </>
        }
        empty={output === undefined ? "No output yet" : "No output"}
      />
    </div>
  );
}

/** One labelled block: a label, optional meta and Copy, then the text. */
function DetailBlock({
  label,
  text,
  meta,
  empty,
}: {
  label: string;
  text: string | undefined;
  meta?: ReactNode;
  /** Shown when there is no text. */
  empty?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-h-6 items-center gap-2 text-meta">
        <span className="font-mono tracking-wider uppercase">{label}</span>
        {meta}
        {text ? <MessageCopyButton text={text} label={`Copy ${label.toLowerCase()}`} /> : null}
      </div>
      {text ? <ClippedText text={text} /> : <p className="text-xs">{empty}</p>}
    </div>
  );
}

/** Machine text in a recessed block. Past about 8 lines it clips, with "Show more". */
function ClippedText({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Measured while clipped: `text` is the trigger, the measurement reads the DOM.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setOverflows(el.scrollHeight - 1 > el.clientHeight);
  }, [text]);
  const clipped = overflows && !expanded;
  return (
    <>
      <div className="min-w-0 rounded-md border border-border-subtle bg-surface">
        <pre
          ref={ref}
          className={cn(
            "m-0 px-2.5 py-1.5 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere text-foreground",
            !expanded && "max-h-44 overflow-hidden",
            clipped && "[mask-image:linear-gradient(to_bottom,black_60%,transparent)]",
          )}
        >
          {text}
        </pre>
      </div>
      {overflows ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="hit-area self-start text-xs text-muted-foreground hover:text-foreground"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  );
}
