/**
 * React implementations for every component in `swarmCatalog`.
 *
 * The first seven (Container, Card, Heading, Text, Button, Metric, Alert) are
 * a verbatim move out of `pages/pages/[id]/json-page-renderer.tsx` — the
 * pages renderer's behaviour is unchanged. Table / Form / Badge are the
 * swarm-apps additions and are built from existing dashboard primitives
 * (`DataGrid`, `Badge`, `Input`, `Textarea`, `Select`, `Switch`, `SettingsRow`).
 * Stack / Grid / Split / Divider / Tabs / SearchInput / Select / Markdown are
 * the layout + interactivity tier (spike 2.5). Drawer / DetailList are the
 * router tier (spike 4): both read the runtime's `/route` state root, so they
 * are inert outside `/apps/:id` (the DB-backed pages renderer never writes it).
 *
 * ── Positional children ────────────────────────────────────────────────────
 * `Split` and `Tabs` address their children by index. Verified against
 * `@json-render/react`'s `ElementRenderer`: `children` arrives as a plain JS
 * array with exactly one entry per declared child key (`element.children.map`),
 * so indices line up with the JSON. Two consequences drive `positionalChildren`
 * below:
 *   - `React.Children.toArray` DROPS nulls, and a child key that points at a
 *     missing element renders as `null` — that would silently shift every later
 *     pane by one. So the raw array is used as-is when it is one, and
 *     `Children.toArray` is only the fallback (single child / repeat block).
 *   - Not rendering a child simply never mounts it, which is why `Tabs` renders
 *     every child and hides the inactive ones instead of slicing the array.
 */

import { KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";
import { getByPath, type InferComponentProps } from "@json-render/core";
import type { Components } from "@json-render/react";
import { useActions, useStateStore } from "@json-render/react";
import type {
  CellKeyDownEvent,
  ColDef,
  FullWidthCellKeyDownEvent,
  ICellRendererParams,
  ValueGetterParams,
} from "ag-grid-community";
import { eachDayOfInterval, format, parseISO, startOfDay, subDays } from "date-fns";
import { Provider as JotaiProvider } from "jotai";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle,
  ExternalLink,
  Image as ImageIcon,
  Inbox,
  Info,
  Minus,
  MoreHorizontal,
  SearchX,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { Children, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Streamdown } from "streamdown";
import { AvatarStack } from "@/components/kibo-ui/avatar-stack";
import {
  CalendarBody,
  CalendarDatePagination,
  type Feature as CalendarFeature,
  CalendarHeader,
  CalendarItem,
  CalendarProvider,
  useCalendarMonth,
  useCalendarYear,
} from "@/components/kibo-ui/calendar";
import {
  type Activity,
  ContributionGraph,
  ContributionGraphBlock,
  ContributionGraphCalendar,
  ContributionGraphFooter,
  ContributionGraphLegend,
  ContributionGraphTotalCount,
} from "@/components/kibo-ui/contribution-graph";
import {
  KanbanBoard,
  KanbanCard,
  KanbanCards,
  KanbanHeader,
  KanbanProvider,
} from "@/components/kibo-ui/kanban";
import { Spinner } from "@/components/kibo-ui/spinner";
import { BetaTag } from "@/components/shared/beta-tag";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { CopyValueButton } from "@/components/shared/copy-value-button";
import { EmptyState } from "@/components/shared/empty-state";
import { JsonViewer } from "@/components/shared/json-viewer";
import { ListView, type ListViewMobileRow } from "@/components/shared/list-view";
import { SearchBox } from "@/components/shared/search-box";
import { StatusBadge } from "@/components/shared/status-badge";
import { ChipButton } from "@/components/shared/suggestion-chips";
import {
  ProgressRing,
  TASK_STATUS_TEXT,
  TaskStatusIcon,
  taskStatusVariant,
} from "@/components/shared/task-status-icon";
import { userInitials } from "@/components/shared/user-chip";
import { AlertCallout } from "@/components/ui/alert-callout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button, type ButtonStatus } from "@/components/ui/button";
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Card as UiCard,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DefinitionList, InfoRow } from "@/components/ui/info-row";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { MiddleTruncation } from "@/components/ui/middle-truncation";
import { Progress } from "@/components/ui/progress";
import { SearchableMultiSelect, SearchableSelect } from "@/components/ui/searchable-select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { SettingsRow } from "@/components/ui/settings-row";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { StatPanel } from "@/components/ui/stat-panel";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { cn, formatSmartTime } from "@/lib/utils";
import { resolveScopedParams } from "./action-params";
import { applyTemplate } from "./apply-template";
import {
  CARD_GRID_PAGE_SIZE,
  cardGridCapText,
  cardGridFieldKind,
  cardGridRowKey,
  cardGridTitleText,
  cardGridVisibleRows,
  safeHttpUrl,
} from "./card-grid-model";
import type {
  ActionChain,
  BadgeTone,
  CardGridField,
  ChipOption,
  DetailListField,
  DrawerAction,
  FormField,
  GridColumns,
  KanbanColumn,
  MetricTrend,
  SelectOption,
  SpacingToken,
  swarmCatalog,
  TableColumn,
  TableFilters,
  TableRowAction,
  TableRowActionConfirm,
  TabsTab,
} from "./catalog";
import { formatValue, progressPercent } from "./format-value";
import { CatalogIcon, catalogIcon } from "./icons";
import { parseNumberInputValue } from "./number-input-value";
import { useJsonRenderThemeAttr } from "./theme-scope";
import { TreeComponent } from "./tree";
import { usePageShortcut } from "./use-page-shortcut";

// ─── Style maps (moved verbatim from json-page-renderer.tsx) ────────────────

const gapClass: Record<"none" | "sm" | "md" | "lg", string> = {
  none: "gap-0",
  sm: "gap-2",
  md: "gap-4",
  lg: "gap-6",
};

/**
 * Aligned with the product chrome, not louder than it: h1 matches
 * `PageHeader`'s title (text-xl/600) so an app page never shouts over the
 * dashboard, and h2/h3 step down from there.
 */
const headingClass: Record<"h1" | "h2" | "h3", string> = {
  h1: "text-xl font-semibold tracking-tight",
  h2: "text-lg font-semibold tracking-tight",
  h3: "text-base font-semibold",
};

const alertTone: Record<
  "info" | "success" | "warning" | "error",
  { tone: "info" | "success" | "warning" | "error"; icon: typeof Info }
> = {
  info: { tone: "info", icon: Info },
  success: { tone: "success", icon: CheckCircle },
  warning: { tone: "warning", icon: AlertTriangle },
  error: { tone: "error", icon: AlertCircle },
};

/**
 * Badge tone → the `StatusBadge` convention (neutral outline chip + status
 * dot + `-strong` text), so app pills are pixel-identical to the native
 * status chips instead of a third colored-border/tinted-fill vocabulary.
 */
const badgeToneDot: Record<BadgeTone, string> = {
  neutral: "bg-status-neutral",
  success: "bg-status-success",
  active: "bg-status-active",
  error: "bg-status-error",
  info: "bg-status-info",
  pending: "bg-status-pending",
  warning: "bg-status-warning",
  paused: "bg-status-paused",
};

const badgeToneText: Record<BadgeTone, string> = {
  neutral: "text-status-neutral-strong",
  success: "text-status-success-strong",
  active: "text-status-active-strong",
  error: "text-status-error-strong",
  info: "text-status-info-strong",
  pending: "text-status-pending-strong",
  warning: "text-status-warning-strong",
  paused: "text-status-paused-strong",
};

function StatusPill({ text, tone, icon }: { text: string; tone: BadgeTone; icon?: unknown }) {
  return (
    <Badge variant="outline" size="tag" className="gap-1.5">
      {catalogIcon(icon) ? (
        <CatalogIcon name={icon} size="sm" className={cn("size-3", badgeToneText[tone])} />
      ) : (
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", badgeToneDot[tone])} />
      )}
      <span className={badgeToneText[tone]}>{text}</span>
    </Badge>
  );
}

type StatusBadgeStatus = Parameters<typeof StatusBadge>[0]["status"];

/**
 * `kind: "status"` — lifecycle values (pending, in_progress, completed,
 * failed, ...) render the dashboard's own `StatusBadge` with its lifecycle
 * icon; any other value falls back to the toned pill.
 */
function StatusCell({ value, tones }: { value: string; tones?: Record<string, BadgeTone> }) {
  if (taskStatusVariant(value)) return <StatusBadge status={value as StatusBadgeStatus} />;
  return <StatusPill text={value} tone={badgeToneFor(tones, value)} />;
}

/** Compact rounded numeric pill (Badge `variant: "count"`, Tabs `count`). */
function CountPill({ value, tone = "neutral" }: { value: string | number; tone?: BadgeTone }) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "h-4.5 min-w-4.5 rounded-full px-1.5 text-[10px] leading-none tabular-nums",
        tone === "neutral" ? "text-muted-foreground" : badgeToneText[tone],
      )}
    >
      {value}
    </Badge>
  );
}

/**
 * Badge `variant: "status"` — the 11px sentence-case pill: the lifecycle icon
 * for a lifecycle `status`, else the author icon or the tone dot.
 */
function SentencePill({
  text,
  tone,
  status,
  icon,
}: {
  text: string;
  tone: BadgeTone;
  status?: string;
  icon?: unknown;
}) {
  const lifecycle = status ? taskStatusVariant(status) : null;
  return (
    <Badge variant="outline" className="h-5 gap-1.5 rounded-full px-2 text-[11px] leading-none">
      {lifecycle ? (
        // Wrapped so the badge's `[&>svg]:size-3` rule does not shrink the icon.
        <span className="inline-flex size-3.5 shrink-0">
          <TaskStatusIcon variant={lifecycle} className="size-full" />
        </span>
      ) : catalogIcon(icon) ? (
        <CatalogIcon name={icon} size="sm" className={cn("size-3", badgeToneText[tone])} />
      ) : (
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", badgeToneDot[tone])} />
      )}
      <span className={lifecycle ? TASK_STATUS_TEXT[lifecycle] : badgeToneText[tone]}>{text}</span>
    </Badge>
  );
}

/** Wraps a node in a hover tooltip when `hint` is set. */
function WithHint({ hint, children }: { hint?: string; children: ReactNode }) {
  if (!hint) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Value plus copy button (Table `kind: "copy"`, DetailList `kind: "copy"`).
 * Stops propagation so a copy never also clicks the row, card or drag handle.
 */
function CopyCell({ value, middle }: { value: string; middle?: boolean }) {
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return (
    <span
      className="flex w-full min-w-0 items-center gap-1"
      onClick={stop}
      onMouseDown={stop}
      onTouchStart={stop}
      onKeyDown={stop}
    >
      {middle ? (
        <MiddleTruncation className="min-w-0 flex-1 font-mono text-xs">{value}</MiddleTruncation>
      ) : (
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={value}>
          {value}
        </span>
      )}
      <CopyValueButton value={value} label={`Copy ${value}`} size="icon-xs" />
    </span>
  );
}

/** `kind: "user"` / `"agent"` — an initials (or bot) avatar and the name. */
function PersonCell({ name, agent }: { name: string; agent?: boolean }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
      <span
        aria-hidden
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground"
      >
        {agent ? <Bot className="size-3" /> : userInitials(name)}
      </span>
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}

/** `kind: "relative"` / `"date"` — smart relative time, exact time on hover. */
function RelativeTimeCell({ value }: { value: unknown }) {
  const text = String(value);
  const time = Date.parse(text);
  if (Number.isNaN(time)) return <span className="block min-w-0 truncate">{text}</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block min-w-0 truncate">{formatSmartTime(text)}</span>
      </TooltipTrigger>
      <TooltipContent>{new Date(time).toLocaleString()}</TooltipContent>
    </Tooltip>
  );
}

function ProgressCell({ value, max }: { value: unknown; max?: number }) {
  const percent = progressPercent(value, max);
  if (percent === null) return null;
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      <Progress value={percent} className="h-1.5 flex-1" aria-label={`${percent}%`} />
      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {percent}%
      </span>
    </span>
  );
}

// ─── Shared cell helpers (Table cells + DetailList fields) ──────────────────

/** `kind: "badge"` tone lookup — an unmapped value is neutral, never missing. */
function badgeToneFor(tones: Record<string, BadgeTone> | undefined, value: string): BadgeTone {
  return tones?.[value] ?? "neutral";
}

// ─── Layout primitives (Stack / Grid / Split / Divider) ─────────────────────

/**
 * The shared spacing scale. Written out as whole class names (never
 * interpolated) so Tailwind's scanner emits them.
 */
const stackGapClass: Record<SpacingToken, string> = {
  none: "gap-0",
  xs: "gap-1",
  sm: "gap-2",
  md: "gap-4",
  lg: "gap-6",
  xl: "gap-8",
};

const paddingClass: Record<SpacingToken, string> = {
  none: "p-0",
  xs: "p-1",
  sm: "p-2",
  md: "p-4",
  lg: "p-6",
  xl: "p-8",
};

const alignClass = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
} as const;

const justifyClass = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  between: "justify-between",
} as const;

/** `grid-cols-N` per breakpoint. Full class names for the same scanner reason. */
const gridColsClass: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  5: "grid-cols-5",
  6: "grid-cols-6",
};

const gridColsSmClass: Record<number, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-4",
  5: "sm:grid-cols-5",
  6: "sm:grid-cols-6",
};

const gridColsMdClass: Record<number, string> = {
  1: "md:grid-cols-1",
  2: "md:grid-cols-2",
  3: "md:grid-cols-3",
  4: "md:grid-cols-4",
  5: "md:grid-cols-5",
  6: "md:grid-cols-6",
};

const gridColsLgClass: Record<number, string> = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  5: "lg:grid-cols-5",
  6: "lg:grid-cols-6",
};

/**
 * `Split` ratios expressed as grid tracks + per-pane spans, keyed by the
 * breakpoint the panes un-stack at. Below that breakpoint the layout is a
 * single column.
 */
const SPLIT_RATIO_SPANS: Record<string, [number, number]> = {
  "1-1": [1, 1],
  "1-2": [1, 2],
  "2-1": [2, 1],
  "1-3": [1, 3],
  "3-1": [3, 1],
};

const splitTrackClass: Record<"sm" | "md" | "lg", Record<number, string>> = {
  sm: { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4" },
  md: { 2: "md:grid-cols-2", 3: "md:grid-cols-3", 4: "md:grid-cols-4" },
  lg: { 2: "lg:grid-cols-2", 3: "lg:grid-cols-3", 4: "lg:grid-cols-4" },
};

const splitSpanClass: Record<"sm" | "md" | "lg", Record<number, string>> = {
  sm: { 1: "sm:col-span-1", 2: "sm:col-span-2", 3: "sm:col-span-3" },
  md: { 1: "md:col-span-1", 2: "md:col-span-2", 3: "md:col-span-3" },
  lg: { 1: "lg:col-span-1", 2: "lg:col-span-2", 3: "lg:col-span-3" },
};

const splitOrderResetClass: Record<"sm" | "md" | "lg", string> = {
  sm: "sm:order-none",
  md: "md:order-none",
  lg: "lg:order-none",
};

/**
 * Children of a positional container (`Split`, `Tabs`) as an index-addressable
 * array.
 *
 * `@json-render/react` hands a component `element.children.map(...)` — already
 * a plain array with one entry per declared child key, including `null` for a
 * dangling key. `React.Children.toArray` would DROP those nulls and shift every
 * later pane by one, so the raw array is preferred and `toArray` is only the
 * fallback for the non-array shapes (single child, `repeat` block, undefined).
 */
function positionalChildren(children: ReactNode): ReactNode[] {
  if (Array.isArray(children)) return children as ReactNode[];
  if (children === null || children === undefined) return [];
  return Children.toArray(children);
}

type ButtonComponentProps = InferComponentProps<typeof swarmCatalog, "Button">;
type MetricComponentProps = InferComponentProps<typeof swarmCatalog, "Metric">;
type StackProps = InferComponentProps<typeof swarmCatalog, "Stack">;
type GridProps = InferComponentProps<typeof swarmCatalog, "Grid">;
type SplitProps = InferComponentProps<typeof swarmCatalog, "Split">;
type TabsComponentProps = InferComponentProps<typeof swarmCatalog, "Tabs">;
type SearchInputProps = InferComponentProps<typeof swarmCatalog, "SearchInput">;
type SelectFilterProps = InferComponentProps<typeof swarmCatalog, "Select">;
type NumberInputProps = InferComponentProps<typeof swarmCatalog, "NumberInput">;

/** `collapseBelow` → the breakpoint the row un-stacks at (full class names). */
const stackRowFromClass: Record<"sm" | "md" | "lg", string> = {
  sm: "sm:flex-row",
  md: "md:flex-row",
  lg: "lg:flex-row",
};

/**
 * `Stack.motion` → the entrance class (`styles/json-render.css`). CSS keyframes
 * run when an element is first inserted and never on a React re-render, so the
 * 5s poll cannot replay them.
 */
const stackMotionClass: Record<"rise" | "fade" | "none", string | undefined> = {
  rise: "json-render-motion-rise",
  fade: "json-render-motion-fade",
  none: undefined,
};

function StackComponent({ props, children }: { props: StackProps; children: ReactNode }) {
  const direction = props.direction ?? "column";
  // A collapsible row is a column below its breakpoint (Split semantics).
  const collapse = direction === "row" ? props.collapseBelow : undefined;
  return (
    <div
      className={cn(
        "flex min-w-0",
        direction === "row"
          ? collapse
            ? cn("flex-col", stackRowFromClass[collapse])
            : "flex-row"
          : "flex-col",
        stackGapClass[props.gap ?? "md"],
        props.align ? alignClass[props.align] : undefined,
        props.justify ? justifyClass[props.justify] : undefined,
        props.wrap ? "flex-wrap" : undefined,
        props.padding ? paddingClass[props.padding] : undefined,
        stackMotionClass[props.motion ?? "rise"],
        // Grow to fill a `fill`-aware parent's remaining space instead of
        // sizing to content — `min-h-0` lets it shrink so a scrolling leaf
        // further down the tree gets a real height to scroll within instead
        // of pushing the page. `overflow-y-auto` is the backstop for
        // non-`fill` children whose combined natural height still exceeds
        // that: THIS Stack scrolls on its own instead of leaking into a shared
        // ancestor scroll container that would drag unrelated columns along.
        props.fill ? "min-h-0 flex-1 overflow-y-auto" : undefined,
      )}
    >
      {children}
    </div>
  );
}

function clampColumns(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(6, Math.max(1, Math.round(value)));
}

/**
 * `grid-cols-N` classes per breakpoint for `Grid.columns` / `CardGrid.columns`.
 * A bare count is responsive shorthand — 1 column on phones, 2 from `sm`, the
 * declared count from `md` — and the object form falls back to the "cards
 * reflow" default so a sparse `{ lg: 4 }` still stacks on a phone.
 */
function gridColumnClasses(columns: GridColumns): string[] {
  const single = clampColumns(columns);
  const perBreakpoint =
    single !== undefined
      ? { base: 1, sm: Math.min(2, single), md: single, lg: undefined }
      : {
          base: clampColumns((columns as { base?: number } | undefined)?.base) ?? 1,
          sm: clampColumns((columns as { sm?: number } | undefined)?.sm),
          md:
            clampColumns((columns as { md?: number } | undefined)?.md) ?? (columns ? undefined : 2),
          lg:
            clampColumns((columns as { lg?: number } | undefined)?.lg) ?? (columns ? undefined : 3),
        };
  return [
    gridColsClass[perBreakpoint.base],
    perBreakpoint.sm ? gridColsSmClass[perBreakpoint.sm] : undefined,
    perBreakpoint.md ? gridColsMdClass[perBreakpoint.md] : undefined,
    perBreakpoint.lg ? gridColsLgClass[perBreakpoint.lg] : undefined,
  ].filter((value): value is string => Boolean(value));
}

function GridComponent({ props, children }: { props: GridProps; children: ReactNode }) {
  return (
    <div
      className={cn(
        "grid min-w-0",
        ...gridColumnClasses(props.columns as GridColumns),
        stackGapClass[props.gap ?? "md"],
        props.padding ? paddingClass[props.padding] : undefined,
      )}
    >
      {children}
    </div>
  );
}

function SplitComponent({ props, children }: { props: SplitProps; children: ReactNode }) {
  const panes = positionalChildren(children);
  const breakpoint = props.collapseBelow ?? "md";
  const [firstSpan, secondSpan] = SPLIT_RATIO_SPANS[props.ratio ?? "2-1"] ?? [2, 1];
  const tracks = firstSpan + secondSpan;
  const gap = stackGapClass[props.gap ?? "md"];
  const reverse = props.reverse === true;

  return (
    <div
      className={cn(
        "grid min-w-0 grid-cols-1",
        splitTrackClass[breakpoint][tracks],
        gap,
        props.padding ? paddingClass[props.padding] : undefined,
        // Grow to fill a `fill`-aware parent; CSS grid's default stretch
        // then sizes the single row to that height and both pane divs (grid
        // items, `align-items: stretch` by default) match it automatically.
        props.fill ? "min-h-0 flex-1" : undefined,
      )}
    >
      <div
        className={cn(
          "flex min-w-0 min-h-0 flex-col",
          gap,
          splitSpanClass[breakpoint][firstSpan],
          reverse ? cn("order-2", splitOrderResetClass[breakpoint]) : undefined,
          // Same per-pane scroll backstop as `Stack.fill` — a pane whose
          // content overflows the row height scrolls on its own rather than
          // dragging the other pane along via a shared ancestor scrollbar.
          props.fill ? "overflow-y-auto" : undefined,
        )}
      >
        {panes[0] ?? null}
      </div>
      <div
        className={cn(
          "flex min-w-0 min-h-0 flex-col",
          gap,
          splitSpanClass[breakpoint][secondSpan],
          reverse ? cn("order-1", splitOrderResetClass[breakpoint]) : undefined,
          props.fill ? "overflow-y-auto" : undefined,
        )}
      >
        {/* Everything past the first child belongs to the second pane. */}
        {panes.slice(1)}
      </div>
    </div>
  );
}

function DividerComponent({ props }: { props: { label?: string } }) {
  if (!props.label) return <Separator className="my-1" />;
  return (
    <div className="flex items-center gap-3 py-1">
      <Separator className="shrink flex-1" />
      <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {props.label}
      </span>
      <Separator className="shrink flex-1" />
    </div>
  );
}

// ─── Tabs ───────────────────────────────────────────────────────────────────

function TabsComponent({ props, children }: { props: TabsComponentProps; children: ReactNode }) {
  const { state, set } = useStateStore();
  const tabs = (props.tabs ?? []) as TabsTab[];
  const panels = positionalChildren(children);
  const path = `/ui/${props.id}/tab`;

  const stored = getByPath(state, path);
  const fallback =
    props.defaultTab && tabs.some((tab) => tab.key === props.defaultTab)
      ? props.defaultTab
      : (tabs[0]?.key ?? "");
  const active =
    typeof stored === "string" && tabs.some((tab) => tab.key === stored) ? stored : fallback;

  // Seed `/ui/<id>/tab` on mount (so `$state` bindings resolve immediately) and
  // self-heal if a stored key disappears from `tabs` after an app edit.
  useEffect(() => {
    if (active && stored !== active) set(path, active);
  }, [active, stored, path, set]);

  if (tabs.length === 0) return null;

  // Extra children past the tab count join the last panel rather than
  // vanishing silently.
  const bodyFor = (index: number) =>
    index === tabs.length - 1 ? panels.slice(index) : (panels[index] ?? null);
  const tabLabel = (tab: TabsTab) => (
    <>
      <CatalogIcon name={tab.icon} size="sm" />
      {tab.label ?? tab.key}
      {typeof tab.count === "number" && Number.isFinite(tab.count) ? (
        <CountPill value={tab.count} />
      ) : null}
    </>
  );

  if (props.variant === "segmented") {
    // Same state and the same warm panels as the tab strip: every body stays
    // mounted, the inactive ones hidden.
    return (
      <div className="flex min-w-0 flex-col gap-3" data-testid="json-render-tabs">
        <SegmentedControl
          aria-label="Sections"
          value={active}
          onValueChange={(next) => set(path, next)}
          options={tabs.map((tab) => ({
            value: tab.key,
            label: <span className="inline-flex items-center gap-1.5">{tabLabel(tab)}</span>,
          }))}
          className="self-start"
        />
        {tabs.map((tab, index) => (
          <div
            key={tab.key}
            hidden={tab.key !== active}
            className={cn("flex min-w-0 flex-col gap-4", tab.key !== active && "hidden")}
          >
            {bodyFor(index)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <Tabs
      value={active}
      onValueChange={(next) => set(path, next)}
      className="gap-3"
      data-testid="json-render-tabs"
    >
      <TabsList>
        {tabs.map((tab) => (
          <TabsTrigger key={tab.key} value={tab.key}>
            {tabLabel(tab)}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab, index) => {
        const isActive = tab.key === active;
        return (
          // `forceMount` keeps every panel mounted (polled Tables in background
          // tabs stay warm) — it also forces them VISIBLE, so `hidden` is set
          // explicitly. Radix spreads caller props after its own `hidden`.
          <TabsContent
            key={tab.key}
            value={tab.key}
            forceMount
            hidden={!isActive}
            className={cn("flex min-w-0 flex-col gap-4", !isActive && "hidden")}
          >
            {bodyFor(index)}
          </TabsContent>
        );
      })}
    </Tabs>
  );
}

// ─── SearchInput / Select (the `/ui/<id>` interactivity root) ───────────────

function SearchInputComponent({ props }: { props: SearchInputProps }) {
  const { state, get, set } = useStateStore();
  const path = `/ui/${props.id}/value`;
  const inputId = `ui-${props.id}`;

  // Local mirror keeps typing instant; the store only sees the settled value.
  const [text, setText] = useState(() => {
    const initial = get(path);
    return typeof initial === "string" ? initial : "";
  });
  const debounced = useDebouncedValue(text, 200);

  const setRef = useRef(set);
  setRef.current = set;
  // Last value THIS component pushed — anything else in the store is an
  // external write and wins over the local mirror.
  const pushedRef = useRef(text);
  useEffect(() => {
    pushedRef.current = debounced;
    setRef.current(path, debounced);
  }, [debounced, path]);

  const stored = getByPath(state, path);
  useEffect(() => {
    const next = typeof stored === "string" ? stored : "";
    // Ignore the echo of our own debounced write; adopt genuine external
    // writes (e.g. a future "clear all filters" action) so the field can't
    // show stale text while the bound Table already reflects the new value.
    if (next === pushedRef.current) return;
    pushedRef.current = next;
    setText(next);
  }, [stored]);

  const inputRef = useRef<HTMLInputElement>(null);
  usePageShortcut(props.shortcut, inputRef, () => inputRef.current?.focus());

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {props.label ? <Label htmlFor={inputId}>{props.label}</Label> : null}
      <SearchBox
        id={inputId}
        inputRef={inputRef}
        value={text}
        onChange={setText}
        ariaLabel={props.label ?? props.placeholder ?? "Search"}
        placeholder={props.placeholder ?? "Search…"}
        clearable
        hint={props.shortcut ? <Kbd aria-hidden>{props.shortcut}</Kbd> : undefined}
      />
    </div>
  );
}

function NumberInputComponent({ props }: { props: NumberInputProps }) {
  const { state, get, set } = useStateStore();
  const path = `/ui/${props.id}/value`;
  const inputId = `ui-${props.id}`;

  const [text, setText] = useState(() => {
    const initial = get(path);
    return typeof initial === "number" ? String(initial) : "";
  });

  const setRef = useRef(set);
  setRef.current = set;
  // Last value THIS component pushed — mirrors SearchInput's echo guard so an
  // external write (not our own commit) can still override the local mirror.
  const pushedRef = useRef<number | null>(parseNumberInputValue(text) ?? null);

  const stored = getByPath(state, path);
  useEffect(() => {
    const next = typeof stored === "number" ? stored : null;
    if (next === pushedRef.current) return;
    pushedRef.current = next;
    setText(next === null ? "" : String(next));
  }, [stored]);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {props.label ? <Label htmlFor={inputId}>{props.label}</Label> : null}
      <Input
        id={inputId}
        // A text field, not `type="number"`: the browser sanitizes a number
        // input to "" while the text is a non-numeric edit ("5" → select-all →
        // "-", or "1" → "1e"), which would write `null` to the store mid-edit
        // and briefly drop a bound Table's filter. Plain text hands us the raw
        // characters, so `parseNumberInputValue` can leave the store untouched.
        type="text"
        inputMode="decimal"
        placeholder={props.placeholder}
        aria-label={props.label ?? props.placeholder ?? "Number"}
        value={text}
        onChange={(event) => {
          const raw = event.target.value;
          setText(raw);
          const next = parseNumberInputValue(raw, props.min, props.max);
          // `undefined` is non-numeric text (a bare "-" mid-edit, letters):
          // leave the store untouched instead of clobbering it.
          if (next === undefined) return;
          pushedRef.current = next;
          setRef.current(path, next);
        }}
        onBlur={() => {
          // Snap the visible text to the clamped stored value on leaving the
          // field; empty or non-numeric text stays as typed.
          const settled = parseNumberInputValue(text, props.min, props.max);
          if (typeof settled === "number") setText(String(settled));
        }}
      />
    </div>
  );
}

type NormalizedSelectOption = { value: string; label: string; icon?: string; hint?: string };

function normalizeSelectOptions(options: SelectOption[]): NormalizedSelectOption[] {
  const seen = new Set<string>();
  const normalized: NormalizedSelectOption[] = [];
  for (const option of options) {
    const value = typeof option === "string" ? option : option.value;
    // Radix reserves the empty string for "no selection".
    if (!value || seen.has(value)) continue;
    seen.add(value);
    if (typeof option === "string") {
      normalized.push({ value, label: value });
      continue;
    }
    normalized.push({ value, label: option.label ?? value, icon: option.icon, hint: option.hint });
  }
  return normalized;
}

/** Past this many options a Select filters as you type unless told otherwise. */
const SELECT_SEARCHABLE_AFTER = 8;

function SelectFilterComponent({ props }: { props: SelectFilterProps }) {
  const { state, get, set } = useStateStore();
  const themeAttr = useJsonRenderThemeAttr();
  const path = `/ui/${props.id}/value`;
  const triggerId = `ui-${props.id}`;
  const options = normalizeSelectOptions((props.options ?? []) as SelectOption[]);
  const clearable = props.clearable ?? true;

  const multiple = props.multiple === true;
  const searchable = props.searchable ?? options.length > SELECT_SEARCHABLE_AFTER;

  const stored = getByPath(state, path);
  const value = typeof stored === "string" ? stored : "";
  const values = Array.isArray(stored)
    ? stored.filter((entry): entry is string => typeof entry === "string")
    : [];
  const hasValue = multiple ? values.length > 0 : value !== "";

  // Seed `/ui/<id>/value` so a bound `filters` entry resolves to `null` / `[]`
  // (= filter disabled) instead of `undefined` before the first interaction —
  // or to `defaultValue` when the usage wants a preselected option.
  const getRef = useRef(get);
  getRef.current = get;
  const setRef = useRef(set);
  setRef.current = set;
  useEffect(() => {
    if (getRef.current(path) !== undefined) return;
    const seed = props.defaultValue;
    setRef.current(path, multiple ? (seed ? [seed] : []) : (seed ?? null));
  }, [path, multiple, props.defaultValue]);

  // A standalone Select (no `label`) has no accessible name — fall back to the
  // placeholder, mirroring `SearchBox`'s ariaLabel chain.
  const ariaLabel = props.label ? undefined : (props.placeholder ?? "Select an option");
  const clearButton =
    clearable && hasValue ? (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Clear ${props.label ?? "selection"}`}
        className="absolute right-7 top-1/2 size-7 -translate-y-1/2 text-muted-foreground"
        onClick={() => set(path, multiple ? [] : null)}
      >
        <X className="size-3.5" />
      </Button>
    ) : null;

  if (multiple || searchable) {
    const comboOptions = options.map((option) => ({
      value: option.value,
      label: option.label,
      hint: option.hint,
      icon: <CatalogIcon name={option.icon} size="sm" className="text-muted-foreground" />,
    }));
    const common = {
      id: triggerId,
      "aria-label": ariaLabel,
      options: comboOptions,
      placeholder: props.placeholder ?? "All",
      searchPlaceholder: props.searchPlaceholder,
      searchable,
      contentAttrs: themeAttr,
      triggerClassName: cn(
        "w-full min-w-0",
        hasValue && clearable ? "[&>span:first-child]:mr-7" : undefined,
      ),
    };
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        {props.label ? <Label htmlFor={triggerId}>{props.label}</Label> : null}
        <div className="relative min-w-0">
          {multiple ? (
            <SearchableMultiSelect
              {...common}
              values={values}
              onChange={(next) => set(path, next)}
            />
          ) : (
            <SearchableSelect {...common} value={value} onChange={(next) => set(path, next)} />
          )}
          {clearButton}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {props.label ? <Label htmlFor={triggerId}>{props.label}</Label> : null}
      {/*
        The clear affordance is overlaid INSIDE the trigger (mirroring
        `SearchBox`) rather than placed beside it: a sibling button would steal
        width and break right-edge alignment with the SearchInput above, and it
        would come and go as the value changes. It sits left of the chevron, and
        the value slot reserves a matching right margin so a long option label
        never runs underneath. A `<button>` cannot nest inside the trigger
        button, hence the absolute overlay.
      */}
      <div className="relative min-w-0">
        <Select value={value} onValueChange={(next) => set(path, next)}>
          <SelectTrigger
            id={triggerId}
            aria-label={ariaLabel}
            className={cn(
              "w-full min-w-0",
              clearable && value ? "*:data-[slot=select-value]:mr-7" : undefined,
            )}
          >
            <SelectValue placeholder={props.placeholder ?? "All"} />
          </SelectTrigger>
          <SelectContent {...themeAttr}>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <CatalogIcon name={option.icon} size="sm" className="text-muted-foreground" />
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {clearButton}
      </div>
    </div>
  );
}

// ─── Chips ──────────────────────────────────────────────────────────────────

type ChipsComponentProps = InferComponentProps<typeof swarmCatalog, "Chips">;

function normalizeChipOptions(
  options: ChipOption[],
): { value: string; label: string; icon?: string }[] {
  const seen = new Set<string>();
  const normalized: { value: string; label: string; icon?: string }[] = [];
  for (const option of options) {
    const value = typeof option === "string" ? option : option.value;
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(
      typeof option === "string"
        ? { value, label: value }
        : { value, label: option.label ?? value, icon: option.icon },
    );
  }
  return normalized;
}

/**
 * Toggle chips writing `/ui/<id>/value`: one string or `null`, or with
 * `multiple` a string array (in option order). Bound into Table `filters`, an
 * array means "cell is one of", and an empty one disables the filter.
 */
function ChipsComponent({ props }: { props: ChipsComponentProps }) {
  const { state, get, set } = useStateStore();
  const path = `/ui/${props.id}/value`;
  const multiple = props.multiple === true;
  const options = normalizeChipOptions((props.options ?? []) as ChipOption[]);

  const stored = getByPath(state, path);
  const selected = multiple
    ? Array.isArray(stored)
      ? stored.filter((entry): entry is string => typeof entry === "string")
      : []
    : typeof stored === "string"
      ? [stored]
      : [];

  // Seed the slot so a bound filter reads "off" (`null` / `[]`) before the
  // first press, the way Select seeds `null`.
  const getRef = useRef(get);
  getRef.current = get;
  const setRef = useRef(set);
  setRef.current = set;
  useEffect(() => {
    if (getRef.current(path) === undefined) setRef.current(path, multiple ? [] : null);
  }, [path, multiple]);

  const toggle = (value: string) => {
    if (!multiple) {
      set(path, selected[0] === value ? null : value);
      return;
    }
    const on = new Set(selected);
    if (on.has(value)) on.delete(value);
    else on.add(value);
    set(
      path,
      options.filter((option) => on.has(option.value)).map((option) => option.value),
    );
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls; these are toggle buttons
    <div
      role="group"
      aria-label={props.label ?? "Filters"}
      className="flex min-w-0 flex-wrap items-center gap-1.5"
    >
      {options.map((option) => (
        <ChipButton
          key={option.value}
          pressed={selected.includes(option.value)}
          onClick={() => toggle(option.value)}
        >
          <CatalogIcon name={option.icon} size="sm" />
          {option.label}
        </ChipButton>
      ))}
    </div>
  );
}

// ─── Table ──────────────────────────────────────────────────────────────────

type TableProps = InferComponentProps<typeof swarmCatalog, "Table">;
type FormProps = InferComponentProps<typeof swarmCatalog, "Form">;

/**
 * Keeps an object identity stable while its JSON signature is unchanged.
 * AG Grid re-creates columns whenever `columnDefs` changes identity, and the
 * app runtime re-renders every poll cycle (5s), so the column defs must not
 * churn.
 */
function useStableBySignature<T>(value: T, signature: string): T {
  const ref = useRef<{ signature: string; value: T }>({ signature, value });
  if (ref.current.signature !== signature) {
    ref.current = { signature, value };
  }
  return ref.current.value;
}

const DESTRUCTIVE_VARIANTS = new Set(["destructive", "destructive-outline"]);

/** Row deletes are unrecoverable (rows have no version history), so `confirm:
 * false` cannot opt an `app.mutate` delete out of the dialog. */
function chainDeletesRows(rowAction: TableRowAction | DrawerAction): boolean {
  return rowAction.actions.some(
    (action) => action.action === "app.mutate" && action.params?.op === "delete",
  );
}

/**
 * Whether a row action must go through an `AlertDialog` first, and with what
 * copy. `apps/ui/CLAUDE.md` makes confirmation a hard rule for destructive actions,
 * so destructive variants default to confirming even when the JSON author says
 * nothing — an app definition cannot ship a one-click delete by omission. The
 * `confirm: false` opt-out exists for destructive-looking-but-reversible
 * actions; a chain that actually deletes rows always confirms.
 */
function confirmConfigFor(rowAction: TableRowAction | DrawerAction): TableRowActionConfirm | null {
  const confirm = rowAction.confirm;
  if (confirm === false) return chainDeletesRows(rowAction) ? {} : null;
  if (confirm === undefined)
    return DESTRUCTIVE_VARIANTS.has(rowAction.variant ?? "outline") || chainDeletesRows(rowAction)
      ? {}
      : null;
  if (confirm === true) return {};
  if (typeof confirm === "string") return { description: confirm };
  return confirm;
}

interface PendingRowAction {
  rowActionIndex: number;
  row: Record<string, unknown>;
  rowIndex: number;
}

/**
 * Floor width for a stretch (`flex: 1`) column. Prose needs room to be readable
 * before the ellipsis kicks in; a badge or a yes/no never does.
 */
function minWidthForKind(kind: TableColumn["kind"]): number {
  switch (kind) {
    case "boolean":
    case "switch":
      return 85;
    case "number":
    case "duration":
      return 95;
    case "badge":
    case "enum":
      return 105;
    case "date":
    case "relative":
      return 110;
    case "status":
    case "progress":
      return 120;
    default:
      return 130;
  }
}

/**
 * Stretch weight. Prose columns claim twice the leftover width of a badge /
 * date / yes-no column, which is where the reading happens.
 */
function flexForKind(kind: TableColumn["kind"]): number {
  return kind === undefined || kind === "text" || kind === "string" || kind === "json" ? 2 : 1;
}

/** Columns whose values read best right-aligned with tabular digits. */
const END_ALIGNED_KINDS = new Set<TableColumn["kind"]>(["number", "duration", "progress"]);

/** Roughly `sm` button metrics: 24px of label padding + ~7px per character (+18px for an icon). */
function rowActionButtonWidth(rowAction: TableRowAction): number {
  const icon = catalogIcon(rowAction.icon) ? 18 : 0;
  return Math.max(56, Math.round(rowAction.label.trim().length * 7 + 24 + icon));
}

/**
 * Cell padding + every inline button at its natural width + the 6px gaps
 * between them + the 32px "More" button when any action sits in the menu.
 */
function rowActionsColumnWidth(rowActions: TableRowAction[]): number {
  const inline = rowActions.filter((rowAction) => rowAction.placement !== "menu");
  const buttons = inline.reduce((total, rowAction) => total + rowActionButtonWidth(rowAction), 0);
  const hasMenu = inline.length < rowActions.length;
  const slots = inline.length + (hasMenu ? 1 : 0);
  return 28 + buttons + (hasMenu ? 32 : 0) + 6 * Math.max(0, slots - 1);
}

/** A row's id from its `rowId` field, falling back to its JSON (DataGrid's default). */
function rowIdOf(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value === "string" || typeof value === "number") return String(value);
  return JSON.stringify(row);
}

/** Header label with a leading icon (AG Grid inner header component). */
function IconHeader(params: { displayName: string; icon?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <CatalogIcon name={params.icon} size="sm" className="size-3 text-muted-foreground" />
      <span className="ag-header-cell-text">{params.displayName}</span>
    </span>
  );
}

/** The phone row's status slot, rendered like the grid cell. */
function statusNode(column: TableColumn, value: unknown): ReactNode {
  if (value === null || value === undefined || value === "") return undefined;
  const raw = String(value);
  if (column.kind === "status") return <StatusCell value={raw} tones={column.tones} />;
  return <StatusPill text={raw} tone={badgeToneFor(column.tones, raw)} />;
}

/**
 * Row count at which the grid stops hugging its content and becomes a fixed-
 * height scroll region — past this, `autoHeight` would render every row (no
 * virtualization) and push the rest of the page off screen.
 */
const AUTO_HEIGHT_MAX_ROWS = 12;

// ─── Client-side search / filtering ─────────────────────────────────────────
//
// Honest at spike scale: the runtime already polls the whole (capped) row set
// every 5s, so narrowing it in the browser costs nothing and avoids a server
// query-override machinery. `search` / `filters` are normal props, so they can
// be bound to `/ui/<id>/value` or pinned to a constant.

/** `null` / `""` / `undefined` / `[]` mean "this filter is off". */
function isFilterActive(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isFilterActive);
  return value !== null && value !== undefined && value !== "";
}

function toFilterBoolean(cell: unknown): boolean {
  if (typeof cell === "boolean") return cell;
  if (typeof cell === "number") return cell !== 0;
  if (typeof cell === "string") return cell === "true" || cell === "1";
  return false;
}

/** Case-insensitive substring match over the string/number cells of the listed columns. */
function rowMatchesSearch(
  row: Record<string, unknown>,
  columnKeys: string[],
  needle: string,
): boolean {
  return columnKeys.some((key) => {
    const cell = row[key];
    if (typeof cell === "string") return cell.toLowerCase().includes(needle);
    if (typeof cell === "number") return String(cell).includes(needle);
    return false;
  });
}

/** One cell against one filter value; strings compare case-insensitively (enum/tag columns). */
function cellMatchesFilter(cell: unknown, filter: unknown): boolean {
  if (typeof filter === "boolean") return toFilterBoolean(cell) === filter;
  if (typeof filter === "number") {
    return cell !== null && cell !== undefined && Number(cell) === filter;
  }
  return String(cell ?? "").toLowerCase() === String(filter).toLowerCase();
}

/** Per-column equality; an array filter means "cell is one of" (a multiple `Chips`). */
function rowMatchesFilters(
  row: Record<string, unknown>,
  filters: NonNullable<TableFilters>,
): boolean {
  for (const [key, filter] of Object.entries(filters)) {
    if (!isFilterActive(filter)) continue;
    const cell = row[key];
    const accepted = Array.isArray(filter) ? filter.filter(isFilterActive) : [filter];
    if (!accepted.some((value) => cellMatchesFilter(cell, value))) return false;
  }
  return true;
}

function TableComponent({ props }: { props: TableProps }) {
  const { execute } = useActions();
  const { getSnapshot } = useStateStore();
  const themeAttr = useJsonRenderThemeAttr();
  const [pendingRowAction, setPendingRowAction] = useState<PendingRowAction | null>(null);

  const propsRef = useRef(props);
  propsRef.current = props;
  const executeRef = useRef(execute);
  executeRef.current = execute;
  const snapshotRef = useRef(getSnapshot);
  snapshotRef.current = getSnapshot;

  const runChain = useCallback(
    async (chain: ActionChain | undefined, row: Record<string, unknown>, index: number) => {
      if (!chain) return;
      const scope = { row, rowIndex: index, state: snapshotRef.current() };
      for (const binding of chain) {
        await executeRef.current({
          ...binding,
          params: resolveScopedParams(binding.params, scope),
        });
      }
    },
    [],
  );

  const runRowAction = useCallback(
    async (rowActionIndex: number, row: Record<string, unknown>, index: number) => {
      const rowAction = propsRef.current.rowActions?.[rowActionIndex] as TableRowAction | undefined;
      if (!rowAction) return;
      await runChain(rowAction.actions, row, index);
    },
    [runChain],
  );

  /**
   * Cell-renderer entry point. Confirmation state deliberately lives on the
   * Table (not inside the cell renderer): the app runtime re-polls every 5s and
   * AG Grid can tear down cell renderers on refresh, which would silently close
   * an open dialog mid-decision.
   */
  const requestRowAction = useCallback(
    (rowActionIndex: number, row: Record<string, unknown>, index: number) => {
      const rowAction = propsRef.current.rowActions?.[rowActionIndex] as TableRowAction | undefined;
      if (!rowAction) return;
      if (!confirmConfigFor(rowAction)) {
        void runRowAction(rowActionIndex, row, index);
        return;
      }
      setPendingRowAction({ rowActionIndex, row, rowIndex: index });
    },
    [runRowAction],
  );

  // Keyboard path to the row-action buttons. The buttons are natively
  // tabbable, but AG Grid's arrow-key navigation moves CELL focus — landing on
  // the actions cell must hand focus into it, or arrow-key users dead-end on
  // a cell whose buttons they can see but not press. Enter drills in; Tab
  // then walks the buttons as before.
  const onCellKeyDown = useCallback(
    (
      event:
        | CellKeyDownEvent<Record<string, unknown>>
        | FullWidthCellKeyDownEvent<Record<string, unknown>>,
    ) => {
      if (!("column" in event)) return;
      const browserEvent = event.event as KeyboardEvent | undefined;
      if (!browserEvent || browserEvent.key !== "Enter") return;
      const target = browserEvent.target as HTMLElement | null;
      // Only when the CELL itself is focused — a button inside the cell
      // handles its own Enter as a click.
      if (!target || !target.classList.contains("ag-cell")) return;
      if (event.column.getColId() === "__rowActions") {
        target.querySelector<HTMLButtonElement>("button")?.focus();
        return;
      }
      // Enter on any other cell opens the row, like a click.
      const chain = propsRef.current.onRowClick as ActionChain | undefined;
      if (chain && event.data) void runChain(chain, event.data, event.rowIndex ?? 0);
    },
    [runChain],
  );

  const columns = (props.columns ?? []) as TableColumn[];
  const rowActions = (props.rowActions ?? []) as TableRowAction[];
  const onRowClickChain = props.onRowClick as ActionChain | undefined;
  const hasRowClick = Boolean(onRowClickChain?.length);
  const allRows = Array.isArray(props.data) ? (props.data as Record<string, unknown>[]) : [];
  const rowIdField = props.rowId ?? "id";
  const rowId = useCallback(
    (row: Record<string, unknown>) => rowIdOf(row, rowIdField),
    [rowIdField],
  );
  const selectedId =
    props.selectedId === null || props.selectedId === undefined || props.selectedId === ""
      ? null
      : String(props.selectedId);

  const search = typeof props.search === "string" ? props.search.trim().toLowerCase() : "";
  // Held by signature, not identity: a bound `columns` / `filters` object is
  // rebuilt by the binding resolver on every 5s poll.
  const columnKeys = useStableBySignature(
    columns.map((column) => column.key),
    JSON.stringify(columns.map((column) => column.key)),
  );
  const filters = useStableBySignature(
    (props.filters ?? {}) as NonNullable<TableFilters>,
    JSON.stringify(props.filters ?? {}),
  );
  const narrowing = search !== "" || Object.values(filters).some(isFilterActive);

  const rows = useMemo(() => {
    if (!narrowing) return allRows;
    return allRows.filter(
      (row) =>
        (search === "" || rowMatchesSearch(row, columnKeys, search)) &&
        rowMatchesFilters(row, filters),
    );
  }, [allRows, narrowing, search, columnKeys, filters]);

  // Distinguish "nothing here yet" from "your search hid everything".
  const narrowedToEmpty = narrowing && rows.length === 0 && allRows.length > 0;
  const emptyMessage = narrowedToEmpty
    ? "No rows match the current search or filters"
    : (props.emptyMessage ?? "No rows yet");
  const emptyState = props.emptyState;
  const empty = narrowedToEmpty ? (
    <EmptyState
      icon={SearchX}
      title={emptyMessage}
      description="Clear a filter to see more rows."
    />
  ) : (
    <EmptyState
      icon={catalogIcon(emptyState?.icon) ?? Inbox}
      title={emptyState?.title ?? emptyMessage}
      description={emptyState?.body}
    />
  );

  const builtColumnDefs: ColDef<Record<string, unknown>>[] = columns.map((column) => {
    const template = column.format;
    // A templated column renders its `{{field}}` text verbatim — `kind` only
    // drives a single-field column.
    const kind = template ? undefined : column.kind;
    const endAligned = column.align ? column.align === "end" : END_ALIGNED_KINDS.has(kind);
    return {
      headerName: column.label ?? column.key,
      // A templated column has no `field`, so name the column explicitly.
      colId: column.key,
      // A templated column has no single source field — its value is derived
      // from the whole row via `valueGetter` instead.
      field: template ? undefined : column.key,
      valueGetter: template
        ? (params: ValueGetterParams<Record<string, unknown>>) =>
            applyTemplate(template, params.data ?? {})
        : undefined,
      // Sort the composed text naturally ("v2" before "v10").
      comparator: template
        ? (a: unknown, b: unknown) =>
            String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true })
        : undefined,
      // Explicit `width` pins a column; everything else stretches (`flex: 1`) from
      // a kind-appropriate floor. Never `sizeColumnsToFit` here — see the
      // `columnSizing="flex"` note on `DataGrid`.
      width: column.width,
      flex: column.width ? undefined : flexForKind(kind),
      minWidth: column.width ? undefined : minWidthForKind(kind),
      // Pinned columns survive horizontal scroll (id on the left, status on the
      // right) — the mobile answer for wide tables.
      pinned: column.pinned,
      type: endAligned ? "rightAligned" : undefined,
      // `cellClass` replaces the `rightAligned` type's own class, so keep it.
      cellClass: endAligned ? ["ag-right-aligned-cell", "tabular-nums"] : undefined,
      tooltipField: column.tooltip,
      headerComponentParams: catalogIcon(column.icon)
        ? { innerHeaderComponent: IconHeader, icon: column.icon }
        : undefined,
      // AG Grid's cell-data-type inference turns a boolean column into a disabled
      // checkbox renderer, which contradicts the documented `formatCell` contract
      // (yes / no text) and reads as a broken toggle. Opt every app column out of
      // inference and let the value formatter own the rendering.
      cellDataType: false,
      valueFormatter: (params) =>
        template ? String(params.value ?? "") : formatValue(kind, params.value),
      cellRenderer: (params: ICellRendererParams<Record<string, unknown>>) => {
        const value = params.value;
        const row = (params.data ?? {}) as Record<string, unknown>;
        const raw = value === null || value === undefined ? "" : String(value);
        switch (kind) {
          case "badge":
            return raw ? <StatusPill text={raw} tone={badgeToneFor(column.tones, raw)} /> : null;
          case "status":
            return raw ? <StatusCell value={raw} tones={column.tones} /> : null;
          case "user":
          case "agent":
            return raw ? <PersonCell name={raw} agent={column.kind === "agent"} /> : null;
          case "date":
          case "relative":
            return raw ? <RelativeTimeCell value={value} /> : null;
          case "progress":
            return <ProgressCell value={value} max={column.max} />;
          case "copy":
            return raw ? <CopyCell value={raw} middle={column.truncate === "middle"} /> : null;
          case "switch": {
            const chain = column.onChange as ActionChain | undefined;
            return (
              <Switch
                checked={toFilterBoolean(value)}
                disabled={!chain?.length}
                aria-label={column.label ?? column.key}
                onCheckedChange={(checked) =>
                  void runChain(chain, { ...row, [column.key]: checked }, params.node.rowIndex ?? 0)
                }
              />
            );
          }
          case "link": {
            const href = safeHttpUrl(value);
            if (!href) return raw ? <span className="block min-w-0 truncate">{raw}</span> : null;
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-w-0 max-w-full items-center gap-1 text-primary hover:underline"
              >
                <span className="min-w-0 truncate">{raw}</span>
                <ExternalLink aria-hidden className="size-3 shrink-0" />
              </a>
            );
          }
          default: {
            // AG Grid drops a plain value straight into the cell, which is a flex
            // row — the text becomes an anonymous flex item, and `text-overflow`
            // never applies to one, so long titles hard-clip mid-word. Wrapping
            // the value in a real element gives the ellipsis something to bite on
            // (and a native tooltip carrying the full text).
            const text = params.valueFormatted ?? (template ? raw : formatValue(kind, value));
            if (!text) return null;
            if (column.truncate === "middle") {
              return <MiddleTruncation className="block w-full">{text}</MiddleTruncation>;
            }
            return (
              <span className="block w-full truncate" title={column.tooltip ? undefined : text}>
                {text}
              </span>
            );
          }
        }
      },
    };
  });

  if (rowActions.length > 0) {
    const inlineActions = rowActions
      .map((rowAction, index) => ({ rowAction, index }))
      .filter(({ rowAction }) => rowAction.placement !== "menu");
    const menuActions = rowActions
      .map((rowAction, index) => ({ rowAction, index }))
      .filter(({ rowAction }) => rowAction.placement === "menu");
    builtColumnDefs.push({
      headerName: "",
      colId: "__rowActions",
      sortable: false,
      filter: false,
      // Fixed, content-derived width: the buttons must not stretch with the
      // panel, and must not get squeezed below their labels either (a clipped
      // action is an unreachable action).
      width: rowActionsColumnWidth(rowActions),
      minWidth: rowActionsColumnWidth(rowActions),
      suppressSizeToFit: true,
      cellRenderer: (params: ICellRendererParams<Record<string, unknown>>) => {
        const row = (params.data ?? {}) as Record<string, unknown>;
        const rowIndex = params.node.rowIndex ?? 0;
        return (
          <div className="flex items-center gap-1.5">
            {inlineActions.map(({ rowAction, index }) => (
              <Button
                key={rowAction.label}
                size="sm"
                variant={rowAction.variant ?? "outline"}
                onClick={(event) => {
                  event.stopPropagation();
                  requestRowAction(index, row, rowIndex);
                }}
              >
                <CatalogIcon name={rowAction.icon} size="sm" />
                {rowAction.label}
              </Button>
            ))}
            {menuActions.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="More actions"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" {...themeAttr}>
                  {menuActions.map(({ rowAction, index }) => (
                    <DropdownMenuItem
                      key={rowAction.label}
                      variant={
                        DESTRUCTIVE_VARIANTS.has(rowAction.variant ?? "")
                          ? "destructive"
                          : "default"
                      }
                      onSelect={() => requestRowAction(index, row, rowIndex)}
                    >
                      <CatalogIcon name={rowAction.icon} size="sm" />
                      {rowAction.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        );
      },
    });
  }

  const columnDefs = useStableBySignature(builtColumnDefs, JSON.stringify([columns, rowActions]));
  const hugsContent = rows.length <= AUTO_HEIGHT_MAX_ROWS;
  // Endless-scroll guard: unless the author decided, big row sets paginate.
  const paginated = props.pagination ?? rows.length > 200;

  // Phone layout: a card list, unless the author keeps the grid, or the table
  // only exposes its actions as row buttons (a list row has no room for them).
  const mobileMode = props.mobile ?? (rowActions.length > 0 && !hasRowClick ? "scroll" : "list");
  const mobileFields = props.mobileFields;
  const columnByKey = new Map(columns.map((column) => [column.key, column]));
  const titleKey =
    mobileFields?.title ??
    columns.find((column) => !column.kind || column.kind === "text" || column.kind === "string")
      ?.key ??
    columns[0]?.key;
  const statusKey =
    mobileFields?.status ??
    columns.find((column) => column.kind === "status" || column.kind === "badge")?.key;
  const metaKeys: string[] = mobileFields
    ? [
        ...(mobileFields.subtitle ? [mobileFields.subtitle] : []),
        ...(Array.isArray(mobileFields.meta)
          ? mobileFields.meta
          : mobileFields.meta
            ? [mobileFields.meta]
            : []),
      ]
    : columns
        .map((column) => column.key)
        .filter((key) => key !== titleKey && key !== statusKey)
        .slice(0, 2);
  // Same text as the desktop cell: a templated column renders its `format`.
  const mobileCellText = (key: string, row: Record<string, unknown>): string => {
    const column = columnByKey.get(key);
    return column?.format ? applyTemplate(column.format, row) : formatValue(column?.kind, row[key]);
  };
  const mobileRow =
    mobileMode === "list"
      ? (row: Record<string, unknown>): ListViewMobileRow => ({
          title: (titleKey ? mobileCellText(titleKey, row) : "") || "Untitled",
          status: statusKey
            ? statusNode(
                columnByKey.get(statusKey) ?? { key: statusKey, kind: "badge" },
                row[statusKey],
              )
            : undefined,
          meta: metaKeys.map((key) => mobileCellText(key, row)),
        })
      : undefined;

  const confirmingAction = pendingRowAction
    ? rowActions[pendingRowAction.rowActionIndex]
    : undefined;

  return (
    // `min-w-0` lets the grid shrink below its column total inside flex/grid
    // parents so AG Grid owns the horizontal scroll instead of the card clipping it.
    <div className="flex min-w-0 flex-col gap-2" data-testid="json-render-table">
      {props.error ? (
        <AlertCallout tone="error" icon={AlertCircle} title="Query failed">
          {props.error}
        </AlertCallout>
      ) : null}
      <ListView
        rows={rows}
        label={props.emptyState?.title ?? "Rows"}
        rowId={rowId}
        columnDefs={columnDefs}
        loading={props.loading ?? false}
        emptyMessage={emptyMessage}
        empty={empty}
        selectedId={selectedId}
        onRowClick={
          hasRowClick
            ? (row, index) => void runChain(onRowClickChain, row as Record<string, unknown>, index)
            : undefined
        }
        mobileRow={mobileRow}
        // Hug the content while the table is short (a 1-row filtered result
        // shouldn't sit on a slab of dead space), then cap into a scroll region.
        domLayout={hugsContent ? "autoHeight" : "normal"}
        className={cn(
          "json-render-grid",
          hugsContent && rows.length > 0 && "ag-grid-hug",
          !hugsContent && "h-[520px] flex-none",
        )}
        columnSizing="flex"
        pagination={paginated}
        rowHeight={props.density === "compact" ? 34 : undefined}
        cellFocus={rowActions.length > 0 || hasRowClick}
        onCellKeyDown={rowActions.length > 0 || hasRowClick ? onCellKeyDown : undefined}
      />
      <ChainConfirmDialog
        action={confirmingAction}
        onCancel={() => setPendingRowAction(null)}
        onConfirm={() => {
          const pending = pendingRowAction;
          setPendingRowAction(null);
          if (pending) {
            void runRowAction(pending.rowActionIndex, pending.row, pending.rowIndex);
          }
        }}
      />
    </div>
  );
}

/**
 * The confirmation step for a chain-carrying action (Table row actions,
 * Drawer footer actions): open while `action` is set, copy from
 * `confirmConfigFor`. Lives on the owning block, never inside a cell
 * renderer, so a 5s poll cannot tear it down mid-decision.
 */
function ChainConfirmDialog({
  action,
  onCancel,
  onConfirm,
}: {
  action: TableRowAction | DrawerAction | undefined;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const themeAttr = useJsonRenderThemeAttr();
  const copy = action ? confirmConfigFor(action) : null;
  const destructive = DESTRUCTIVE_VARIANTS.has(action?.variant ?? "outline");
  return (
    <AlertDialog
      open={action !== undefined}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent {...themeAttr}>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy?.title ?? `${action?.label ?? "Confirm"}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {copy?.description ?? "This action cannot be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={destructive ? "destructive" : "default"} onClick={onConfirm}>
            {copy?.confirmLabel ?? action?.label ?? "Confirm"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ─── Button / Metric ────────────────────────────────────────────────────────

/**
 * Standalone action button. `emit` is fire-and-forget (the renderer runs the
 * `on.press` chain detached), so the busy affordance reads the runtime's
 * `/actions/<busyWith>/status` slot instead of awaiting the dispatch — the
 * same state the `app.action` handler already maintains. Inside a BORROWED
 * bound element the assembler rewrites `busyWith` to the defining app's full
 * `/refs/<app>/actions/<name>` path (where the `$app`-tagged dispatch
 * actually writes), so a path-shaped value is used as-is.
 *
 * `busyWith` drives `ui/button`'s status variant: `loading` while the slot is
 * `"running"`, then `success` for the button's ~1.5s success window when THIS
 * mount saw it flip to `"ok"` (an `ok` left over from an earlier visit never
 * flashes, and a poll re-render never re-triggers it).
 */
function ActionButtonComponent({
  props,
  emit,
}: {
  props: ButtonComponentProps;
  emit: (event: string) => void;
}) {
  const { state } = useStateStore();
  const busySlot =
    props.busyWith === undefined
      ? null
      : props.busyWith.startsWith("/")
        ? props.busyWith
        : `/actions/${props.busyWith}`;
  const slotStatus = busySlot === null ? undefined : getByPath(state, `${busySlot}/status`);
  const busy = slotStatus === "running";

  const [succeeded, setSucceeded] = useState(false);
  const lastStatusRef = useRef(slotStatus);
  useEffect(() => {
    const previous = lastStatusRef.current;
    lastStatusRef.current = slotStatus;
    if (previous === "running" && slotStatus === "ok") setSucceeded(true);
    else if (slotStatus !== "ok") setSucceeded(false);
  }, [slotStatus]);
  const onStatusChange = useCallback((next: ButtonStatus) => {
    if (next === "idle") setSucceeded(false);
  }, []);
  const status: ButtonStatus | undefined =
    busySlot === null ? undefined : busy ? "loading" : succeeded ? "success" : "idle";

  const disabled = props.disabled === true;
  const buttonRef = useRef<HTMLButtonElement>(null);
  usePageShortcut(props.shortcut, buttonRef, () => {
    if (!disabled && !busy) emit("press");
  });

  // An author icon replaces the default trailing arrow.
  const hasIcon = catalogIcon(props.icon) !== undefined;
  const iconAtStart = hasIcon && props.iconPosition !== "end";
  const variant = props.variant ?? "default";
  const filled = variant === "default" || variant === "destructive";

  const button = (
    <Button
      ref={buttonRef}
      variant={variant}
      size={props.size ?? "default"}
      disabled={disabled}
      status={status}
      successLabel={props.successLabel}
      onStatusChange={onStatusChange}
      aria-keyshortcuts={props.shortcut}
      onClick={() => emit("press")}
    >
      {iconAtStart ? <CatalogIcon name={props.icon} size="sm" /> : null}
      {props.label}
      {hasIcon ? (
        iconAtStart ? null : (
          <CatalogIcon name={props.icon} size="sm" />
        )
      ) : (
        <ArrowRight className="h-3.5 w-3.5" />
      )}
      {props.shortcut ? (
        <Kbd aria-hidden tone={filled ? "inverted" : "default"}>
          {props.shortcut}
        </Kbd>
      ) : null}
    </Button>
  );
  if (!props.hint) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{props.hint}</TooltipContent>
    </Tooltip>
  );
}

const trendTone: Record<MetricTrend["direction"], { icon: typeof Info; text: string }> = {
  up: { icon: TrendingUp, text: "text-status-success-strong" },
  down: { icon: TrendingDown, text: "text-status-error-strong" },
  flat: { icon: Minus, text: "text-muted-foreground" },
};

/**
 * Stat tile on the dashboard's own `StatPanel`. A bound value is undefined
 * while its query loads — `loading` turns that window into a skeleton, and a
 * genuinely absent value renders an em dash, never the string "undefined".
 */
function MetricComponent({ props }: { props: MetricComponentProps }) {
  const value = props.value as unknown;
  const empty = value === undefined || value === null || value === "";
  const trend = props.trend as MetricTrend | undefined;
  const trendStyle = trend ? trendTone[trend.direction] : undefined;
  const TrendIcon = trendStyle?.icon;
  const detail =
    trend || props.detail ? (
      <span className="inline-flex flex-wrap items-center gap-x-1.5">
        {trend && trendStyle && TrendIcon ? (
          <span className={cn("inline-flex items-center gap-1 font-medium", trendStyle.text)}>
            <TrendIcon aria-hidden className="size-3" />
            {trend.label}
          </span>
        ) : null}
        {props.detail ? <span>{props.detail}</span> : null}
      </span>
    ) : undefined;
  return (
    <StatPanel
      icon={catalogIcon(props.icon)}
      label={props.label}
      value={
        props.loading && empty ? (
          <Skeleton inline className="h-7 w-16 align-middle" />
        ) : empty ? (
          "—"
        ) : (
          String(value)
        )
      }
      detail={detail}
      info={props.info}
      tone={props.tone ?? "neutral"}
    />
  );
}

// ─── Form ───────────────────────────────────────────────────────────────────

function coerceFieldValue(field: FormField, raw: unknown): unknown {
  if (field.kind === "number") {
    if (raw === "" || raw === undefined || raw === null) return undefined;
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (field.kind === "boolean") return raw === true;
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw);
  return text === "" ? undefined : text;
}

function FormComponent({ props }: { props: FormProps }) {
  const { state, get, set, getSnapshot } = useStateStore();
  const { execute } = useActions();
  const themeAttr = useJsonRenderThemeAttr();
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const fields = (props.fields ?? []) as FormField[];
  const basePath = `/forms/${props.id}`;
  // Read through the reactive `state` snapshot (not `get()`) so a cleared form
  // — `app.mutate` sets `/forms/<id>` to `{}` after a create — re-renders.
  const readField = (name: string): unknown => getByPath(state, `${basePath}/${name}`);

  // Mutate failures scoped to THIS form: the `app.mutate` handler writes them
  // to `/forms/<id>/$error` (keyed by the injected `formId`) instead of the
  // page-level banner. `$` keeps the slot out of the field-value namespace.
  const storedError = readField("$error");
  const submitError = typeof storedError === "string" && storedError !== "" ? storedError : null;

  const submit = async () => {
    const values: Record<string, unknown> = {};
    for (const field of fields) {
      const value = coerceFieldValue(field, get(`${basePath}/${field.name}`));
      if (field.required && (value === undefined || value === "")) {
        setValidationError(`${field.label ?? field.name} is required`);
        return;
      }
      if (value !== undefined) values[field.name] = value;
    }
    setValidationError(null);
    set(`${basePath}/$error`, null);
    setSubmitting(true);
    try {
      const scope = { form: values, state: getSnapshot() };
      let mutated = false;
      for (const binding of props.onSubmit as ActionChain) {
        const params = resolveScopedParams(binding.params, scope);
        // Every mutate in the chain carries the originating form's id: a
        // successful create clears the form, and a failure lands inline at
        // `/forms/<id>/$error` instead of the page banner.
        if (binding.action === "app.mutate" && !params.formId) {
          params.formId = props.id;
        }
        if (binding.action === "app.mutate") mutated = true;
        await execute({ ...binding, params });
        // A failed mutate resolves normally (its error lands in the form's
        // `$error` slot, not a throw) — stop the chain here, or a following
        // `app.navigate` would tear down the form that is displaying the
        // failure and later side effects would run against a failed save.
        if (binding.action === "app.mutate") {
          const failure = get(`${basePath}/$error`);
          if (typeof failure === "string" && failure !== "") return;
        }
      }
      // Positive feedback for a successful save: the form clearing itself is
      // too easy to miss. Only for chains that actually wrote data (a
      // filter/state form has nothing to announce), and only when no mutate
      // in the chain reported a failure into the `$error` slot.
      const failed = get(`${basePath}/$error`);
      if (mutated && (failed === null || failed === undefined || failed === "")) {
        toast.success(props.title ? `${props.title} — saved` : "Saved");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      data-testid="json-render-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {props.title ? <h3 className={headingClass.h3}>{props.title}</h3> : null}
      {fields.map((field) => {
        const inputId = `form-${props.id}-${field.name}`;
        const value = readField(field.name);
        const kind = field.kind ?? "string";
        return (
          <SettingsRow
            key={field.name}
            label={field.label ?? field.name}
            htmlFor={inputId}
            required={field.required}
          >
            {kind === "text" ? (
              <Textarea
                id={inputId}
                value={value === undefined || value === null ? "" : String(value)}
                placeholder={field.placeholder}
                onChange={(event) => set(`${basePath}/${field.name}`, event.target.value)}
              />
            ) : kind === "boolean" ? (
              <Switch
                id={inputId}
                checked={value === true}
                onCheckedChange={(checked) => set(`${basePath}/${field.name}`, checked)}
              />
            ) : kind === "enum" ? (
              <Select
                value={value === undefined || value === null ? "" : String(value)}
                onValueChange={(next) => set(`${basePath}/${field.name}`, next)}
              >
                <SelectTrigger id={inputId} className="w-full">
                  <SelectValue placeholder={field.placeholder ?? "Select…"} />
                </SelectTrigger>
                <SelectContent {...themeAttr}>
                  {(field.options ?? []).map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id={inputId}
                type={kind === "number" ? "number" : kind === "date" ? "date" : "text"}
                value={value === undefined || value === null ? "" : String(value)}
                placeholder={field.placeholder}
                onChange={(event) => set(`${basePath}/${field.name}`, event.target.value)}
              />
            )}
          </SettingsRow>
        );
      })}
      {validationError || submitError ? (
        <AlertCallout tone="error" icon={AlertCircle}>
          {validationError ?? submitError}
        </AlertCallout>
      ) : null}
      <div>
        <Button type="submit" disabled={submitting}>
          {submitting ? <Spinner className="size-3.5" /> : null}
          {props.submitLabel ?? "Submit"}
        </Button>
      </div>
    </form>
  );
}

// ─── Drawer ─────────────────────────────────────────────────────────────────

type DrawerComponentProps = InferComponentProps<typeof swarmCatalog, "Drawer">;
type DetailListComponentProps = InferComponentProps<typeof swarmCatalog, "DetailList">;
type CardGridComponentProps = InferComponentProps<typeof swarmCatalog, "CardGrid">;
type KanbanComponentProps = InferComponentProps<typeof swarmCatalog, "Kanban">;
type CalendarComponentProps = InferComponentProps<typeof swarmCatalog, "Calendar">;
type ContributionGraphComponentProps = InferComponentProps<
  typeof swarmCatalog,
  "ContributionGraph"
>;

/** Keep existing tablet widths as floors; grow desktop caps; phones stay full width. */
const drawerSizeClass: Record<"sm" | "md" | "lg" | "xl", string> = {
  sm: "sm:max-w-[clamp(24rem,33.333vw,40rem)]",
  md: "sm:max-w-[clamp(28rem,46vw,60rem)]",
  lg: "sm:max-w-[clamp(42rem,62vw,80rem)]",
  xl: "sm:max-w-[clamp(56rem,70vw,100rem)]",
};

/**
 * Route-driven side panel. The URL is the single source of truth: the drawer
 * is open exactly while its declared route param is set (mirrored by the app
 * runtime into `/route/params/<param>`), so a deep link renders it open and a
 * refresh keeps it open.
 *
 * Closing REPLACES the history entry — Back never re-opens a dismissed drawer,
 * and Back from an open drawer returns to whatever pushed it (the row click).
 *
 * Children mount only while open, deliberately unlike `Tabs`' warm panels: a
 * drawer is transient, and a `Table` inside it is safe to re-mount because
 * every catalog Table sizes with `columnSizing="flex"`.
 */
function DrawerComponent({
  props,
  children,
}: {
  props: DrawerComponentProps;
  children: ReactNode;
}) {
  const { state } = useStateStore();
  const [, setSearchParams] = useSearchParams();
  const themeAttr = useJsonRenderThemeAttr();

  const value = getByPath(state, `/route/params/${props.param}`);
  const open = value !== undefined && value !== null && value !== "";

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        setSearchParams(
          (prev) => {
            const params = new URLSearchParams(prev);
            params.delete(props.param);
            return params;
          },
          { replace: true },
        );
      }}
    >
      <SheetContent
        side={props.side ?? "right"}
        // Same shell as the dashboard's own detail sheets: a fixed header
        // (`pr-12` clears Radix's close button) over a scrolling body.
        className={cn(
          "flex w-full flex-col gap-0 overflow-hidden p-0",
          drawerSizeClass[props.size ?? "md"],
        )}
        data-testid="json-render-drawer"
        {...themeAttr}
      >
        <SheetHeader className="shrink-0 border-b border-border py-3 pl-4 pr-12">
          <SheetTitle className="min-w-0 truncate text-sm font-medium">
            {props.title ?? "Details"}
          </SheetTitle>
          {props.description ? (
            <SheetDescription className="text-xs">{props.description}</SheetDescription>
          ) : (
            // Radix warns (and screen readers lose context) when a dialog has
            // no description — keep an sr-only fallback when the app author
            // didn't provide one.
            <SheetDescription className="sr-only">
              {`${props.title ?? "Details"} panel`}
            </SheetDescription>
          )}
        </SheetHeader>
        <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">{children}</div>
        {props.actions && props.actions.length > 0 ? (
          <DrawerActionsFooter actions={props.actions as DrawerAction[]} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * The Drawer's sticky footer: one button per action, under the scrolling
 * body. Confirmation follows Table row actions (`confirmConfigFor`). Chains
 * run with no `$row`; `$state` reads (the open record's route param) resolve
 * against the live state.
 */
function DrawerActionsFooter({ actions }: { actions: DrawerAction[] }) {
  const runChain = useRowActionRunner();
  const [pending, setPending] = useState<number | null>(null);
  const run = (action: DrawerAction | undefined) => {
    if (action) void runChain(action.actions as ActionChain, {});
  };
  return (
    <SheetFooter className="mt-0 shrink-0 flex-row flex-wrap justify-end gap-2 border-t border-border px-4 py-3">
      {actions.map((action, index) => (
        <Button
          key={`${index}-${action.label}`}
          size="sm"
          variant={action.variant ?? "outline"}
          onClick={() => (confirmConfigFor(action) ? setPending(index) : run(action))}
        >
          <CatalogIcon name={action.icon} size="sm" />
          {action.label}
        </Button>
      ))}
      <ChainConfirmDialog
        action={pending === null ? undefined : actions[pending]}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const action = pending === null ? undefined : actions[pending];
          setPending(null);
          run(action);
        }}
      />
    </SheetFooter>
  );
}

// ─── DetailList ─────────────────────────────────────────────────────────────

/** A JSON-ish field value as a tree: objects as-is, a JSON string parsed. */
function jsonFieldData(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * One field value, rendered by kind with the same renderers as Table cells
 * (status chip, person, relative time, copy). `code` gets a monospace block;
 * `json` the collapsible `JsonViewer` tree.
 */
function DetailFieldValue({ field, value }: { field: DetailListField; value: unknown }) {
  const raw = value === null || value === undefined ? "" : String(value);
  const dash = <span className="text-muted-foreground">—</span>;
  switch (field.kind) {
    case "badge":
      return raw ? <StatusPill text={raw} tone={badgeToneFor(field.tones, raw)} /> : dash;
    case "status":
      return raw ? <StatusCell value={raw} tones={field.tones} /> : dash;
    case "user":
      return raw ? <PersonCell name={raw} /> : dash;
    case "relative":
      return raw ? <RelativeTimeCell value={value} /> : dash;
    case "copy":
      return raw ? <CopyCell value={raw} /> : dash;
    case "json":
      return value === null || value === undefined ? (
        dash
      ) : (
        <JsonViewer data={jsonFieldData(value)} />
      );
  }
  if (field.kind === "code") {
    const text =
      typeof value === "string"
        ? value
        : value === undefined || value === null
          ? ""
          : JSON.stringify(value, null, 2);
    if (!text) return <span className="text-muted-foreground">—</span>;
    return (
      <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-words">
        {text}
      </pre>
    );
  }
  const text = formatValue(field.kind, value);
  if (!text) return <span className="text-muted-foreground">—</span>;
  return <span className="break-words">{text}</span>;
}

/**
 * Read-only label/value view of ONE record — the detail-page counterpart to
 * `Table`, built on the dashboard's `DefinitionList` / `InfoRow` primitives and
 * sharing Table's kind formatting (`formatValue` / badge tones).
 */
function DetailListComponent({ props }: { props: DetailListComponentProps }) {
  const fields = (props.fields ?? []) as DetailListField[];
  const data = props.data as Record<string, unknown> | null | undefined;

  // An array means the binding forgot the trailing `/0` (a whole query result
  // instead of one record) — treat it as "no record", not as a field source.
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    // While the backing query is still loading, the record isn't missing yet —
    // sketch the declared fields instead of flashing the empty message.
    if (props.loading) {
      return (
        <div className="flex flex-col gap-3" data-testid="json-render-detail-list">
          {fields.slice(0, 6).map((field) => (
            <div key={field.key} className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-4 w-40" />
            </div>
          ))}
        </div>
      );
    }
    return (
      <p className="text-sm text-muted-foreground" data-testid="json-render-detail-list">
        {props.emptyMessage ?? "No record to show yet"}
      </p>
    );
  }

  return (
    <DefinitionList
      className={cn(props.columns === 2 && "grid grid-cols-1 gap-3 space-y-0 sm:grid-cols-2")}
      data-testid="json-render-detail-list"
    >
      {fields.map((field) => (
        <InfoRow key={field.key} label={field.label ?? field.key}>
          <DetailFieldValue field={field} value={data[field.key]} />
        </InfoRow>
      ))}
    </DefinitionList>
  );
}

// ─── Kibo data blocks (Kanban / Calendar / ContributionGraph) ───────────────

type Row = Record<string, unknown>;

/** A row date value → Date. Date-only ISO strings stay in local time. */
function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date =
    typeof value === "number"
      ? new Date(value)
      : typeof value === "string"
        ? parseISO(value)
        : value instanceof Date
          ? value
          : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

/** Runs an action chain with `$row` (and `$rowIndex` when given) bound, the same way Table row actions do. */
function useRowActionRunner() {
  const { execute } = useActions();
  const { getSnapshot } = useStateStore();
  const executeRef = useRef(execute);
  executeRef.current = execute;
  const snapshotRef = useRef(getSnapshot);
  snapshotRef.current = getSnapshot;
  return useCallback(async (chain: ActionChain | undefined, row: Row, rowIndex?: number) => {
    if (!chain) return;
    const scope = { row, rowIndex, state: snapshotRef.current() };
    for (const binding of chain) {
      await executeRef.current({ ...binding, params: resolveScopedParams(binding.params, scope) });
    }
  }, []);
}

function BlockSkeleton({ testId }: { testId: string }) {
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

interface KanbanItem {
  [key: string]: unknown;
  id: string;
  name: string;
  column: string;
  row: Row;
}

function normalizeKanbanColumns(columns: KanbanColumn[]): { id: string; name: string }[] {
  return columns.map((column) =>
    typeof column === "string"
      ? { id: column, name: column }
      : { id: column.id, name: column.label ?? column.id },
  );
}

/**
 * Kanban board over query rows. Drag state is local: a dropped card stays in
 * its new column until `onMove` settles, then the refetched rows take over.
 */
function KanbanComponent({ props }: { props: KanbanComponentProps }) {
  const runChain = useRowActionRunner();
  const idField = props.idField ?? "id";
  const { columnField, titleField } = props;
  const columns = useMemo(
    () => normalizeKanbanColumns((props.columns ?? []) as KanbanColumn[]),
    [props.columns],
  );
  const cardFields = (props.cardFields ?? []) as DetailListField[];
  const draggable = Boolean(props.onMove?.length);

  const serverItems = useMemo<KanbanItem[]>(() => {
    const rows = Array.isArray(props.data) ? (props.data as Row[]) : [];
    return rows.flatMap((row) => {
      const id = row[idField];
      if (id === null || id === undefined) return [];
      const title = row[titleField];
      return [
        {
          id: String(id),
          name: title === null || title === undefined ? "" : String(title),
          column: String(row[columnField] ?? ""),
          row,
        },
      ];
    });
  }, [props.data, idField, titleField, columnField]);

  // Moves not yet reflected by the server rows: card id → destination column.
  const [pending, setPending] = useState<Record<string, string>>({});
  const [dragItems, setDragItems] = useState<KanbanItem[] | null>(null);
  const dragRef = useRef<{ id: string; from: string } | null>(null);

  const items = useMemo(() => {
    if (dragItems) return dragItems;
    return serverItems.map((item) =>
      Object.hasOwn(pending, item.id) ? { ...item, column: pending[item.id] as string } : item,
    );
  }, [dragItems, serverItems, pending]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Kibo mutates the objects it is handed, so give it copies every render.
  const kiboData = useMemo(() => items.map((item) => ({ ...item })), [items]);

  const dragSensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor),
  );
  const noSensors = useSensors();

  if (props.loading && serverItems.length === 0) {
    return <BlockSkeleton testId="json-render-kanban" />;
  }

  const handleDragEnd = async () => {
    const drag = dragRef.current;
    dragRef.current = null;
    const moved = drag ? itemsRef.current.find((item) => item.id === drag.id) : undefined;
    setDragItems(null);
    if (!drag || !moved || moved.column === drag.from) return;
    const to = moved.column;
    setPending((current) => ({ ...current, [drag.id]: to }));
    try {
      await runChain(props.onMove as ActionChain, { ...moved.row, [columnField]: to });
    } finally {
      setPending((current) => {
        const { [drag.id]: _done, ...rest } = current;
        return rest;
      });
    }
  };

  return (
    <div className="min-w-0 overflow-x-auto" data-testid="json-render-kanban">
      <KanbanProvider
        className="min-w-max"
        columns={columns}
        data={kiboData}
        sensors={draggable ? dragSensors : noSensors}
        onDataChange={(next) => setDragItems(next as KanbanItem[])}
        onDragStart={(event) => {
          const id = String(event.active.id);
          const item = itemsRef.current.find((entry) => entry.id === id);
          dragRef.current = item ? { id, from: item.column } : null;
        }}
        onDragEnd={() => void handleDragEnd()}
        onDragCancel={() => {
          dragRef.current = null;
          setDragItems(null);
        }}
      >
        {(column) => (
          <KanbanBoard className="w-64" id={column.id} key={column.id}>
            <KanbanHeader className="flex items-center justify-between">
              <span>{column.name}</span>
              <span className="font-normal text-muted-foreground">
                {items.filter((item) => item.column === column.id).length}
              </span>
            </KanbanHeader>
            <KanbanCards<KanbanItem> id={column.id}>
              {(item) => (
                <KanbanCard
                  className={cn(!draggable && "cursor-default")}
                  column={item.column}
                  id={item.id}
                  key={item.id}
                  name={item.name}
                >
                  <div
                    className={cn("flex flex-col gap-1.5", props.onCardClick && "cursor-pointer")}
                    onClick={
                      props.onCardClick
                        ? () => void runChain(props.onCardClick as ActionChain, item.row)
                        : undefined
                    }
                  >
                    <p className="m-0 font-medium text-sm">{item.name || "Untitled"}</p>
                    {cardFields.map((field) => (
                      <div
                        className="flex items-center justify-between gap-2 text-xs"
                        key={field.key}
                      >
                        <span className="text-muted-foreground">{field.label ?? field.key}</span>
                        <DetailFieldValue field={field} value={item.row[field.key]} />
                      </div>
                    ))}
                  </div>
                </KanbanCard>
              )}
            </KanbanCards>
          </KanbanBoard>
        )}
      </KanbanProvider>
    </div>
  );
}

function CalendarMonthLabel() {
  const [month] = useCalendarMonth();
  const [year] = useCalendarYear();
  return (
    <span className="font-medium text-sm">
      {new Date(year, month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" })}
    </span>
  );
}

function CalendarBlockBody({ props }: { props: CalendarComponentProps }) {
  const runChain = useRowActionRunner();
  const idField = props.idField ?? "id";
  const { startField, endField, titleField } = props;

  const { features, rowsById } = useMemo(() => {
    const rows = Array.isArray(props.data) ? (props.data as Row[]) : [];
    const byId = new Map<string, Row>();
    const list: CalendarFeature[] = [];
    for (const [index, row] of rows.entries()) {
      const startAt = toDate(row[startField]);
      if (!startAt) continue;
      const endAt = (endField ? toDate(row[endField]) : null) ?? startAt;
      const id = String(row[idField] ?? index);
      byId.set(id, row);
      list.push({
        id,
        name: String(row[titleField] ?? ""),
        startAt,
        endAt,
        status: { id: "event", name: "event", color: "var(--primary)" },
      });
    }
    return { features: list, rowsById: byId };
  }, [props.data, idField, startField, endField, titleField]);

  if (props.loading && features.length === 0) {
    return <BlockSkeleton testId="json-render-calendar" />;
  }

  return (
    <div
      className="flex flex-col rounded-md border border-border"
      data-testid="json-render-calendar"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <CalendarMonthLabel />
        <CalendarDatePagination />
      </div>
      <CalendarHeader />
      <CalendarBody features={features}>
        {({ feature }) => {
          const row = rowsById.get(feature.id);
          return props.onSelect && row ? (
            <button
              className="w-full rounded-sm text-left hover:bg-muted"
              key={feature.id}
              onClick={() => void runChain(props.onSelect as ActionChain, row)}
              type="button"
            >
              <CalendarItem feature={feature} />
            </button>
          ) : (
            <CalendarItem feature={feature} key={feature.id} />
          );
        }}
      </CalendarBody>
    </div>
  );
}

/**
 * Month calendar. Kibo keeps the visible month in module-level jotai atoms, so
 * each block gets its own jotai store — two Calendars on one page page through
 * months independently.
 */
function CalendarComponent({ props }: { props: CalendarComponentProps }) {
  return (
    <JotaiProvider>
      <CalendarProvider>
        <CalendarBlockBody props={props} />
      </CalendarProvider>
    </JotaiProvider>
  );
}

/** Buckets rows per calendar day over the trailing window, 0–4 levels. */
function toActivities(
  rows: Row[],
  dateField: string,
  countField: string | undefined,
  days: number,
): Activity[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const date = toDate(row[dateField]);
    if (!date) continue;
    const key = format(date, "yyyy-MM-dd");
    const amount = countField ? Number(row[countField]) : 1;
    totals.set(key, (totals.get(key) ?? 0) + (Number.isFinite(amount) ? amount : 0));
  }
  const today = startOfDay(new Date());
  const window = eachDayOfInterval({ start: subDays(today, days - 1), end: today });
  const counts = window.map((day) => Math.max(0, totals.get(format(day, "yyyy-MM-dd")) ?? 0));
  const max = Math.max(0, ...counts);
  return window.map((day, index) => {
    const count = counts[index] ?? 0;
    return {
      date: format(day, "yyyy-MM-dd"),
      count,
      level: max === 0 || count === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4)),
    };
  });
}

function ContributionGraphComponent({ props }: { props: ContributionGraphComponentProps }) {
  const activities = useMemo(
    () =>
      toActivities(
        Array.isArray(props.data) ? (props.data as Row[]) : [],
        props.dateField ?? "date",
        props.countField,
        props.days ?? 365,
      ),
    [props.data, props.dateField, props.countField, props.days],
  );

  if (props.loading && !props.data?.length) {
    return <BlockSkeleton testId="json-render-contribution-graph" />;
  }

  return (
    <div className="min-w-0" data-testid="json-render-contribution-graph">
      <ContributionGraph className="text-muted-foreground" data={activities} fontSize={12}>
        <ContributionGraphCalendar>
          {({ activity, dayIndex, weekIndex }) => (
            <ContributionGraphBlock activity={activity} dayIndex={dayIndex} weekIndex={weekIndex}>
              <title>{`${activity.count} on ${activity.date}`}</title>
            </ContributionGraphBlock>
          )}
        </ContributionGraphCalendar>
        <ContributionGraphFooter>
          <ContributionGraphTotalCount />
          <ContributionGraphLegend />
        </ContributionGraphFooter>
      </ContributionGraph>
    </div>
  );
}

// ─── CardGrid ───────────────────────────────────────────────────────────────

const CARD_GRID_SKELETON_COUNT = 3;

/** `CardGrid.columns` default: wider cards than `Grid`'s, three across from `md`. */
const CARD_GRID_DEFAULT_COLUMNS: GridColumns = { base: 1, sm: 2, md: 3 };

/** One `CardGrid.fields[]` entry rendered into the `·`-joined meta line, or `null` to skip it (empty value). */
function cardGridMetaItem(field: CardGridField, value: unknown): ReactNode | null {
  if (field.kind === "badge") {
    const raw = value === null || value === undefined ? "" : cardGridCapText(String(value));
    return raw ? <StatusPill text={raw} tone={badgeToneFor(field.tones, raw)} /> : null;
  }
  const text = cardGridCapText(formatValue(cardGridFieldKind(field.kind, value), value));
  return text || null;
}

/**
 * Card image tile, rendered only when `imageKey` is set. Row data is writable
 * by any app user, so only an absolute http(s) URL becomes an `<img>` (never
 * `javascript:` / `data:`); anything else, or a load failure, shows the
 * placeholder.
 */
function CardGridImage({ value }: { value: unknown }) {
  const src = safeHttpUrl(value);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <div className="flex aspect-video w-full items-center justify-center bg-muted text-muted-foreground">
      {src && failedSrc !== src ? (
        <img
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setFailedSrc(src)}
          referrerPolicy="no-referrer"
          src={src}
        />
      ) : (
        <ImageIcon aria-hidden className="size-8" data-testid="json-render-card-grid-placeholder" />
      )}
    </div>
  );
}

/**
 * Responsive grid of data-bound cards — the visual counterpart to `Table` for
 * record browsers. Each row renders as a card with an optional image tile, a
 * title, and an unlabeled meta line built from `fields`. With `onClick` set,
 * every card is a keyboard-reachable button that runs the chain with `$row` /
 * `$rowIndex` bound. Renders `CARD_GRID_PAGE_SIZE` cards at a time behind a
 * "Show more" button so a large query never mounts thousands of cards.
 */
function CardGridComponent({ props }: { props: CardGridComponentProps }) {
  const runChain = useRowActionRunner();
  // Not reset on data changes: a bound `data` array is rebuilt on every poll,
  // and a reset would collapse the grid under the reader every few seconds.
  const [limit, setLimit] = useState(CARD_GRID_PAGE_SIZE);
  // "Show more" can unmount itself; move focus to the first new card instead
  // of letting it fall back to the page body.
  const gridRef = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  useEffect(() => {
    if (focusIndex === null) return;
    const card = gridRef.current?.children[focusIndex];
    if (card instanceof HTMLElement) card.focus();
  }, [focusIndex]);
  const rows = Array.isArray(props.data) ? (props.data as Row[]) : [];
  const fields = (props.fields ?? []) as CardGridField[];
  const onClick = props.onClick as ActionChain | undefined;
  const clickable = (onClick?.length ?? 0) > 0;
  const hasImage = Boolean(props.imageKey);
  const gridClassName = cn(
    "grid min-w-0",
    ...gridColumnClasses((props.columns as GridColumns) ?? CARD_GRID_DEFAULT_COLUMNS),
    stackGapClass.md,
  );

  if (props.error) {
    return (
      <div data-testid="json-render-card-grid">
        <AlertCallout tone="error" icon={AlertCircle} title="Query failed">
          {props.error}
        </AlertCallout>
      </div>
    );
  }

  if (props.loading && rows.length === 0) {
    return (
      <div className={gridClassName} data-testid="json-render-card-grid">
        {Array.from({ length: CARD_GRID_SKELETON_COUNT }, (_, index) => (
          <UiCard key={index} className="gap-0 overflow-hidden py-0">
            {hasImage ? <Skeleton className="aspect-video w-full rounded-none" /> : null}
            <CardContent className="flex flex-col gap-2 p-4">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </CardContent>
          </UiCard>
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="json-render-card-grid">
        {props.emptyMessage ?? "No records yet"}
      </p>
    );
  }

  const { visible, remaining } = cardGridVisibleRows(rows, limit);

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="json-render-card-grid">
      <div className={gridClassName} ref={gridRef}>
        {visible.map((row, index) => {
          const titleText = cardGridTitleText(row[props.titleKey]);
          const metaItems = fields
            .map((field, itemIndex) => ({
              key: `${itemIndex}:${field.key}`,
              node: cardGridMetaItem(field, row[field.key]),
            }))
            .filter((item): item is { key: string; node: ReactNode } => item.node !== null);
          const activate = clickable ? () => void runChain(onClick, row, index) : undefined;

          return (
            <UiCard
              key={cardGridRowKey(row, index)}
              className={cn(
                "gap-0 overflow-hidden py-0",
                clickable &&
                  "cursor-pointer outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60",
              )}
              onClick={activate}
              onKeyDown={
                activate
                  ? (event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        // Space would otherwise scroll the page.
                        event.preventDefault();
                        activate();
                      }
                    }
                  : undefined
              }
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? 0 : index === focusIndex ? -1 : undefined}
            >
              {props.imageKey ? <CardGridImage value={row[props.imageKey]} /> : null}
              <CardContent className="flex flex-col gap-1.5 p-4">
                <p
                  className="m-0 line-clamp-2 text-sm font-medium text-foreground"
                  title={titleText}
                >
                  {titleText}
                </p>
                {metaItems.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    {metaItems.map((item, itemIndex) => (
                      <span key={item.key} className="flex items-center gap-1.5">
                        {itemIndex > 0 && <span aria-hidden="true">·</span>}
                        {item.node}
                      </span>
                    ))}
                  </div>
                ) : null}
              </CardContent>
            </UiCard>
          );
        })}
      </div>
      {remaining > 0 ? (
        <Button
          className="self-center"
          onClick={() => {
            setFocusIndex(limit);
            setLimit(limit + CARD_GRID_PAGE_SIZE);
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          Show more ({remaining} remaining)
        </Button>
      ) : null}
    </div>
  );
}

// ─── Status, feedback and loaders ───────────────────────────────────────────

type BadgeComponentProps = InferComponentProps<typeof swarmCatalog, "Badge">;
type ProgressComponentProps = InferComponentProps<typeof swarmCatalog, "Progress">;
type SkeletonComponentProps = InferComponentProps<typeof swarmCatalog, "Skeleton">;
type AvatarStackComponentProps = InferComponentProps<typeof swarmCatalog, "AvatarStack">;
type SectionComponentProps = InferComponentProps<typeof swarmCatalog, "Section">;

/**
 * Badge variants. `tag` (default) keeps the original uppercase chip, except
 * that a lifecycle `status` renders the dashboard `StatusBadge`; `status` is
 * the sentence-case pill; `count` the numeric pill; `beta` the `BetaTag`.
 */
function BadgeComponent({ props }: { props: BadgeComponentProps }) {
  // Unset bindings resolve to undefined — render nothing instead of "undefined".
  const text = props.text === null || props.text === undefined ? "" : String(props.text);
  const tone = props.tone ?? "neutral";
  const status = typeof props.status === "string" && props.status ? props.status : undefined;
  switch (props.variant ?? "tag") {
    case "beta":
      return <BetaTag tooltip={props.hint ?? "Experimental"} side="top" />;
    case "count":
      return text === "" ? null : (
        <WithHint hint={props.hint}>
          <CountPill value={text} tone={tone} />
        </WithHint>
      );
    case "status": {
      const label = text || status || "";
      return label === "" ? null : (
        <WithHint hint={props.hint}>
          <SentencePill text={label} tone={tone} status={status} icon={props.icon} />
        </WithHint>
      );
    }
    default: {
      if (status && taskStatusVariant(status)) {
        return (
          <WithHint hint={props.hint}>
            <StatusBadge status={status as StatusBadgeStatus} />
          </WithHint>
        );
      }
      const label = text || status || "";
      return label === "" ? null : (
        <WithHint hint={props.hint}>
          <StatusPill text={label} tone={tone} icon={props.icon} />
        </WithHint>
      );
    }
  }
}

/** Progress bar indicator color per tone (whole class names for the scanner). */
const progressToneClass: Record<BadgeTone, string | undefined> = {
  neutral: undefined,
  success: "[&>[data-slot=progress-indicator]]:bg-status-success",
  active: "[&>[data-slot=progress-indicator]]:bg-status-active",
  error: "[&>[data-slot=progress-indicator]]:bg-status-error",
  info: "[&>[data-slot=progress-indicator]]:bg-status-info",
  pending: "[&>[data-slot=progress-indicator]]:bg-status-pending",
  warning: "[&>[data-slot=progress-indicator]]:bg-status-warning",
  paused: "[&>[data-slot=progress-indicator]]:bg-status-paused",
};

function ProgressComponent({ props }: { props: ProgressComponentProps }) {
  const max = typeof props.max === "number" && props.max > 0 ? props.max : 100;
  const raw = typeof props.value === "number" && Number.isFinite(props.value) ? props.value : 0;
  const value = Math.max(0, Math.min(max, raw));
  const percent = Math.round((value / max) * 100);
  const showValue = props.showValue !== false;

  if (props.variant === "ring") {
    return (
      <span className="inline-flex min-w-0 items-center gap-2 text-sm">
        <ProgressRing done={value} total={max} label={props.label} className="size-5 shrink-0" />
        {props.label ? <span className="truncate text-foreground">{props.label}</span> : null}
        {showValue ? (
          <span className="tabular-nums text-muted-foreground">
            {value} / {max}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {props.label || showValue ? (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="min-w-0 truncate text-muted-foreground">{props.label}</span>
          {showValue ? (
            <span className="shrink-0 tabular-nums text-muted-foreground">{percent}%</span>
          ) : null}
        </div>
      ) : null}
      <Progress
        value={percent}
        aria-label={props.label ?? `${percent}%`}
        className={cn("h-1.5", progressToneClass[props.tone ?? "neutral"])}
      />
    </div>
  );
}

/** Repeats `node` `count` times (static placeholders, so index keys are stable). */
function repeat(count: number, node: (index: number) => ReactNode): ReactNode[] {
  return Array.from({ length: count }, (_, index) => node(index));
}

function SkeletonComponent({ props }: { props: SkeletonComponentProps }) {
  const shape = props.shape ?? "line";
  const count = Math.max(
    1,
    Math.min(20, props.count ?? (shape === "rows" ? 5 : shape === "line" ? 3 : 1)),
  );
  let body: ReactNode;
  switch (shape) {
    case "block":
      body = repeat(count, (index) => (
        <Skeleton
          key={index}
          className="w-full"
          // inline-style: author-supplied pixel height
          style={{ height: props.height ?? 128 }}
        />
      ));
      break;
    case "rows":
      body = repeat(count, (index) => <Skeleton key={index} className="h-9 w-full" />);
      break;
    case "metric":
      body = (
        <div
          className={cn(
            "grid min-w-0 gap-4",
            gridColsClass[1],
            count > 1 ? gridColsSmClass[2] : undefined,
            gridColsMdClass[Math.min(count, 4)],
          )}
        >
          {repeat(count, (index) => (
            <UiCard key={index} className="py-0">
              <CardContent className="flex flex-col gap-2 p-4">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-6 w-16" />
              </CardContent>
            </UiCard>
          ))}
        </div>
      );
      break;
    case "card":
      body = repeat(count, (index) => (
        <UiCard key={index}>
          <CardHeader className="gap-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/5" />
          </CardContent>
        </UiCard>
      ));
      break;
    default:
      body = repeat(count, (index) => (
        <Skeleton
          key={index}
          className={cn("h-4", count > 1 && index === count - 1 ? "w-3/5" : "w-full")}
        />
      ));
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: <output> means a computed result; this is a loading placeholder
    <div
      role="status"
      aria-label="Loading"
      aria-busy="true"
      className={cn("flex min-w-0 flex-col", shape === "rows" ? "gap-1.5" : "gap-3")}
    >
      {body}
    </div>
  );
}

function AvatarStackComponent({ props }: { props: AvatarStackComponentProps }) {
  const users = [
    ...new Set(
      ((props.users ?? []) as unknown[]).filter(
        (user): user is string => typeof user === "string" && user.trim() !== "",
      ),
    ),
  ];
  if (users.length === 0) return null;
  const visible = users.slice(0, props.max ?? 4);
  const extra = users.length - visible.length;
  const names = users.join(", ");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <AvatarStack size={24}>
            {visible.map((name) => (
              <Avatar key={name} className="size-full">
                <AvatarFallback className="text-[10px] font-medium">
                  {userInitials(name)}
                </AvatarFallback>
              </Avatar>
            ))}
          </AvatarStack>
          {extra > 0 ? <span className="tabular-nums">+{extra}</span> : null}
          <span className="sr-only">{names}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{names}</TooltipContent>
    </Tooltip>
  );
}

function SectionComponent({
  props,
  children,
}: {
  props: SectionComponentProps;
  children: ReactNode;
}) {
  const description = props.description ? (
    <p className="text-sm text-muted-foreground">{props.description}</p>
  ) : null;
  if (props.collapsible) {
    return (
      <CollapsibleSection title={props.title} defaultOpen={props.defaultOpen ?? true} heading="h3">
        <div className="flex min-w-0 flex-col gap-3 pt-1">
          {description}
          {children}
        </div>
      </CollapsibleSection>
    );
  }
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className={headingClass.h3}>{props.title}</h3>
        {description}
      </div>
      {children}
    </section>
  );
}

// ─── Component registry ─────────────────────────────────────────────────────

const iconToneClass: Record<
  "default" | "muted" | "success" | "warning" | "error" | "info",
  string
> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  success: "text-status-success-strong",
  warning: "text-status-warning-strong",
  error: "text-status-error-strong",
  info: "text-status-info-strong",
};

export const swarmComponents: Components<typeof swarmCatalog> = {
  Drawer: ({ props, children }) => <DrawerComponent props={props}>{children}</DrawerComponent>,
  DetailList: ({ props }) => <DetailListComponent props={props} />,
  CardGrid: ({ props }) => <CardGridComponent props={props} />,
  Stack: ({ props, children }) => <StackComponent props={props}>{children}</StackComponent>,
  Grid: ({ props, children }) => <GridComponent props={props}>{children}</GridComponent>,
  Split: ({ props, children }) => <SplitComponent props={props}>{children}</SplitComponent>,
  Divider: ({ props }) => <DividerComponent props={props} />,
  Tabs: ({ props, children }) => <TabsComponent props={props}>{children}</TabsComponent>,
  SearchInput: ({ props }) => <SearchInputComponent props={props} />,
  Select: ({ props }) => <SelectFilterComponent props={props} />,
  NumberInput: ({ props }) => <NumberInputComponent props={props} />,
  Markdown: ({ props }) => (
    <div className="prose-doc min-w-0 text-foreground">
      <Streamdown>{props.content}</Streamdown>
    </div>
  ),
  Container: ({ props, children }) => {
    const direction = props.direction ?? "column";
    const gap = props.gap ?? "md";
    return (
      <div className={`flex ${direction === "row" ? "flex-row" : "flex-col"} ${gapClass[gap]}`}>
        {children}
      </div>
    );
  },
  Card: ({ props, children }) => (
    <UiCard>
      {(props.title || props.description) && (
        <CardHeader>
          {props.title && <CardTitle>{props.title}</CardTitle>}
          {props.description && <CardDescription>{props.description}</CardDescription>}
        </CardHeader>
      )}
      <CardContent>{children}</CardContent>
    </UiCard>
  ),
  Heading: ({ props }) => {
    const level = props.level ?? "h2";
    if (level === "h1") return <h1 className={headingClass.h1}>{props.text}</h1>;
    if (level === "h3") return <h3 className={headingClass.h3}>{props.text}</h3>;
    return <h2 className={headingClass.h2}>{props.text}</h2>;
  },
  Text: ({ props }) => (
    <p
      className={
        props.tone === "muted" ? "text-sm text-muted-foreground" : "text-sm text-foreground"
      }
    >
      {props.content}
    </p>
  ),
  Button: ({ props, emit }) => <ActionButtonComponent props={props} emit={emit} />,
  Metric: ({ props }) => <MetricComponent props={props} />,
  Alert: ({ props, emit }) => {
    const tone = alertTone[props.tone ?? "info"];
    return (
      <AlertCallout
        tone={tone.tone}
        icon={catalogIcon(props.icon) ?? tone.icon}
        title={props.title}
        action={
          props.actionLabel ? (
            <Button type="button" size="xs" variant="outline" onClick={() => emit("press")}>
              {props.actionLabel}
            </Button>
          ) : undefined
        }
      >
        {props.message}
      </AlertCallout>
    );
  },
  Badge: ({ props }) => <BadgeComponent props={props} />,
  Progress: ({ props }) => <ProgressComponent props={props} />,
  EmptyState: ({ props, emit }) => (
    <EmptyState
      icon={catalogIcon(props.icon) ?? Inbox}
      title={props.title}
      description={props.body}
      action={
        props.actionLabel ? (
          <Button type="button" size="sm" onClick={() => emit("press")}>
            {props.actionLabel}
          </Button>
        ) : undefined
      }
    />
  ),
  CopyButton: ({ props }) => {
    const value = props.value === null || props.value === undefined ? "" : String(props.value);
    if (value === "") return null;
    return props.label ? (
      <CopyValueButton value={value} variant="outline">
        {props.label}
      </CopyValueButton>
    ) : (
      <CopyValueButton value={value} label="Copy value" size="icon-sm" />
    );
  },
  Kbd: ({ props }) => (
    <span className="inline-flex items-center gap-1">
      {((props.keys ?? []) as string[]).map((key, index) => (
        <Kbd key={`${index}-${key}`}>{key}</Kbd>
      ))}
    </span>
  ),
  Skeleton: ({ props }) => <SkeletonComponent props={props} />,
  Spinner: ({ props }) => (
    // biome-ignore lint/a11y/useSemanticElements: <output> means a computed result; this is a busy indicator
    <span role="status" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner
        aria-hidden
        variant={props.variant}
        className={props.size === "md" ? "size-6" : "size-4"}
      />
      {props.label ? <span>{props.label}</span> : <span className="sr-only">Loading</span>}
    </span>
  ),
  AvatarStack: ({ props }) => <AvatarStackComponent props={props} />,
  Section: ({ props, children }) => <SectionComponent props={props}>{children}</SectionComponent>,
  Chips: ({ props }) => <ChipsComponent props={props} />,
  Icon: ({ props }) => (
    <CatalogIcon
      name={props.name}
      size={props.size ?? "md"}
      label={props.label}
      className={iconToneClass[props.tone ?? "default"]}
    />
  ),
  Table: ({ props }) => <TableComponent props={props} />,
  Form: ({ props }) => <FormComponent props={props} />,
  Kanban: ({ props }) => <KanbanComponent props={props} />,
  Calendar: ({ props }) => <CalendarComponent props={props} />,
  ContributionGraph: ({ props }) => <ContributionGraphComponent props={props} />,
  Tree: ({ props }) => <TreeComponent props={props} />,
};
