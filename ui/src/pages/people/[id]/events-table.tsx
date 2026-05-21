/**
 * Identity-event table for the Person detail page.
 *
 * Pass 2 introduced the AG-Grid layout + EventDetailSheet pattern; Pass 3
 * Group H reworks the *density* and the *per-row signal*:
 *
 *   • `rowHeight: 56` so the Time and Change columns can carry two lines.
 *   • Time cell: relative ("3h ago") + absolute (`2026-05-19 11:13:51`) below.
 *   • Event cell: icon + title-case label + a small actor-type chip
 *     (Operator / System / User) derived from the canonical `<kind>:<id>`
 *     actor string emitted by `src/be/users.ts::actorString`.
 *   • Actor cell: short label on top + a muted hex preview underneath
 *     (e.g. "Operator" / "96ca4b…"); tooltip exposes the full opaque string.
 *   • Change cell: per-event-type rich rendering — brand icon for identity
 *     events, `key: "before" → "after"` diff for profile/status/budget,
 *     last-4 preview for tokens, merge target if available. The detail
 *     sheet (`event-detail-sheet.tsx`, owned by Pass 2 Group D) still owns
 *     the full before/after JSON view — this column only has to be
 *     self-explanatory at a glance.
 *
 * Bug fix: the Pass 2 `formatActor` checked for `op:` but the canonical
 * prefix is `operator:` (see `IdentityActor.kind`). Every operator row was
 * silently falling through to the truncated raw-string branch. Same fix
 * mirrored into `event-detail-sheet.tsx` happens out-of-band; we keep this
 * file's parsing self-contained so it stays correct regardless.
 */

import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useState } from "react";
import { useUserEvents } from "@/api/hooks/use-users";
import type { IdentityEvent } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelative } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { IntegrationIcon } from "../integration-icons";
import { EventIcon } from "../user-status";
import { EventDetailSheet } from "./event-detail-sheet";

/**
 * Parse the canonical `<kind>:<id>` actor string emitted by
 * `src/be/users.ts::actorString`. `kind` is one of "operator" | "system" |
 * "user"; `id` is a fingerprint hash, a free-form subkind (`system:webhook:test`
 * is observed in tests), or the empty string. Forward-compatible: unknown
 * prefixes pass through with `type: "unknown"` so a future `webhook:slack:…`
 * shape renders sensibly instead of crashing.
 */
type ActorType = "operator" | "system" | "user" | "unknown";
interface ParsedActor {
  type: ActorType;
  label: string;
  id: string;
  full: string;
}

function parseActor(actor: string): ParsedActor {
  if (actor.startsWith("operator:")) {
    return {
      type: "operator",
      label: "Operator",
      id: actor.slice("operator:".length),
      full: actor,
    };
  }
  if (actor.startsWith("system:")) {
    // `system:` can carry a subkind: `system:webhook:test`, `system:test-suite`.
    // Surface the subkind in the label so it's distinguishable at a glance.
    const tail = actor.slice("system:".length);
    if (!tail) return { type: "system", label: "System", id: "", full: actor };
    const head = tail.split(":")[0] ?? tail;
    return { type: "system", label: `System · ${head}`, id: tail, full: actor };
  }
  if (actor.startsWith("user:")) {
    return { type: "user", label: "User", id: actor.slice("user:".length), full: actor };
  }
  return { type: "unknown", label: actor || "Unknown", id: "", full: actor };
}

/** Short fixed-width hex preview, never the AG-Grid `…` truncate. */
function shortId(id: string): string {
  if (!id) return "";
  if (id.length <= 10) return id;
  return `${id.slice(0, 8)}…`;
}

/* ── Change-column rich rendering ───────────────────────────────────────── */

/**
 * Compact one-line summary of a profile-field diff. Used inside the multi-line
 * Change cell. Strings render with literal quotes so " " (whitespace) edits
 * remain visible.
 */
function diffValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") {
    const trimmed = v.length > 24 ? `${v.slice(0, 22)}…` : v;
    return `"${trimmed}"`;
  }
  try {
    const s = JSON.stringify(v);
    return s.length > 24 ? `${s.slice(0, 22)}…` : s;
  } catch {
    return String(v);
  }
}

/** Last-4 token preview (e.g. `sk_...a3f9`). Token shape isn't constrained, so
 *  fall back to a hex hash slice if the value isn't a string. */
function tokenPreview(value: unknown): string {
  if (typeof value === "string") {
    if (value.length <= 4) return value;
    return `…${value.slice(-4)}`;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const fp = obj.fingerprint ?? obj.id ?? obj.tokenId;
    if (typeof fp === "string") return `…${fp.slice(-4)}`;
  }
  return "?";
}

interface ChangeRendering {
  /** Tone for the leading kbd/icon — same vocabulary as EventIcon tones. */
  tone: string;
  /** Inline lead — usually a brand icon or a `+ / −` glyph. */
  lead: React.ReactNode;
  /** Primary one-liner. */
  primary: React.ReactNode;
  /** Optional secondary line (e.g. before→after diff). */
  secondary?: React.ReactNode;
}

function renderChange(e: IdentityEvent): ChangeRendering {
  const before = e.before as Record<string, unknown> | null;
  const after = e.after as Record<string, unknown> | null;

  if (e.eventType === "identity_added" && after && "kind" in after) {
    const kind = String(after.kind);
    return {
      tone: "text-status-success-strong",
      lead: <IntegrationIcon kind={kind} className="h-4 w-4 text-foreground/80" />,
      primary: (
        <span className="text-xs">
          <span className="text-status-success-strong font-medium">Linked</span>{" "}
          <span className="font-medium">{kind}</span>{" "}
          <span className="text-muted-foreground/60">·</span>{" "}
          <span className="font-mono text-[11px]">{String(after.externalId)}</span>
        </span>
      ),
    };
  }
  if (e.eventType === "identity_removed" && before && "kind" in before) {
    const kind = String(before.kind);
    return {
      tone: "text-status-error-strong",
      lead: <IntegrationIcon kind={kind} className="h-4 w-4 text-foreground/60" />,
      primary: (
        <span className="text-xs">
          <span className="text-status-error-strong font-medium">Unlinked</span>{" "}
          <span className="font-medium">{kind}</span>{" "}
          <span className="text-muted-foreground/60">·</span>{" "}
          <span className="font-mono text-[11px] line-through decoration-muted-foreground/50">
            {String(before.externalId)}
          </span>
        </span>
      ),
    };
  }
  if (e.eventType === "email_added" && after && "email" in after) {
    return {
      tone: "text-status-success-strong",
      lead: <span className="font-mono text-base leading-none text-status-success-strong">+</span>,
      primary: (
        <span className="text-xs">
          <span className="text-status-success-strong font-medium">Added alias</span>{" "}
          <span className="font-mono text-[11px]">{String(after.email)}</span>
        </span>
      ),
    };
  }
  if (e.eventType === "email_removed" && before && "email" in before) {
    return {
      tone: "text-status-error-strong",
      lead: <span className="font-mono text-base leading-none text-status-error-strong">−</span>,
      primary: (
        <span className="text-xs">
          <span className="text-status-error-strong font-medium">Removed alias</span>{" "}
          <span className="font-mono text-[11px] line-through decoration-muted-foreground/50">
            {String(before.email)}
          </span>
        </span>
      ),
    };
  }
  if (e.eventType === "budget_changed") {
    const b = before && "dailyBudgetUsd" in before ? before.dailyBudgetUsd : null;
    const a = after && "dailyBudgetUsd" in after ? after.dailyBudgetUsd : null;
    return {
      tone: "text-status-active-strong",
      lead: <span className="font-mono text-xs text-status-active-strong">$</span>,
      primary: <span className="text-xs font-medium">Budget changed</span>,
      secondary: (
        <span className="font-mono text-[11px] text-muted-foreground">
          {b == null ? "unlimited" : `$${Number(b).toFixed(2)}/day`}
          <span className="text-muted-foreground/60"> → </span>
          <span className="text-foreground/80">
            {a == null ? "unlimited" : `$${Number(a).toFixed(2)}/day`}
          </span>
        </span>
      ),
    };
  }
  if (e.eventType === "status_changed") {
    const b = String(before?.status ?? "?");
    const a = String(after?.status ?? "?");
    return {
      tone: "text-status-paused-strong",
      lead: <span className="text-status-paused-strong text-xs">●</span>,
      primary: <span className="text-xs font-medium">Status changed</span>,
      secondary: (
        <span className="font-mono text-[11px] text-muted-foreground">
          {b} <span className="text-muted-foreground/60">→</span>{" "}
          <span className="text-foreground/80">{a}</span>
        </span>
      ),
    };
  }
  if (e.eventType === "profile_changed") {
    const beforeKeys = before ? Object.keys(before) : [];
    const afterKeys = after ? Object.keys(after) : [];
    const fields = Array.from(new Set([...beforeKeys, ...afterKeys]));
    const field = fields[0];
    const extraFieldCount = fields.length - 1;
    if (field) {
      return {
        tone: "text-muted-foreground",
        lead: <span className="text-muted-foreground text-xs">✎</span>,
        primary: (
          <span className="text-xs">
            <span className="font-medium">Profile</span>{" "}
            <span className="font-mono text-[11px] text-muted-foreground">{field}</span>
            {extraFieldCount > 0 && (
              <span className="text-muted-foreground/60"> +{extraFieldCount} more</span>
            )}
          </span>
        ),
        secondary: (
          <span className="font-mono text-[11px] text-muted-foreground">
            {diffValue(before?.[field])} <span className="text-muted-foreground/60">→</span>{" "}
            <span className="text-foreground/80">{diffValue(after?.[field])}</span>
          </span>
        ),
      };
    }
  }
  if (e.eventType === "token_minted") {
    const preview = tokenPreview(after);
    return {
      tone: "text-status-active-strong",
      lead: <span className="text-status-active-strong text-xs">⌬</span>,
      primary: (
        <span className="text-xs">
          <span className="font-medium">Token minted</span>{" "}
          <span className="font-mono text-[11px] text-muted-foreground">{preview}</span>
        </span>
      ),
    };
  }
  if (e.eventType === "token_revoked") {
    const preview = tokenPreview(before);
    return {
      tone: "text-status-error-strong",
      lead: <span className="text-status-error-strong text-xs">⌬</span>,
      primary: (
        <span className="text-xs">
          <span className="font-medium">Token revoked</span>{" "}
          <span className="font-mono text-[11px] text-muted-foreground line-through decoration-muted-foreground/50">
            {preview}
          </span>
        </span>
      ),
    };
  }
  if (e.eventType === "manual_merge" || e.eventType === "auto_merge") {
    // Merge payloads are heterogeneous — best-effort surface a source name if
    // it's present. `manual_merge` events carry the deleted source user under
    // `after.source` ({id, name, email}); older events / `auto_merge` may only
    // have a loose `sourceUserId`/`mergedFrom`. Falls back gracefully.
    const source = after?.source as { name?: string; id?: string } | undefined;
    const from =
      (source && (source.name ?? source.id)) ??
      (before && (before.name ?? before.id ?? before.sourceUserId)) ??
      (after && (after.sourceUserId ?? after.mergedFrom));
    const to = after && (after.name ?? after.id);
    return {
      tone:
        e.eventType === "manual_merge"
          ? "text-action-delegate-to-agent"
          : "text-status-info-strong",
      lead: <span className="text-foreground/70 text-xs">⇄</span>,
      primary: (
        <span className="text-xs">
          <span className="font-medium">
            {e.eventType === "manual_merge" ? "Merged manually" : "Auto-merged"}
          </span>
          {from ? (
            <>
              {" "}
              <span className="text-muted-foreground/60">from</span>{" "}
              <span className="font-mono text-[11px]">{String(from)}</span>
            </>
          ) : null}
          {to ? (
            <>
              {" "}
              <span className="text-muted-foreground/60">→</span>{" "}
              <span className="font-mono text-[11px]">{String(to)}</span>
            </>
          ) : null}
        </span>
      ),
    };
  }
  return {
    tone: "text-muted-foreground",
    lead: <span className="text-muted-foreground text-xs">·</span>,
    primary: <span className="text-xs text-muted-foreground">Updated</span>,
  };
}

/* ── Cell renderers ─────────────────────────────────────────────────────── */

/** Two-line Time cell — relative on top, absolute date below. */
function TimeCell({ value }: { value: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex flex-col leading-tight gap-0.5 py-1">
          <span className="text-xs text-foreground/80">{formatRelative(value)}</span>
          <span className="font-mono text-[10px] text-muted-foreground/70">
            {value
              .replace("T", " ")
              .replace(/\.\d+Z$/, "")
              .replace("Z", "")}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent className="font-mono text-[10px]">{value}</TooltipContent>
    </Tooltip>
  );
}

const ACTOR_CHIP_STYLES: Record<ActorType, string> = {
  operator: "border-status-info/30 bg-status-info/10 text-status-info-strong",
  system: "border-status-paused/30 bg-status-paused/10 text-status-paused-strong",
  user: "border-status-active/30 bg-status-active/10 text-status-active-strong",
  unknown: "border-border bg-muted/40 text-muted-foreground",
};

function ActorTypeChip({ type }: { type: ActorType }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-1 text-[9px] uppercase tracking-wider font-medium leading-[14px]",
        ACTOR_CHIP_STYLES[type],
      )}
    >
      {type}
    </span>
  );
}

/** Event-cell: icon + label on top, small actor-type chip on the second line. */
function EventTypeCell({ data }: { data: IdentityEvent | undefined }) {
  if (!data) return null;
  const actor = parseActor(data.actor);
  const label = data.eventType.replaceAll("_", " ");
  // Title-case so "identity_removed" reads as "Identity Removed".
  const titled = label.replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <div className="flex flex-col gap-1 py-1">
      <span className="inline-flex items-center gap-2">
        <EventIcon eventType={data.eventType} />
        <span className="text-sm font-medium">{titled}</span>
      </span>
      <ActorTypeChip type={actor.type} />
    </div>
  );
}

/** Actor-cell: human label + short id underneath, full string in tooltip. */
function ActorCell({ value }: { value: string }) {
  const actor = parseActor(value);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex flex-col leading-tight gap-0.5 py-1">
          <span className="text-xs text-foreground/80">{actor.label}</span>
          {actor.id ? (
            <span className="font-mono text-[10px] text-muted-foreground/70">
              {shortId(actor.id)}
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground/40">—</span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent className="font-mono text-[10px]">{actor.full}</TooltipContent>
    </Tooltip>
  );
}

/** Change-cell: icon + headline + optional diff line. */
function ChangeCell({ data }: { data: IdentityEvent | undefined }) {
  if (!data) return null;
  const r = renderChange(data);
  return (
    <div className="flex items-start gap-2 py-1 min-w-0">
      <span className={cn("shrink-0 mt-0.5", r.tone)}>{r.lead}</span>
      <div className="flex flex-col leading-tight gap-0.5 min-w-0">
        <div className="truncate">{r.primary}</div>
        {r.secondary && <div className="truncate">{r.secondary}</div>}
      </div>
    </div>
  );
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
      width: 140,
      ...fixed,
      sort: "desc",
      cellRenderer: (p: ICellRendererParams<IdentityEvent>) =>
        p.value ? <TimeCell value={p.value as string} /> : null,
    },
    {
      headerName: "Event",
      field: "eventType",
      width: 220,
      ...fixed,
      cellRenderer: (p: ICellRendererParams<IdentityEvent>) => <EventTypeCell data={p.data} />,
    },
    {
      headerName: "Actor",
      field: "actor",
      width: 160,
      ...fixed,
      cellRenderer: (p: ICellRendererParams<IdentityEvent>) =>
        p.value ? <ActorCell value={p.value as string} /> : null,
    },
    {
      headerName: "Change",
      colId: "change",
      flex: 1,
      minWidth: 260,
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
        rowHeight={56}
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
