import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUp, ChevronRight, ScrollText } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { LogStreamProps } from "./catalog";
import {
  attributePairs,
  lineBody,
  lineTime,
  newOnTop,
  rowKeys,
  SEVERITY_BAR_CLASS,
  severityLevel,
} from "./log-stream-model";

/** Collapsed line height in px (the virtualizer's estimate; expanded rows are measured). */
const LINE_PX = 22;
/** Scrolled less than this from the top still counts as "following". */
const AT_TOP_PX = 4;

type Row = Record<string, unknown>;

function AttributeGrid({ title, pairs }: { title: string; pairs: [string, string][] }) {
  if (pairs.length === 0) return null;
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{title}</div>
      <dl className="grid grid-cols-[minmax(8rem,max-content)_1fr] gap-x-3 gap-y-0.5">
        {pairs.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="truncate text-muted-foreground">{key}</dt>
            <dd className="min-w-0 break-all">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * `LogStream`: one dense monospace line per entry (time, severity bar,
 * service, body), newest first. A click expands the entry's attributes and a
 * trace link. `follow` keeps the newest entry in view and, once the viewer
 * scrolls away, counts the entries a refresh added on top.
 */
export function LogStreamView({
  props,
  onTrace,
}: {
  props: LogStreamProps;
  onTrace?: (row: Row, index: number) => void;
}) {
  const rows = useMemo<Row[]>(
    () =>
      Array.isArray(props.data)
        ? props.data.filter((r): r is Row => !!r && typeof r === "object")
        : [],
    [props.data],
  );
  const keys = useMemo(
    () =>
      rowKeys(rows, {
        keyField: props.keyField,
        timeField: props.timeField,
        bodyField: props.bodyField,
      }),
    [rows, props.keyField, props.timeField, props.bodyField],
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [awayFromTop, setAwayFromTop] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const firstKeyRef = useRef<string | undefined>(undefined);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_PX,
    overscan: 20,
    getItemKey: (index) => keys[index] ?? index,
    // First paint before the scroller is measured (and a layout-less test DOM).
    initialRect: { width: 960, height: 480 },
  });

  // A refresh that added rows on top while the viewer reads further down.
  useEffect(() => {
    const added = newOnTop(keys, firstKeyRef.current);
    firstKeyRef.current = keys[0];
    if (added > 0 && awayFromTop) setUnseen((n) => n + added);
  }, [keys, awayFromTop]);

  const follow = props.follow === true;
  const jumpToTop = () => {
    scrollRef.current?.scrollTo({ top: 0 });
    setUnseen(0);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: `keys` is the trigger: new data re-pins the newest entry
  useEffect(() => {
    if (follow && !awayFromTop) scrollRef.current?.scrollTo({ top: 0 });
  }, [follow, awayFromTop, keys]);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const fill = props.fill === true;
  let body: ReactNode;
  if (rows.length === 0 && props.loading) {
    body = <Skeleton className="h-full min-h-40 w-full" />;
  } else if (rows.length === 0) {
    body = <EmptyState compact icon={ScrollText} title={props.emptyMessage ?? "No log entries"} />;
  } else {
    body = (
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index] as Row;
          const key = keys[item.index] ?? String(item.index);
          const open = expanded.has(key);
          const level = severityLevel(props.severityField ? row[props.severityField] : undefined);
          const service = props.serviceField ? row[props.serviceField] : undefined;
          const traceId = props.traceField ? row[props.traceField] : undefined;
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <button
                type="button"
                onClick={() => toggle(key)}
                aria-expanded={open}
                data-testid="log-stream-line"
                data-level={level}
                className={cn(
                  "grid w-full grid-cols-[3px_6.5rem_minmax(0,9rem)_1fr] items-center gap-x-2 pr-2 text-left",
                  "hover:bg-muted/60",
                  open && "bg-muted/40",
                )}
                style={{ height: LINE_PX }}
              >
                <span className={cn("h-full", SEVERITY_BAR_CLASS[level])} title={level} />
                <span className="text-muted-foreground tabular-nums">
                  {lineTime(row[props.timeField])}
                </span>
                <span className="truncate text-muted-foreground">
                  {service == null ? "" : String(service)}
                </span>
                <span className="flex min-w-0 items-center gap-1">
                  <ChevronRight
                    className={cn(
                      "size-3 shrink-0 text-muted-foreground transition-transform",
                      open && "rotate-90",
                    )}
                  />
                  <span className="truncate">{lineBody(row[props.bodyField])}</span>
                </span>
              </button>
              {open ? (
                <div className="space-y-2 border-l-[3px] border-border bg-muted/20 py-2 pr-2 pl-[calc(6.5rem+1.25rem)]">
                  <div className="whitespace-pre-wrap break-all">
                    {typeof row[props.bodyField] === "string"
                      ? (row[props.bodyField] as string)
                      : JSON.stringify(row[props.bodyField], null, 2)}
                  </div>
                  <AttributeGrid
                    title="Attributes"
                    pairs={props.attributesField ? attributePairs(row[props.attributesField]) : []}
                  />
                  <AttributeGrid
                    title="Resource"
                    pairs={props.resourceField ? attributePairs(row[props.resourceField]) : []}
                  />
                  {typeof traceId === "string" && traceId !== "" && onTrace ? (
                    <button
                      type="button"
                      className="text-primary underline-offset-2 hover:underline"
                      onClick={() => onTrace(row, item.index)}
                    >
                      Open trace {traceId}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative min-w-0 rounded-lg border border-border bg-background font-mono text-xs",
        fill ? "h-full min-h-0" : "h-[480px]",
      )}
      style={props.height && !fill ? { height: props.height } : undefined}
      data-testid="json-render-log-stream"
    >
      <div
        ref={scrollRef}
        className="h-full overflow-auto"
        onScroll={(event) => {
          const away = event.currentTarget.scrollTop > AT_TOP_PX;
          setAwayFromTop(away);
          if (!away) setUnseen(0);
        }}
      >
        {body}
      </div>
      {unseen > 0 ? (
        <button
          type="button"
          onClick={jumpToTop}
          className="absolute top-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-background px-3 py-1 font-sans text-xs shadow-sm"
        >
          <ArrowUp className="size-3" />
          {unseen} new
        </button>
      ) : null}
    </div>
  );
}
