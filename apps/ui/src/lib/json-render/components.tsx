/**
 * React implementations for every component in `swarmCatalog`.
 *
 * The first seven (Container, Card, Heading, Text, Button, Metric, Alert) are
 * a verbatim move out of `pages/pages/[id]/json-page-renderer.tsx` — the
 * pages renderer's behaviour is unchanged. Table / Form / Badge are the
 * swarm-apps additions and are built from existing dashboard primitives
 * (`DataGrid`, `Badge`, `Input`, `Textarea`, `Select`, `Switch`, `SettingsRow`).
 */

import { getByPath, type InferComponentProps } from "@json-render/core";
import type { Components } from "@json-render/react";
import { useActions, useStateStore } from "@json-render/react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { AlertCircle, AlertTriangle, ArrowRight, CheckCircle, Info } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { DataGrid } from "@/components/shared/data-grid";
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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsRow } from "@/components/ui/settings-row";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { formatSmartTime } from "@/lib/utils";
import { resolveScopedParams } from "./action-params";
import type {
  ActionChain,
  BadgeTone,
  FormField,
  swarmCatalog,
  TableColumn,
  TableRowAction,
  TableRowActionConfirm,
} from "./catalog";

// ─── Style maps (moved verbatim from json-page-renderer.tsx) ────────────────

const gapClass: Record<"none" | "sm" | "md" | "lg", string> = {
  none: "gap-0",
  sm: "gap-2",
  md: "gap-4",
  lg: "gap-6",
};

const headingClass: Record<"h1" | "h2" | "h3", string> = {
  h1: "text-2xl font-bold tracking-tight",
  h2: "text-xl font-semibold tracking-tight",
  h3: "text-lg font-semibold",
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

/** Badge tone → semantic status-token classes (see apps/ui/CLAUDE.md theming). */
const badgeToneClass: Record<BadgeTone, string> = {
  neutral: "border-status-neutral/40 bg-status-neutral/10 text-status-neutral",
  success: "border-status-success/40 bg-status-success/10 text-status-success-strong",
  active: "border-status-active/40 bg-status-active/10 text-status-active-strong",
  error: "border-status-error/40 bg-status-error/10 text-status-error-strong",
  info: "border-status-info/40 bg-status-info/10 text-status-info-strong",
  pending: "border-status-pending/40 bg-status-pending/10 text-status-pending-strong",
  warning: "border-status-warning/40 bg-status-warning/10 text-status-warning-strong",
  paused: "border-status-paused/40 bg-status-paused/10 text-status-paused-strong",
};

function StatusPill({ text, tone }: { text: string; tone: BadgeTone }) {
  return (
    <Badge variant="outline" size="tag" className={badgeToneClass[tone]}>
      {text}
    </Badge>
  );
}

// ─── Table ──────────────────────────────────────────────────────────────────

type TableProps = InferComponentProps<typeof swarmCatalog, "Table">;
type FormProps = InferComponentProps<typeof swarmCatalog, "Form">;

function formatCell(column: TableColumn, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (column.kind === "date") {
    const text = String(value);
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? text : formatSmartTime(text);
  }
  if (column.kind === "boolean") return value ? "yes" : "no";
  return String(value);
}

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

/**
 * Whether a row action must go through an `AlertDialog` first, and with what
 * copy. `apps/ui/CLAUDE.md` makes confirmation a hard rule for destructive actions,
 * so destructive variants default to confirming even when the JSON author says
 * nothing — an app definition cannot ship a one-click delete by omission.
 */
function confirmConfigFor(rowAction: TableRowAction): TableRowActionConfirm | null {
  const confirm = rowAction.confirm;
  if (confirm === false) return null;
  if (confirm === undefined)
    return DESTRUCTIVE_VARIANTS.has(rowAction.variant ?? "outline") ? {} : null;
  if (confirm === true) return {};
  if (typeof confirm === "string") return { description: confirm };
  return confirm;
}

interface PendingRowAction {
  rowActionIndex: number;
  row: Record<string, unknown>;
  rowIndex: number;
}

function TableComponent({ props }: { props: TableProps }) {
  const { execute } = useActions();
  const { getSnapshot } = useStateStore();
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

  const columns = (props.columns ?? []) as TableColumn[];
  const rowActions = (props.rowActions ?? []) as TableRowAction[];
  const rows = Array.isArray(props.data) ? (props.data as Record<string, unknown>[]) : [];

  const builtColumnDefs: ColDef<Record<string, unknown>>[] = columns.map((column) => ({
    headerName: column.label ?? column.key,
    field: column.key,
    width: column.width,
    flex: column.width ? undefined : 1,
    minWidth: 100,
    valueFormatter:
      column.kind === "badge" ? undefined : (params) => formatCell(column, params.value),
    cellRenderer:
      column.kind === "badge"
        ? (params: ICellRendererParams<Record<string, unknown>>) => {
            const raw =
              params.value === null || params.value === undefined ? "" : String(params.value);
            if (!raw) return null;
            return <StatusPill text={raw} tone={column.tones?.[raw] ?? "neutral"} />;
          }
        : undefined,
  }));

  if (rowActions.length > 0) {
    builtColumnDefs.push({
      headerName: "",
      colId: "__rowActions",
      sortable: false,
      filter: false,
      minWidth: 120 * rowActions.length,
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

  const confirmingAction = pendingRowAction
    ? rowActions[pendingRowAction.rowActionIndex]
    : undefined;
  const confirmCopy = confirmingAction ? confirmConfigFor(confirmingAction) : null;
  const confirmIsDestructive = DESTRUCTIVE_VARIANTS.has(confirmingAction?.variant ?? "outline");

  return (
    <div className="flex flex-col gap-2" data-testid="json-render-table">
      {props.error ? (
        <AlertCallout tone="error" icon={AlertCircle} title="Query failed">
          {props.error}
        </AlertCallout>
      ) : null}
      <DataGrid
        rowData={rows}
        columnDefs={columnDefs}
        loading={props.loading ?? false}
        emptyMessage={props.emptyMessage ?? "No rows yet"}
        domLayout="autoHeight"
        pagination={false}
      />
      <AlertDialog
        open={pendingRowAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRowAction(null);
        }}
      >
        <AlertDialogContent>
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
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const fields = (props.fields ?? []) as FormField[];
  const basePath = `/forms/${props.id}`;
  // Read through the reactive `state` snapshot (not `get()`) so a cleared form
  // — `app.mutate` sets `/forms/<id>` to `{}` after a create — re-renders.
  const readField = (name: string): unknown => getByPath(state, `${basePath}/${name}`);

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
    setSubmitting(true);
    try {
      const scope = { form: values, state: getSnapshot() };
      for (const binding of props.onSubmit as ActionChain) {
        const params = resolveScopedParams(binding.params, scope);
        // The originating form clears itself on a successful create — the
        // `app.mutate` handler needs to know which form that is.
        if (binding.action === "app.mutate" && params.op === "create" && !params.formId) {
          params.formId = props.id;
        }
        await execute({ ...binding, params });
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
                <SelectTrigger id={inputId}>
                  <SelectValue placeholder={field.placeholder ?? "Select…"} />
                </SelectTrigger>
                <SelectContent>
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
      {validationError ? (
        <AlertCallout tone="error" icon={AlertCircle}>
          {validationError}
        </AlertCallout>
      ) : null}
      <div>
        <Button type="submit" disabled={submitting}>
          {props.submitLabel ?? "Submit"}
        </Button>
      </div>
    </form>
  );
}

// ─── Component registry ─────────────────────────────────────────────────────

export const swarmComponents: Components<typeof swarmCatalog> = {
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
  Button: ({ props, emit }) => (
    <Button variant={props.variant ?? "default"} onClick={() => emit("press")}>
      {props.label}
      <ArrowRight className="h-3.5 w-3.5" />
    </Button>
  ),
  Metric: ({ props }) => (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{props.label}</span>
      <span className="text-2xl font-semibold text-foreground">{String(props.value)}</span>
    </div>
  ),
  Alert: ({ props }) => {
    const tone = alertTone[props.tone ?? "info"];
    return (
      <AlertCallout tone={tone.tone} icon={tone.icon} title={props.title}>
        {props.message}
      </AlertCallout>
    );
  },
  Badge: ({ props }) => <StatusPill text={String(props.text)} tone={props.tone ?? "neutral"} />,
  Table: ({ props }) => <TableComponent props={props} />,
  Form: ({ props }) => <FormComponent props={props} />,
};
