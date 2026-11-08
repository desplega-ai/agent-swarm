/**
 * Catalog `DateRange` (a preset range filter written to `/ui/<id>/from|to`)
 * and `Timeline` (a vertical event list grouped by day).
 */

import { getByPath } from "@json-render/core";
import { useStateStore } from "@json-render/react";
import { CalendarRange, History } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { BadgeTone, DateRangeProps, TimelineProps } from "./catalog";
import {
  DATE_RANGE_LABELS,
  DATE_RANGE_PRESETS,
  type DateRangePreset,
  groupTimeline,
  presetRange,
  validCustomRange,
} from "./data-views-model";
import { CatalogIcon } from "./icons";
import { useJsonRenderThemeAttr } from "./theme-scope";

// ─── DateRange ──────────────────────────────────────────────────────────────

export function DateRangeComponent({ props }: { props: DateRangeProps }) {
  const { state, get, set } = useStateStore();
  const themeAttr = useJsonRenderThemeAttr();
  const base = `/ui/${props.id}`;
  const presets = (props.presets ?? DATE_RANGE_PRESETS) as readonly DateRangePreset[];
  const initial = props.defaultPreset ?? presets[0] ?? "30d";
  const storedPreset = getByPath(state, `${base}/preset`);
  const active = (typeof storedPreset === "string" ? storedPreset : initial) as DateRangePreset;
  const from = getByPath(state, `${base}/from`);
  const to = getByPath(state, `${base}/to`);

  const apply = (preset: DateRangePreset, range?: { from: string; to: string }) => {
    const next = range ?? (preset === "custom" ? null : presetRange(preset));
    if (!next) return;
    set(`${base}/from`, next.from);
    set(`${base}/to`, next.to);
    set(`${base}/preset`, preset);
  };

  // First load: write the default range unless the state already holds one
  // (a remount, or a page that seeded it).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per id
  useEffect(() => {
    if (get(`${base}/from`) !== undefined && get(`${base}/to`) !== undefined) return;
    const preset = initial === "custom" ? "30d" : initial;
    apply(preset, presetRange(preset));
  }, [base]);

  const [draft, setDraft] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [open, setOpen] = useState(false);
  const draftValid = validCustomRange(draft.from, draft.to);

  return (
    <div className="flex flex-col gap-1.5" data-testid="json-render-date-range">
      {props.label ? (
        <span className="text-sm font-medium text-foreground">{props.label}</span>
      ) : null}
      <fieldset
        aria-label={props.label ?? "Date range"}
        className="m-0 flex flex-wrap gap-1 border-0 p-0"
      >
        {presets.map((preset) =>
          preset === "custom" ? (
            <Popover
              key={preset}
              open={open}
              onOpenChange={(next) => {
                // shortcut: no day-picker dependency; add react-day-picker when someone needs a calendar range.
                if (next) {
                  setDraft({
                    from: typeof from === "string" ? from : "",
                    to: typeof to === "string" ? to : "",
                  });
                }
                setOpen(next);
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  size="sm"
                  variant={active === "custom" ? "secondary" : "ghost"}
                  aria-pressed={active === "custom"}
                  data-preset={preset}
                >
                  <CalendarRange />
                  {active === "custom" && typeof from === "string" && typeof to === "string"
                    ? `${from} – ${to}`
                    : DATE_RANGE_LABELS.custom}
                </Button>
              </PopoverTrigger>
              <PopoverContent {...themeAttr} align="start" className="flex w-64 flex-col gap-3">
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  From
                  <Input
                    type="date"
                    value={draft.from}
                    max={draft.to || undefined}
                    onChange={(event) => setDraft({ ...draft, from: event.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  To
                  <Input
                    type="date"
                    value={draft.to}
                    min={draft.from || undefined}
                    onChange={(event) => setDraft({ ...draft, to: event.target.value })}
                  />
                </label>
                <Button
                  size="sm"
                  disabled={!draftValid}
                  onClick={() => {
                    apply("custom", draft);
                    setOpen(false);
                  }}
                >
                  Apply
                </Button>
              </PopoverContent>
            </Popover>
          ) : (
            <Button
              key={preset}
              size="sm"
              variant={active === preset ? "secondary" : "ghost"}
              aria-pressed={active === preset}
              data-preset={preset}
              onClick={() => apply(preset)}
            >
              {DATE_RANGE_LABELS[preset]}
            </Button>
          ),
        )}
      </fieldset>
    </div>
  );
}

// ─── Timeline ───────────────────────────────────────────────────────────────

const toneDot: Record<BadgeTone, string> = {
  neutral: "bg-status-neutral",
  success: "bg-status-success",
  active: "bg-status-active",
  error: "bg-status-error",
  info: "bg-status-info",
  pending: "bg-status-pending",
  warning: "bg-status-warning",
  paused: "bg-status-paused",
};

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * `renderStatus` draws the status pill (the dashboard's chip lives with the
 * other cell renderers); `onSelect` runs the chain with `$row` / `$rowIndex`.
 */
export function TimelineView({
  props,
  onSelect,
  renderStatus,
}: {
  props: TimelineProps;
  onSelect: (row: Record<string, unknown>, index: number) => void;
  renderStatus: (value: string, tones: TimelineProps["tones"]) => ReactNode;
}) {
  const rows = Array.isArray(props.data) ? props.data : [];
  const days = useMemo(() => groupTimeline(rows, props.timeField), [rows, props.timeField]);
  const clickable = Array.isArray(props.onSelect) && props.onSelect.length > 0;

  if (props.loading && days.length === 0) {
    return (
      <div className="flex flex-col gap-3" data-testid="json-render-timeline">
        {[0, 1, 2].map((key) => (
          <Skeleton key={key} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (days.length === 0) {
    return (
      <div data-testid="json-render-timeline">
        <EmptyState compact icon={History} title={props.emptyMessage ?? "No events yet"} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="json-render-timeline">
      {days.map((day) => (
        <section key={day.key} aria-label={day.label} data-testid="json-render-timeline-day">
          <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">{day.label}</h4>
          <ol className="relative flex flex-col border-l border-border pl-0">
            {day.entries.map(({ row, index, ms }) => {
              const status = props.statusField ? text(row[props.statusField]) : "";
              const tone = (props.tones?.[status] ?? "neutral") as BadgeTone;
              const body = (
                <>
                  <span
                    aria-hidden
                    className="absolute top-3 -left-[5px] flex items-center justify-center"
                  >
                    {props.icon ? (
                      <span className="-ml-1 flex size-4 items-center justify-center rounded-full bg-background">
                        <CatalogIcon name={props.icon} size="sm" className="size-3" />
                      </span>
                    ) : (
                      <span
                        className={cn("size-2 rounded-full ring-2 ring-background", toneDot[tone])}
                      />
                    )}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {text(row[props.titleField])}
                      </span>
                      {status ? renderStatus(status, props.tones) : null}
                      <time
                        dateTime={new Date(ms).toISOString()}
                        className="shrink-0 text-xs text-muted-foreground tabular-nums"
                      >
                        {new Date(ms).toLocaleTimeString(undefined, {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </span>
                    {props.descriptionField && text(row[props.descriptionField]) ? (
                      <span className="line-clamp-2 text-xs text-muted-foreground">
                        {text(row[props.descriptionField])}
                      </span>
                    ) : null}
                  </span>
                </>
              );
              return (
                <li
                  key={`${day.key}-${index}`}
                  className="relative"
                  data-testid="json-render-timeline-event"
                >
                  {clickable ? (
                    <button
                      type="button"
                      onClick={() => onSelect(row, index)}
                      className="flex w-full min-w-0 gap-2 rounded-md py-2 pr-2 pl-4 text-left hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="flex min-w-0 gap-2 py-2 pr-2 pl-4">{body}</div>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
