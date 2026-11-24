import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUp, ChevronRight, ScrollText } from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { LogStreamProps } from "./catalog";
import {
  attributePairs,
  capRows,
  DEFAULT_MAX_ROWS,
  type LineFields,
  type LineView,
  lineView,
  newOnTop,
  rowKeys,
  SEVERITY_BAR_CLASS,
} from "./log-stream-model";

/** Collapsed line height in px (the virtualizer's estimate; expanded rows are measured). */
const LINE_PX = 22;
/** Scrolled less than this from the top still counts as "following". */
const AT_TOP_PX = 4;
/** Line views kept between renders; past this the cache starts over (it only holds lines that were on screen). */
const LINE_CACHE_MAX = 5_000;

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

type LineProps = {
  row: Row;
  rowKey: string;
  view: LineView;
  open: boolean;
  fields: LineFields;
  onToggle: (key: string) => void;
  onTrace?: (row: Row, key: string) => void;
};

/**
 * One entry. Memoized on its key: a refresh that refetches the same entries
 * (new objects, same ids) re-renders no visible line. A log entry does not
 * change under its id, so `row` and `view` are not compared.
 */
const LogLine = memo(
  function LogLine({ row, rowKey, view, open, fields, onToggle, onTrace }: LineProps) {
    const traceId = fields.traceField ? row[fields.traceField] : undefined;
    return (
      <>
        <button
          type="button"
          onClick={() => onToggle(rowKey)}
          aria-expanded={open}
          data-testid="log-stream-line"
          data-level={view.level}
          className={cn(
            "grid w-full grid-cols-[3px_6.5rem_minmax(0,9rem)_1fr] items-center gap-x-2 pr-2 text-left",
            "hover:bg-muted/60",
            open && "bg-muted/40",
          )}
          // Fixed box: the line's layout never reaches past itself.
          style={{ height: LINE_PX, contain: "strict" }}
        >
          <span className={cn("h-full", SEVERITY_BAR_CLASS[view.level])} title={view.level} />
          <span className="text-muted-foreground tabular-nums">{view.time}</span>
          <span className="truncate text-muted-foreground">{view.service}</span>
          <span className="flex min-w-0 items-center gap-1">
            <ChevronRight
              className={cn(
                "size-3 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
            <span className="truncate">{view.body}</span>
          </span>
        </button>
        {open ? (
          <div className="space-y-2 border-l-[3px] border-border bg-muted/20 py-2 pr-2 pl-[calc(6.5rem+1.25rem)]">
            <div className="whitespace-pre-wrap break-all">
              {typeof row[fields.bodyField] === "string"
                ? (row[fields.bodyField] as string)
                : JSON.stringify(row[fields.bodyField], null, 2)}
            </div>
            <AttributeGrid
              title="Attributes"
              pairs={fields.attributesField ? attributePairs(row[fields.attributesField]) : []}
            />
            <AttributeGrid
              title="Resource"
              pairs={fields.resourceField ? attributePairs(row[fields.resourceField]) : []}
            />
            {typeof traceId === "string" && traceId !== "" && onTrace ? (
              <button
                type="button"
                className="text-primary underline-offset-2 hover:underline"
                onClick={() => onTrace(row, rowKey)}
              >
                Open trace {traceId}
              </button>
            ) : null}
          </div>
        ) : null}
      </>
    );
  },
  (a, b) =>
    a.rowKey === b.rowKey &&
    a.open === b.open &&
    a.fields === b.fields &&
    a.onToggle === b.onToggle &&
    a.onTrace === b.onTrace,
);

/**
 * `LogStream`: one dense monospace line per entry (time, severity bar,
 * service, body), newest first. A click expands the entry's attributes and a
 * trace link. `follow` keeps the newest entry in view and, once the viewer
 * scrolls away, counts the entries a refresh added on top.
 *
 * Built for 50k-entry tails: only the lines on screen mount (virtualized),
 * each line's text is derived once per entry key and reused across scrolls
 * and refreshes, and a line re-renders only when it opens or closes. Past
 * `maxRows` the oldest entries are dropped with a notice.
 */
export function LogStreamView({
  props,
  onTrace,
}: {
  props: LogStreamProps;
  onTrace?: (row: Row, index: number) => void;
}) {
  const maxRows = props.maxRows ?? DEFAULT_MAX_ROWS;
  const { rows, dropped } = useMemo(() => {
    const valid = Array.isArray(props.data)
      ? props.data.filter((r): r is Row => !!r && typeof r === "object")
      : [];
    return capRows(valid, maxRows);
  }, [props.data, maxRows]);
  const fields = useMemo<LineFields>(
    () => ({
      timeField: props.timeField,
      bodyField: props.bodyField,
      severityField: props.severityField,
      serviceField: props.serviceField,
      attributesField: props.attributesField,
      resourceField: props.resourceField,
      traceField: props.traceField,
    }),
    [
      props.timeField,
      props.bodyField,
      props.severityField,
      props.serviceField,
      props.attributesField,
      props.resourceField,
      props.traceField,
    ],
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
  // Line text (time, level, service, one-line body) per entry key, built the
  // first time a line is on screen. Field changes start it over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `fields` is the trigger: other fields mean other text
  const lineCache = useMemo(() => new Map<string, LineView>(), [fields]);
  const viewOf = (key: string, row: Row): LineView => {
    let view = lineCache.get(key);
    if (!view) {
      if (lineCache.size >= LINE_CACHE_MAX) lineCache.clear();
      view = lineView(row, fields);
      lineCache.set(key, view);
    }
    return view;
  };
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [awayFromTop, setAwayFromTop] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const firstKeyRef = useRef<string | undefined>(undefined);

  // Stable per data change: the virtualizer memoizes its measurements on this
  // function, and a new one each render rebuilt all of them on every scroll frame.
  const getItemKey = useCallback((index: number) => keys[index] ?? index, [keys]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_PX,
    overscan: 8,
    getItemKey,
    // A collapsed line is LINE_PX by construction: reading its box would force a
    // style and layout pass for every line that scrolls in. Only an open line is
    // measured, from the ResizeObserver entry when there is one.
    measureElement: (element, entry) => {
      if (!element.hasAttribute("data-open")) return LINE_PX;
      const box = entry?.borderBoxSize?.[0];
      return box ? Math.round(box.blockSize) : Math.round(element.getBoundingClientRect().height);
    },
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

  const toggle = useCallback(
    (key: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );
  // Stable for the memoized lines: the latest keys and handler are read at click time.
  const latest = useRef({ keys, onTrace });
  latest.current = { keys, onTrace };
  const hasTrace = onTrace !== undefined;
  const traceLine = useCallback(
    (row: Row, key: string) => latest.current.onTrace?.(row, latest.current.keys.indexOf(key)),
    [],
  );

  const fill = props.fill === true;
  let body: ReactNode;
  if (rows.length === 0 && props.loading) {
    body = <Skeleton className="h-full min-h-40 w-full" />;
  } else if (rows.length === 0) {
    body = <EmptyState compact icon={ScrollText} title={props.emptyMessage ?? "No log entries"} />;
  } else {
    body = (
      <>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index] as Row;
            const key = keys[item.index] ?? String(item.index);
            const open = expanded.has(key);
            return (
              <div
                key={item.key}
                data-index={item.index}
                data-open={open ? "" : undefined}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${item.start}px)`, contain: "layout paint" }}
              >
                <LogLine
                  row={row}
                  rowKey={key}
                  view={viewOf(key, row)}
                  open={open}
                  fields={fields}
                  onToggle={toggle}
                  onTrace={hasTrace ? traceLine : undefined}
                />
              </div>
            );
          })}
        </div>
        {dropped > 0 ? (
          <div
            className="border-t border-border px-3 py-2 font-sans text-muted-foreground"
            data-testid="log-stream-dropped"
          >
            {dropped.toLocaleString()} oldest {dropped === 1 ? "entry" : "entries"} dropped: showing
            the newest {rows.length.toLocaleString()}.
          </div>
        ) : null}
      </>
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
