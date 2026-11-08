/**
 * A task's rich card (`task.uiSpec`): the json-render chat catalog spec,
 * rendered under the prose answer with the dashboard's own primitives.
 * Not `@json-render/react`: the chat catalog is 12 small components, and the
 * stored spec was already validated server-side.
 *
 * - Every URL passes `safeHttpUrl`; an unsafe one drops the link or image.
 * - A Button renders only when `uiSpec.actions` declares its id. A click
 *   POSTs the task ui-action route, which runs the action once.
 * - An unknown type, a missing element, or a render error shows
 *   `uiSpec.fallbackText` as prose instead of a partial card.
 */

import { Component, type ReactNode, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";
import { api } from "@/api/client";
import type { AgentTask } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { safeHttpUrl } from "@/lib/json-render/card-grid-model";
import { distinctSeriesColor, toPieSlices } from "@/lib/json-render/chart-model";
import { rechartsTooltipStyle } from "@/lib/recharts-tooltip-style";
import { cn } from "@/lib/utils";
import {
  type TaskUiSpec,
  UI_SPEC_COMPONENTS,
  type UiSpecComponent,
} from "../../../../../src/utils/task-ui-spec";

type SpecElement = { type: string; props: Record<string, unknown>; children: string[] };
type Elements = Record<string, unknown>;

const KNOWN_TYPES: ReadonlySet<string> = new Set(UI_SPEC_COMPONENTS);
const AXIS_TICK = { fontSize: 10, fill: "var(--color-muted-foreground)" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readElement(elements: Elements, id: string): SpecElement | null {
  const raw = elements[id];
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  return {
    type: raw.type,
    props: isRecord(raw.props) ? raw.props : {},
    children: Array.isArray(raw.children)
      ? raw.children.filter((c): c is string => typeof c === "string")
      : [],
  };
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value.toLocaleString();
  return "";
}

/**
 * True when every element reachable from the root exists and has a catalog
 * type, and the root is a Card. A cycle counts as invalid.
 */
export function isRenderableUiSpec(uiSpec: TaskUiSpec): boolean {
  const { root, elements } = uiSpec.spec;
  if (readElement(elements, root)?.type !== "Card") return false;
  const seen = new Set<string>();
  const walk = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const el = readElement(elements, id);
    if (!el || !KNOWN_TYPES.has(el.type)) return false;
    return el.children.every(walk);
  };
  return walk(root);
}

type RenderCtx = { taskId: string; elements: Elements; actions: TaskUiSpec["actions"] };

function renderChildren(el: SpecElement, ctx: RenderCtx): ReactNode[] {
  return el.children.map((id) => <UiSpecNode key={id} id={id} ctx={ctx} />);
}

function UiSpecNode({ id, ctx }: { id: string; ctx: RenderCtx }) {
  const el = readElement(ctx.elements, id);
  if (!el) throw new Error(`uiSpec element ${id} is missing`);
  return renderUiSpecElement(el.type as UiSpecComponent, el, ctx);
}

/** One case per name in `UI_SPEC_COMPONENTS`; an unknown name throws to the fallback. */
export function renderUiSpecElement(
  type: UiSpecComponent,
  el: SpecElement,
  ctx: RenderCtx,
): ReactNode {
  const p = el.props;
  switch (type) {
    case "Card": {
      const imageUrl = safeHttpUrl(p.imageUrl);
      const title = text(p.title);
      const subtitle = text(p.subtitle);
      return (
        <Card data-slot="ui-spec-card" className="gap-4 py-4 shadow-none">
          {title || subtitle ? (
            <CardHeader className="px-4">
              {title ? <CardTitle>{title}</CardTitle> : null}
              {subtitle ? <CardDescription>{subtitle}</CardDescription> : null}
            </CardHeader>
          ) : null}
          {imageUrl ? (
            <img src={imageUrl} alt={title} className="max-h-64 w-full object-cover" />
          ) : null}
          <CardContent className="flex flex-col gap-4 px-4">{renderChildren(el, ctx)}</CardContent>
        </Card>
      );
    }
    case "Section":
      return <div className="flex flex-col gap-3">{renderChildren(el, ctx)}</div>;
    case "Text": {
      const style = p.style;
      return (
        <p
          className={cn(
            "text-sm leading-relaxed break-words",
            style === "bold" && "font-semibold",
            style === "muted" ? "text-muted-foreground" : "text-foreground/85",
          )}
        >
          {text(p.content)}
        </p>
      );
    }
    case "Fields":
      return (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          {renderChildren(el, ctx)}
        </dl>
      );
    case "Field":
      return (
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">{text(p.label)}</dt>
          <dd className="text-sm font-medium tabular-nums break-words">{text(p.value)}</dd>
        </div>
      );
    case "Table":
      return <UiSpecTable props={p} />;
    case "Chart":
      return <UiSpecChart props={p} />;
    case "Divider":
      return <Separator />;
    case "Image": {
      const url = safeHttpUrl(p.url);
      if (!url) return null;
      return <img src={url} alt={text(p.alt)} className="max-h-80 max-w-full rounded-md" />;
    }
    case "Actions":
      return <div className="flex flex-wrap gap-2">{renderChildren(el, ctx)}</div>;
    case "Button": {
      const actionId = text(p.id);
      if (!actionId || !ctx.actions || !Object.hasOwn(ctx.actions, actionId)) return null;
      return (
        <UiSpecActionButton
          taskId={ctx.taskId}
          actionId={actionId}
          label={text(p.label)}
          variant={
            p.style === "primary" ? "default" : p.style === "danger" ? "destructive" : "outline"
          }
        />
      );
    }
    case "LinkButton": {
      const url = safeHttpUrl(p.url);
      if (!url) return null;
      return (
        <Button asChild size="sm" variant="outline">
          <a href={url} target="_blank" rel="noopener noreferrer">
            {text(p.label)}
          </a>
        </Button>
      );
    }
    default: {
      const unknownType: never = type;
      throw new Error(`Unknown uiSpec component ${String(unknownType)}`);
    }
  }
}

/** A declared card action. One click runs it; the server refuses a second run. */
function UiSpecActionButton({
  taskId,
  actionId,
  label,
  variant,
}: {
  taskId: string;
  actionId: string;
  label: string;
  variant: "default" | "destructive" | "outline";
}) {
  const navigate = useNavigate();
  const [state, setState] = useState<"idle" | "running" | "done">("idle");
  const run = async () => {
    setState("running");
    try {
      const result = await api.runTaskUiAction(taskId, actionId);
      toast.success(
        result.status === "started" ? "Follow-up started." : "This button already ran.",
        result.status === "started"
          ? {
              action: { label: "Open", onClick: () => navigate(`/tasks/${result.taskId}`) },
              // The task sheet disables pointer events outside its modal.
              actionButtonStyle: { pointerEvents: "auto" },
            }
          : undefined,
      );
      setState("done");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setState("idle");
    }
  };
  return (
    <Button
      size="sm"
      variant={variant}
      disabled={state !== "idle"}
      data-slot="ui-spec-action"
      onClick={() => void run()}
    >
      {label}
    </Button>
  );
}

function UiSpecTable({ props }: { props: Record<string, unknown> }) {
  const headers = Array.isArray(props.headers) ? props.headers.map(text) : [];
  const rows = Array.isArray(props.rows)
    ? props.rows.filter(Array.isArray).map((row) => row.map(text))
    : [];
  const align = Array.isArray(props.align) ? props.align : [];
  const alignClass = (i: number) =>
    align[i] === "right" ? "text-right" : align[i] === "center" ? "text-center" : "text-left";
  const caption = text(props.caption);
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {headers.map((h, i) => (
              <TableHead key={i} className={alignClass(i)}>
                {h}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, r) => (
            <TableRow key={r}>
              {headers.map((_, c) => (
                <TableCell key={c} className={cn("tabular-nums", alignClass(c))}>
                  {row[c] ?? ""}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
        {caption ? <TableCaption className="mb-2">{caption}</TableCaption> : null}
      </Table>
    </div>
  );
}

function UiSpecChart({ props }: { props: Record<string, unknown> }) {
  const title = text(props.title);
  const chart = isRecord(props.chart) ? props.chart : {};
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-xs font-medium text-muted-foreground">{title}</figcaption>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {chart.type === "pie" ? pieChart(chart) : seriesChart(chart)}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

/** Pie segments → slices with a distinct color each (zero and negative values draw nothing). */
export function uiSpecPieSlices(chart: Record<string, unknown>) {
  const segments = (Array.isArray(chart.segments) ? chart.segments : []).filter(isRecord);
  return toPieSlices(segments, "label", "value");
}

function pieChart(chart: Record<string, unknown>) {
  const slices = uiSpecPieSlices(chart);
  return (
    <PieChart>
      <Tooltip contentStyle={rechartsTooltipStyle} />
      <Legend wrapperStyle={{ fontSize: 11 }} />
      <Pie
        data={slices}
        dataKey="value"
        nameKey="label"
        outerRadius="80%"
        isAnimationActive={false}
      >
        {slices.map((s, i) => (
          <Cell key={s.label + i} fill={s.color} />
        ))}
      </Pie>
    </PieChart>
  );
}

function seriesChart(chart: Record<string, unknown>) {
  const categories = Array.isArray(chart.categories) ? chart.categories.map(text) : [];
  const series = (Array.isArray(chart.series) ? chart.series : []).filter(isRecord).map((s) => ({
    name: text(s.name),
    values: Array.isArray(s.values) ? s.values : [],
  }));
  // recharts wants one row per category: `{ category, s0, s1, ... }`.
  const data = categories.map((category, i) => {
    const row: Record<string, string | number | null> = { category };
    series.forEach((s, j) => {
      const v = s.values[i];
      row[`s${j}`] = typeof v === "number" ? v : null;
    });
    return row;
  });
  const axes = [
    <CartesianGrid key="grid" strokeDasharray="3 3" stroke="var(--color-border)" />,
    <XAxis key="x" dataKey="category" tick={AXIS_TICK} />,
    <YAxis key="y" tick={AXIS_TICK} width={40} />,
    <Tooltip key="tip" contentStyle={rechartsTooltipStyle} />,
    series.length > 1 ? <Legend key="legend" wrapperStyle={{ fontSize: 11 }} /> : null,
  ];
  if (chart.type === "bar") {
    return (
      <BarChart data={data}>
        {axes}
        {series.map((s, j) => (
          <Bar
            key={j}
            dataKey={`s${j}`}
            name={s.name}
            fill={distinctSeriesColor(j)}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    );
  }
  if (chart.type === "area") {
    return (
      <AreaChart data={data}>
        {axes}
        {series.map((s, j) => (
          <Area
            key={j}
            dataKey={`s${j}`}
            name={s.name}
            stroke={distinctSeriesColor(j)}
            fill={distinctSeriesColor(j)}
            fillOpacity={0.2}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    );
  }
  return (
    <LineChart data={data}>
      {axes}
      {series.map((s, j) => (
        <Line
          key={j}
          dataKey={`s${j}`}
          name={s.name}
          stroke={distinctSeriesColor(j)}
          dot={false}
          isAnimationActive={false}
        />
      ))}
    </LineChart>
  );
}

/** The fallback text, in the outcome's prose style. */
function UiSpecFallback({ text: fallback }: { text: string }) {
  if (!fallback.trim()) return null;
  return (
    <p
      data-slot="ui-spec-fallback"
      className="text-sm leading-relaxed text-foreground/85 whitespace-pre-wrap break-words"
    >
      {fallback.trim()}
    </p>
  );
}

class UiSpecBoundary extends Component<
  { fallbackText: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return <UiSpecFallback text={this.props.fallbackText} />;
    return this.props.children;
  }
}

export function TaskUiSpecView({ task }: { task: Pick<AgentTask, "id" | "uiSpec"> }) {
  const uiSpec = task.uiSpec;
  if (!uiSpec) return null;
  const fallbackText = uiSpec.fallbackText ?? "";
  if (!isRenderableUiSpec(uiSpec)) return <UiSpecFallback text={fallbackText} />;
  const ctx: RenderCtx = {
    taskId: task.id,
    elements: uiSpec.spec.elements,
    actions: uiSpec.actions,
  };
  return (
    <div data-slot="task-ui-spec" className="min-w-0 mt-3">
      <UiSpecBoundary fallbackText={fallbackText}>
        <UiSpecNode id={uiSpec.spec.root} ctx={ctx} />
      </UiSpecBoundary>
    </div>
  );
}
