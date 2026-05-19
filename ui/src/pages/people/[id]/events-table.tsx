/**
 * Identity-event table for the Person detail page (Pass 2, Group D #10).
 *
 * Refactored from a custom shadcn `<Table>` with inline expansion to the
 * canonical AG Grid `DataGrid` pattern used by `tasks-table.tsx` and
 * `agent-table.tsx`. Clicking a row opens an `<EventDetailSheet>` instead of
 * inline-expanding a JSON payload, which keeps the row density tight and
 * lets us render before/after side-by-side on wider canvases.
 */

import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useState } from "react";
import { useUserEvents } from "@/api/hooks/use-users";
import type { IdentityEvent } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelative } from "@/lib/relative-time";
import { EventIcon } from "../user-status";
import { EventDetailSheet } from "./event-detail-sheet";

function formatActor(actor: string): { short: string; full: string } {
  if (actor.startsWith("op:")) return { short: "Operator", full: actor };
  if (actor.startsWith("system:")) {
    const tail = actor.slice("system:".length);
    return { short: tail || "System", full: actor };
  }
  if (actor.startsWith("user:")) return { short: "User", full: actor };
  return { short: actor.length > 18 ? `${actor.slice(0, 16)}…` : actor, full: actor };
}

/**
 * Compact one-line diff describing what changed. Same algorithm as the
 * previous inline implementation — verbatim copy so the Change column reads
 * identically. Falls back to "Updated" when the shape is unrecognized; the
 * detail sheet shows the full JSON either way.
 */
function describeEvent(e: IdentityEvent): React.ReactNode {
  const before = e.before as Record<string, unknown> | null;
  const after = e.after as Record<string, unknown> | null;

  if (e.eventType === "identity_added" && after && "kind" in after) {
    return (
      <>
        <span className="text-status-success-strong">+ identity</span>{" "}
        <span className="font-mono text-xs">
          {String(after.kind)}/{String(after.externalId)}
        </span>
      </>
    );
  }
  if (e.eventType === "identity_removed" && before && "kind" in before) {
    return (
      <>
        <span className="text-status-error-strong">− identity</span>{" "}
        <span className="font-mono text-xs">
          {String(before.kind)}/{String(before.externalId)}
        </span>
      </>
    );
  }
  if (e.eventType === "email_added" && after && "email" in after) {
    return (
      <>
        <span className="text-status-success-strong">+ alias</span>{" "}
        <span className="font-mono text-xs">{String(after.email)}</span>
      </>
    );
  }
  if (e.eventType === "email_removed" && before && "email" in before) {
    return (
      <>
        <span className="text-status-error-strong">− alias</span>{" "}
        <span className="font-mono text-xs">{String(before.email)}</span>
      </>
    );
  }
  if (e.eventType === "budget_changed") {
    const b = before && "dailyBudgetUsd" in before ? before.dailyBudgetUsd : null;
    const a = after && "dailyBudgetUsd" in after ? after.dailyBudgetUsd : null;
    return (
      <span className="font-mono text-xs">
        budget: {b == null ? "∞" : `$${Number(b).toFixed(2)}`} →{" "}
        {a == null ? "∞" : `$${Number(a).toFixed(2)}`}
      </span>
    );
  }
  if (e.eventType === "status_changed") {
    return (
      <span className="font-mono text-xs">
        status: {String(before?.status ?? "?")} → {String(after?.status ?? "?")}
      </span>
    );
  }
  if (e.eventType === "profile_changed") {
    const beforeKeys = before ? Object.keys(before) : [];
    const afterKeys = after ? Object.keys(after) : [];
    const field = beforeKeys[0] ?? afterKeys[0];
    if (field) {
      const b = before?.[field];
      const a = after?.[field];
      return (
        <span className="font-mono text-xs">
          {field}: <span className="text-muted-foreground">{stringifyShort(b)}</span> →{" "}
          <span>{stringifyShort(a)}</span>
        </span>
      );
    }
  }
  if (e.eventType === "manual_merge" || e.eventType === "auto_merge") {
    return <span className="text-xs text-muted-foreground">Merged into this user</span>;
  }
  return <span className="text-xs text-muted-foreground">Updated</span>;
}

function stringifyShort(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v.length > 28 ? `${v.slice(0, 26)}…` : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 28 ? `${s.slice(0, 26)}…` : s;
  } catch {
    return String(v);
  }
}

/* ── Cell renderers ─────────────────────────────────────────────────────── */

function TimeCell({ value }: { value: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="text-xs text-muted-foreground">{formatRelative(value)}</span>
      </TooltipTrigger>
      <TooltipContent className="font-mono text-[10px]">{value}</TooltipContent>
    </Tooltip>
  );
}

function EventTypeCell({ value }: { value: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <EventIcon eventType={value} />
      <span className="text-sm capitalize">{value.replaceAll("_", " ")}</span>
    </span>
  );
}

function ActorCell({ value }: { value: string }) {
  const actor = formatActor(value);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="text-xs text-foreground/80">{actor.short}</span>
      </TooltipTrigger>
      <TooltipContent className="font-mono text-[10px]">{actor.full}</TooltipContent>
    </Tooltip>
  );
}

function ChangeCell({ data }: { data: IdentityEvent | undefined }) {
  if (!data) return null;
  return <>{describeEvent(data)}</>;
}

/* ── Table ──────────────────────────────────────────────────────────────── */

export function EventsTable({ userId }: { userId: string }) {
  const { data: events, isLoading } = useUserEvents(userId, { limit: 100 });
  const [selected, setSelected] = useState<IdentityEvent | null>(null);

  if (isLoading) return <p className="text-sm text-muted-foreground py-6">Loading events…</p>;
  if (!events || events.length === 0)
    return (
      <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        No identity events yet — every mutation to this user lands here.
      </div>
    );

  const fixed = { suppressSizeToFit: true } as const;
  const columnDefs: ColDef<IdentityEvent>[] = [
    {
      headerName: "Time",
      field: "createdAt",
      width: 120,
      ...fixed,
      sort: "desc",
      cellRenderer: (p: ICellRendererParams<IdentityEvent>) =>
        p.value ? <TimeCell value={p.value as string} /> : null,
    },
    {
      headerName: "Event",
      field: "eventType",
      width: 200,
      ...fixed,
      cellRenderer: (p: ICellRendererParams<IdentityEvent>) =>
        p.value ? <EventTypeCell value={p.value as string} /> : null,
    },
    {
      headerName: "Actor",
      field: "actor",
      width: 140,
      ...fixed,
      cellRenderer: (p: ICellRendererParams<IdentityEvent>) =>
        p.value ? <ActorCell value={p.value as string} /> : null,
    },
    {
      headerName: "Change",
      colId: "change",
      flex: 1,
      minWidth: 200,
      sortable: false,
      cellRenderer: (p: ICellRendererParams<IdentityEvent>) => <ChangeCell data={p.data} />,
    },
  ];

  return (
    <>
      <DataGrid
        rowData={events}
        columnDefs={columnDefs}
        domLayout="autoHeight"
        pagination={false}
        onRowClicked={(e) => {
          if (e.data) setSelected(e.data);
        }}
        emptyMessage="No identity events yet."
        getRowId={(p) => p.data.id}
      />
      <EventDetailSheet
        event={selected}
        open={!!selected}
        onOpenChange={(o) => !o && setSelected(null)}
      />
    </>
  );
}
