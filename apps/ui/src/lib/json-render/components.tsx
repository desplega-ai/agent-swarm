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

import { getByPath, type InferComponentProps } from "@json-render/core";
import type { Components } from "@json-render/react";
import { useActions, useStateStore } from "@json-render/react";
import type {
  CellKeyDownEvent,
  ColDef,
  FullWidthCellKeyDownEvent,
  ICellRendererParams,
} from "ag-grid-community";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle,
  Info,
  Loader2,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { Children, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Streamdown } from "streamdown";
import { DataGrid } from "@/components/shared/data-grid";
import { SearchBox } from "@/components/shared/search-box";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Card as UiCard,
} from "@/components/ui/card";
import { DefinitionList, InfoRow } from "@/components/ui/info-row";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { cn, formatSmartTime } from "@/lib/utils";
import { resolveScopedParams } from "./action-params";
import type {
  ActionChain,
  BadgeTone,
  DetailListField,
  FormField,
  GridColumns,
  SelectOption,
  SpacingToken,
  swarmCatalog,
  TableColumn,
  TableFilters,
  TableRowAction,
  TableRowActionConfirm,
  TabsTab,
} from "./catalog";
import { useJsonRenderThemeAttr } from "./theme-scope";

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

function StatusPill({ text, tone }: { text: string; tone: BadgeTone }) {
  return (
    <Badge variant="outline" size="tag" className="gap-1.5">
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", badgeToneDot[tone])} />
      <span className={badgeToneText[tone]}>{text}</span>
    </Badge>
  );
}

// ─── Shared value formatting (Table cells + DetailList fields) ──────────────

/** Every rendering kind a `Table` column or a `DetailList` field can declare. */
type ValueKind = NonNullable<TableColumn["kind"] | DetailListField["kind"]>;

/**
 * One value → its display text, by declared kind. Shared by `Table`'s cell
 * renderer and `DetailList` so the two surfaces never drift on dates
 * (relative time) or booleans (yes / no).
 */
function formatValue(kind: ValueKind | undefined, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (kind === "date") {
    const text = String(value);
    return Number.isNaN(Date.parse(text)) ? text : formatSmartTime(text);
  }
  if (kind === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

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

/** `collapseBelow` → the breakpoint the row un-stacks at (full class names). */
const stackRowFromClass: Record<"sm" | "md" | "lg", string> = {
  sm: "sm:flex-row",
  md: "md:flex-row",
  lg: "lg:flex-row",
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

function GridComponent({ props, children }: { props: GridProps; children: ReactNode }) {
  const columns = props.columns as GridColumns;
  const single = clampColumns(columns);
  // A bare count is responsive shorthand — 1 column on phones, 2 from `sm`,
  // the declared count from `md` — and the object form falls back to the
  // "cards reflow" default so a sparse `{ lg: 4 }` still stacks on a phone.
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

  return (
    <div
      className={cn(
        "grid min-w-0",
        gridColsClass[perBreakpoint.base],
        perBreakpoint.sm ? gridColsSmClass[perBreakpoint.sm] : undefined,
        perBreakpoint.md ? gridColsMdClass[perBreakpoint.md] : undefined,
        perBreakpoint.lg ? gridColsLgClass[perBreakpoint.lg] : undefined,
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
      )}
    >
      <div
        className={cn(
          "flex min-w-0 flex-col",
          gap,
          splitSpanClass[breakpoint][firstSpan],
          reverse ? cn("order-2", splitOrderResetClass[breakpoint]) : undefined,
        )}
      >
        {panes[0] ?? null}
      </div>
      <div
        className={cn(
          "flex min-w-0 flex-col",
          gap,
          splitSpanClass[breakpoint][secondSpan],
          reverse ? cn("order-1", splitOrderResetClass[breakpoint]) : undefined,
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
            {tab.label ?? tab.key}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab, index) => {
        const isActive = tab.key === active;
        // Extra children past the tab count join the last panel rather than
        // vanishing silently.
        const body = index === tabs.length - 1 ? panels.slice(index) : (panels[index] ?? null);
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
            {body}
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

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {props.label ? <Label htmlFor={inputId}>{props.label}</Label> : null}
      <SearchBox
        id={inputId}
        value={text}
        onChange={setText}
        ariaLabel={props.label ?? props.placeholder ?? "Search"}
        placeholder={props.placeholder ?? "Search…"}
        clearable
      />
    </div>
  );
}

function normalizeSelectOptions(options: SelectOption[]): { value: string; label: string }[] {
  const seen = new Set<string>();
  const normalized: { value: string; label: string }[] = [];
  for (const option of options) {
    const value = typeof option === "string" ? option : option.value;
    // Radix reserves the empty string for "no selection".
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push({
      value,
      label: (typeof option === "string" ? undefined : option.label) ?? value,
    });
  }
  return normalized;
}

function SelectFilterComponent({ props }: { props: SelectFilterProps }) {
  const { state, get, set } = useStateStore();
  const themeAttr = useJsonRenderThemeAttr();
  const path = `/ui/${props.id}/value`;
  const triggerId = `ui-${props.id}`;
  const options = normalizeSelectOptions((props.options ?? []) as SelectOption[]);
  const clearable = props.clearable ?? true;

  const stored = getByPath(state, path);
  const value = typeof stored === "string" ? stored : "";

  // Seed `/ui/<id>/value` so a bound `filters` entry resolves to `null`
  // (= filter disabled) instead of `undefined` before the first interaction.
  const getRef = useRef(get);
  getRef.current = get;
  const setRef = useRef(set);
  setRef.current = set;
  useEffect(() => {
    if (getRef.current(path) === undefined) setRef.current(path, null);
  }, [path]);

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
            // A standalone Select (no `label`) has no accessible name — fall
            // back to the placeholder, mirroring `SearchBox`'s ariaLabel chain.
            aria-label={props.label ? undefined : (props.placeholder ?? "Select an option")}
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
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {clearable && value ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Clear ${props.label ?? "selection"}`}
            className="absolute right-7 top-1/2 size-7 -translate-y-1/2 text-muted-foreground"
            onClick={() => set(path, null)}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </div>
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
function chainDeletesRows(rowAction: TableRowAction): boolean {
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
function confirmConfigFor(rowAction: TableRowAction): TableRowActionConfirm | null {
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
      return 85;
    case "number":
      return 95;
    case "badge":
    case "enum":
      return 105;
    case "date":
      return 110;
    default:
      return 130;
  }
}

/**
 * Stretch weight. Prose columns claim twice the leftover width of a badge /
 * date / yes-no column, which is where the reading happens.
 */
function flexForKind(kind: TableColumn["kind"]): number {
  return kind === undefined || kind === "text" || kind === "string" ? 2 : 1;
}

/** Roughly `sm` button metrics: 24px of label padding + ~7px per character. */
function rowActionButtonWidth(label: string): number {
  return Math.max(56, Math.round(label.trim().length * 7 + 24));
}

/** Cell padding + every button at its natural width + the 6px gaps between them. */
function rowActionsColumnWidth(rowActions: TableRowAction[]): number {
  const buttons = rowActions.reduce(
    (total, rowAction) => total + rowActionButtonWidth(rowAction.label),
    0,
  );
  return 28 + buttons + 6 * Math.max(0, rowActions.length - 1);
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

/** `null` / `""` / `undefined` mean "this filter is off". */
function isFilterActive(value: unknown): boolean {
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

/** Per-column equality; strings compare case-insensitively (enum/tag columns). */
function rowMatchesFilters(
  row: Record<string, unknown>,
  filters: NonNullable<TableFilters>,
): boolean {
  for (const [key, filter] of Object.entries(filters)) {
    if (!isFilterActive(filter)) continue;
    const cell = row[key];
    if (typeof filter === "boolean") {
      if (toFilterBoolean(cell) !== filter) return false;
    } else if (typeof filter === "number") {
      if (cell === null || cell === undefined || Number(cell) !== filter) return false;
    } else if (String(cell ?? "").toLowerCase() !== String(filter).toLowerCase()) {
      return false;
    }
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

  const runRowAction = useCallback(
    async (rowActionIndex: number, row: Record<string, unknown>, index: number) => {
      const rowAction = propsRef.current.rowActions?.[rowActionIndex] as TableRowAction | undefined;
      if (!rowAction) return;
      const scope = { row, rowIndex: index, state: snapshotRef.current() };
      for (const binding of rowAction.actions) {
        await executeRef.current({
          ...binding,
          params: resolveScopedParams(binding.params, scope),
        });
      }
    },
    [],
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
      if (!("column" in event) || event.column.getColId() !== "__rowActions") return;
      const browserEvent = event.event as KeyboardEvent | undefined;
      if (!browserEvent || browserEvent.key !== "Enter") return;
      const target = browserEvent.target as HTMLElement | null;
      // Only when the CELL itself is focused — a button inside the cell
      // handles its own Enter as a click.
      if (!target || !target.classList.contains("ag-cell")) return;
      target.querySelector<HTMLButtonElement>("button")?.focus();
    },
    [],
  );

  const columns = (props.columns ?? []) as TableColumn[];
  const rowActions = (props.rowActions ?? []) as TableRowAction[];
  const allRows = Array.isArray(props.data) ? (props.data as Record<string, unknown>[]) : [];

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

  const builtColumnDefs: ColDef<Record<string, unknown>>[] = columns.map((column) => ({
    headerName: column.label ?? column.key,
    field: column.key,
    // Explicit `width` pins a column; everything else stretches (`flex: 1`) from
    // a kind-appropriate floor. Never `sizeColumnsToFit` here — see the
    // `columnSizing="flex"` note on `DataGrid`.
    width: column.width,
    flex: column.width ? undefined : flexForKind(column.kind),
    minWidth: column.width ? undefined : minWidthForKind(column.kind),
    // Pinned columns survive horizontal scroll (id on the left, status on the
    // right) — the mobile answer for wide tables.
    pinned: column.pinned,
    // AG Grid's cell-data-type inference turns a boolean column into a disabled
    // checkbox renderer, which contradicts the documented `formatCell` contract
    // (yes / no text) and reads as a broken toggle. Opt every app column out of
    // inference and let the value formatter own the rendering.
    cellDataType: false,
    valueFormatter:
      column.kind === "badge" ? undefined : (params) => formatValue(column.kind, params.value),
    cellRenderer:
      column.kind === "badge"
        ? (params: ICellRendererParams<Record<string, unknown>>) => {
            const raw =
              params.value === null || params.value === undefined ? "" : String(params.value);
            if (!raw) return null;
            return <StatusPill text={raw} tone={badgeToneFor(column.tones, raw)} />;
          }
        : // AG Grid drops a plain value straight into the cell, which is a flex
          // row — the text becomes an anonymous flex item, and `text-overflow`
          // never applies to one, so long titles hard-clip mid-word. Wrapping
          // the value in a real element gives the ellipsis something to bite on
          // (and a native tooltip carrying the full text).
          (params: ICellRendererParams<Record<string, unknown>>) => {
            const text = params.valueFormatted ?? formatValue(column.kind, params.value);
            if (!text) return null;
            return (
              <span className="block w-full truncate" title={text}>
                {text}
              </span>
            );
          },
  }));

  if (rowActions.length > 0) {
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
      cellRenderer: (params: ICellRendererParams<Record<string, unknown>>) => (
        <div className="flex items-center gap-1.5">
          {rowActions.map((rowAction, rowActionIndex) => (
            <Button
              key={rowAction.label}
              size="sm"
              variant={rowAction.variant ?? "outline"}
              onClick={(event) => {
                event.stopPropagation();
                requestRowAction(
                  rowActionIndex,
                  (params.data ?? {}) as Record<string, unknown>,
                  params.node.rowIndex ?? 0,
                );
              }}
            >
              {rowAction.label}
            </Button>
          ))}
        </div>
      ),
    });
  }

  const columnDefs = useStableBySignature(builtColumnDefs, JSON.stringify([columns, rowActions]));
  const hugsContent = rows.length <= AUTO_HEIGHT_MAX_ROWS;
  // Endless-scroll guard: unless the author decided, big row sets paginate.
  const paginated = props.pagination ?? rows.length > 200;

  const confirmingAction = pendingRowAction
    ? rowActions[pendingRowAction.rowActionIndex]
    : undefined;
  const confirmCopy = confirmingAction ? confirmConfigFor(confirmingAction) : null;
  const confirmIsDestructive = DESTRUCTIVE_VARIANTS.has(confirmingAction?.variant ?? "outline");

  return (
    // `min-w-0` lets the grid shrink below its column total inside flex/grid
    // parents so AG Grid owns the horizontal scroll instead of the card clipping it.
    <div className="flex min-w-0 flex-col gap-2" data-testid="json-render-table">
      {props.error ? (
        <AlertCallout tone="error" icon={AlertCircle} title="Query failed">
          {props.error}
        </AlertCallout>
      ) : null}
      <DataGrid
        rowData={rows}
        columnDefs={columnDefs}
        loading={props.loading ?? false}
        emptyMessage={emptyMessage}
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
        cellFocus={rowActions.length > 0}
        onCellKeyDown={rowActions.length > 0 ? onCellKeyDown : undefined}
      />
      <AlertDialog
        open={pendingRowAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRowAction(null);
        }}
      >
        <AlertDialogContent {...themeAttr}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmCopy?.title ?? `${confirmingAction?.label ?? "Confirm"}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmCopy?.description ?? "This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={confirmIsDestructive ? "destructive" : "default"}
              onClick={() => {
                const pending = pendingRowAction;
                setPendingRowAction(null);
                if (pending) {
                  void runRowAction(pending.rowActionIndex, pending.row, pending.rowIndex);
                }
              }}
            >
              {confirmCopy?.confirmLabel ?? confirmingAction?.label ?? "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
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
  const busy = busySlot !== null && getByPath(state, `${busySlot}/status`) === "running";
  return (
    <Button
      variant={props.variant ?? "default"}
      disabled={props.disabled === true || busy}
      onClick={() => emit("press")}
    >
      {props.label}
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <ArrowRight className="h-3.5 w-3.5" />
      )}
    </Button>
  );
}

/**
 * Label/value stat tile, sized to `StatPanel`'s value type (text-lg/600) so an
 * app metric strip matches the native stat cards. A bound value is undefined
 * while its query loads — `loading` turns that window into a skeleton, and a
 * genuinely absent value renders an em dash, never the string "undefined".
 */
function MetricComponent({ props }: { props: MetricComponentProps }) {
  const value = props.value as unknown;
  const empty = value === undefined || value === null || value === "";
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{props.label}</span>
      {props.loading && empty ? (
        <Skeleton className="h-7 w-16" />
      ) : (
        <span className="text-lg font-semibold text-foreground">{empty ? "—" : String(value)}</span>
      )}
    </div>
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
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {props.submitLabel ?? "Submit"}
        </Button>
      </div>
    </form>
  );
}

// ─── Drawer ─────────────────────────────────────────────────────────────────

type DrawerComponentProps = InferComponentProps<typeof swarmCatalog, "Drawer">;
type DetailListComponentProps = InferComponentProps<typeof swarmCatalog, "DetailList">;

/** Panel width per `size`, on top of `SheetContent`'s `w-3/4` base. */
const drawerSizeClass: Record<"sm" | "md" | "lg" | "xl", string> = {
  sm: "sm:max-w-sm",
  md: "sm:max-w-md",
  lg: "sm:max-w-2xl",
  xl: "sm:max-w-4xl",
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
      </SheetContent>
    </Sheet>
  );
}

// ─── DetailList ─────────────────────────────────────────────────────────────

/** One field value, rendered by kind. `code` gets a monospace block. */
function DetailFieldValue({ field, value }: { field: DetailListField; value: unknown }) {
  if (field.kind === "badge") {
    const raw = value === null || value === undefined ? "" : String(value);
    if (!raw) return <span className="text-muted-foreground">—</span>;
    return <StatusPill text={raw} tone={badgeToneFor(field.tones, raw)} />;
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

// ─── Component registry ─────────────────────────────────────────────────────

export const swarmComponents: Components<typeof swarmCatalog> = {
  Drawer: ({ props, children }) => <DrawerComponent props={props}>{children}</DrawerComponent>,
  DetailList: ({ props }) => <DetailListComponent props={props} />,
  Stack: ({ props, children }) => <StackComponent props={props}>{children}</StackComponent>,
  Grid: ({ props, children }) => <GridComponent props={props}>{children}</GridComponent>,
  Split: ({ props, children }) => <SplitComponent props={props}>{children}</SplitComponent>,
  Divider: ({ props }) => <DividerComponent props={props} />,
  Tabs: ({ props, children }) => <TabsComponent props={props}>{children}</TabsComponent>,
  SearchInput: ({ props }) => <SearchInputComponent props={props} />,
  Select: ({ props }) => <SelectFilterComponent props={props} />,
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
  Alert: ({ props }) => {
    const tone = alertTone[props.tone ?? "info"];
    return (
      <AlertCallout tone={tone.tone} icon={tone.icon} title={props.title}>
        {props.message}
      </AlertCallout>
    );
  },
  Badge: ({ props }) => {
    // Unset bindings resolve to undefined — render nothing instead of "undefined".
    const text = props.text === null || props.text === undefined ? "" : String(props.text);
    return text === "" ? null : <StatusPill text={text} tone={props.tone ?? "neutral"} />;
  },
  Table: ({ props }) => <TableComponent props={props} />,
  Form: ({ props }) => <FormComponent props={props} />,
};
