import type { ColDef } from "ag-grid-community";
import {
  Check,
  ChevronsUpDown,
  Copy,
  EyeOff,
  Filter,
  LinkIcon,
  Search,
  Undo2,
  UserPlus,
} from "lucide-react";
import { useCallback, useDeferredValue, useMemo, useState } from "react";
import { toast } from "sonner";
import { useResolveUnmapped, useSetUnmappedDismissed, useUnmapped } from "@/api/hooks/use-users";
import type { UnmappedIdentity } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { readBooleanParam, readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { cn, formatSmartTime } from "@/lib/utils";
import { IdentityBadge } from "../identity-badges";
import { IntegrationIcon } from "../integration-icons";
import { LinkToExistingDialog } from "./link-to-existing-dialog";
import { ResolveCreateDialog } from "./resolve-create-dialog";

const KIND_FILTERS = ["all", "slack", "linear", "github", "gitlab", "bitbucket"] as const;
type KindFilter = (typeof KIND_FILTERS)[number];

const KIND_LABEL: Record<KindFilter, string> = {
  all: "All",
  slack: "Slack",
  linear: "Linear",
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
};

function coerceKind(value: string): KindFilter {
  return KIND_FILTERS.includes(value as KindFilter) ? (value as KindFilter) : "all";
}

/**
 * Build a single lower-cased haystack from the fields a triager would actually
 * search for: external ID, kind, sample event type, and any display name
 * surfaced via sampleContext or its meta object when present.
 */
function buildUnmappedHaystack(row: UnmappedIdentity): string {
  const parts: string[] = [row.externalId, row.kind, row.sampleEventType ?? ""];
  const ctx = row.sampleContext;
  if (ctx && typeof ctx === "object" && !Array.isArray(ctx)) {
    const rec = ctx as Record<string, unknown>;
    const displayName = rec.displayName;
    if (typeof displayName === "string") parts.push(displayName);
    const meta = rec.meta;
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      const m = meta as Record<string, unknown>;
      for (const key of ["displayName", "name", "username", "handle", "login"]) {
        const v = m[key];
        if (typeof v === "string") parts.push(v);
      }
    }
  }
  return parts.join(" ").toLowerCase();
}

function rowKey(row: UnmappedIdentity): string {
  return JSON.stringify([row.kind, row.externalId]);
}

function unmappedMatches(row: UnmappedIdentity, query: string): boolean {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = buildUnmappedHaystack(row);
  return tokens.every((t) => hay.includes(t));
}

export function UnmappedTab() {
  const isMobile = useIsMobile();
  const { searchParams, setParam } = useUrlSearchState();
  const kind = coerceKind(readStringParam(searchParams, "kind", "all"));
  const [filterOpen, setFilterOpen] = useState(false);
  const showDismissed = readBooleanParam(searchParams, "unmappedDismissed");
  const includeBots = readBooleanParam(searchParams, "unmappedBots");
  const { data, isLoading } = useUnmapped({
    kind: kind === "all" ? undefined : kind,
    dismissed: showDismissed,
    includeBots,
  });
  const resolve = useResolveUnmapped();
  const setDismissed = useSetUnmappedDismissed();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const [linkTarget, setLinkTarget] = useState<UnmappedIdentity | null>(null);
  const [createTarget, setCreateTarget] = useState<UnmappedIdentity | null>(null);

  // FE-only search across externalId, displayName (meta), kind, and sample
  // event type. Payload is small (triage queue, typically <100 entries), so
  // no server-side query param needed.
  const query = readStringParam(searchParams, "unmappedQ");
  const deferredQuery = useDeferredValue(query);

  const filteredData = useMemo(() => {
    if (!data) return undefined;
    const q = deferredQuery.trim();
    if (!q) return data;
    return data.filter((row) => unmappedMatches(row, q));
  }, [data, deferredQuery]);

  // Selection outside the current view is ignored, so a filter change needs no reset.
  const selectedRows = useMemo(
    () => (filteredData ?? []).filter((row) => selected.has(rowKey(row))),
    [filteredData, selected],
  );
  const allSelected = !!filteredData?.length && selectedRows.length === filteredData.length;

  const toggleRow = useCallback((row: UnmappedIdentity, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(rowKey(row));
      else next.delete(rowKey(row));
      return next;
    });
  }, []);

  const toggleAll = useCallback(
    (checked: boolean) => setSelected(new Set(checked ? (filteredData ?? []).map(rowKey) : [])),
    [filteredData],
  );

  const mutateDismissed = setDismissed.mutate;
  const applyDismissed = useCallback(
    (action: "dismiss" | "restore", rows: UnmappedIdentity[]) => {
      const identities = rows.map(({ kind, externalId }) => ({ kind, externalId }));
      const label = rows.length === 1 ? `"${rows[0]?.externalId}"` : `${rows.length} identities`;
      mutateDismissed(
        { action, identities },
        {
          onSuccess: () => {
            setSelected(new Set());
            if (action === "dismiss") {
              toast.success(`Dismissed ${label}`, {
                action: {
                  label: "Undo",
                  onClick: () => mutateDismissed({ action: "restore", identities }),
                },
              });
            } else {
              toast.success(`Restored ${label}`);
            }
          },
          onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
        },
      );
    },
    [mutateDismissed],
  );

  const copyId = useCallback((externalId: string) => {
    navigator.clipboard.writeText(externalId).then(
      () => toast.success(`Copied "${externalId}"`),
      () => toast.error("Copy failed"),
    );
  }, []);

  const columnDefs = useMemo<ColDef<UnmappedIdentity>[]>(
    () => [
      {
        colId: "select",
        width: 48,
        sortable: false,
        headerComponent: () => (
          <Checkbox
            aria-label="Select all"
            checked={allSelected ? true : selectedRows.length > 0 ? "indeterminate" : false}
            onCheckedChange={(checked) => toggleAll(checked === true)}
          />
        ),
        cellRenderer: (params: { data: UnmappedIdentity | undefined }) => {
          const row = params.data;
          if (!row) return null;
          return (
            <Checkbox
              aria-label={`Select ${row.externalId}`}
              checked={selected.has(rowKey(row))}
              onCheckedChange={(checked) => toggleRow(row, checked === true)}
              onClick={(e) => e.stopPropagation()}
            />
          );
        },
      },
      {
        field: "kind",
        headerName: "Kind",
        width: 110,
        cellRenderer: (params: { data: UnmappedIdentity | undefined }) => {
          if (!params.data) return null;
          return (
            <IdentityBadge
              identity={{ kind: params.data.kind, externalId: params.data.externalId }}
              showId={false}
            />
          );
        },
      },
      {
        field: "externalId",
        headerName: "External ID",
        flex: 1,
        minWidth: 200,
        cellRenderer: (params: { value: string }) => (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              copyId(params.value);
            }}
            className="flex items-center gap-1.5 text-xs font-mono hover:text-foreground text-muted-foreground"
          >
            <span className="truncate">{params.value}</span>
            <Copy className="h-3 w-3 shrink-0 opacity-50" />
          </button>
        ),
      },
      {
        field: "count",
        headerName: "Count",
        width: 90,
        sort: "desc",
        cellRenderer: (params: { value: number }) => (
          <span className={cn("font-mono text-xs", params.value > 1 && "font-semibold")}>
            {params.value.toLocaleString()}
          </span>
        ),
      },
      {
        field: "lastSeenAt",
        headerName: "Last seen",
        width: 140,
        cellRenderer: (params: { value: string | null }) =>
          params.value ? (
            <span className="text-xs text-muted-foreground">{formatSmartTime(params.value)}</span>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      ...(showDismissed
        ? [
            {
              field: "dismissedAt",
              headerName: "Dismissed",
              width: 140,
              cellRenderer: (params: { value: string | undefined }) =>
                params.value ? (
                  <span className="text-xs text-muted-foreground">
                    {formatSmartTime(params.value)}
                  </span>
                ) : (
                  <span className="text-muted-foreground">-</span>
                ),
            } satisfies ColDef<UnmappedIdentity>,
          ]
        : []),
      {
        field: "sampleEventType",
        headerName: "Sample event",
        width: 160,
        cellRenderer: (params: { value: string | null }) =>
          params.value ? (
            <Badge variant="outline" size="tag" className="font-mono normal-case">
              {params.value}
            </Badge>
          ) : (
            <span className="text-muted-foreground text-xs">-</span>
          ),
      },
      {
        field: "sampleContext",
        headerName: "Context",
        flex: 1.4,
        minWidth: 200,
        cellRenderer: (params: { value: unknown }) => {
          if (params.value == null) return <span className="text-muted-foreground text-xs">-</span>;
          const str =
            typeof params.value === "string" ? params.value : JSON.stringify(params.value);
          const truncated = str.length > 80 ? `${str.slice(0, 78)}…` : str;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-xs font-mono text-muted-foreground truncate block">
                  {truncated}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-md">
                <pre className="text-[10px] font-mono whitespace-pre-wrap">{str}</pre>
              </TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        headerName: "Actions",
        width: showDismissed ? 120 : 380,
        cellRenderer: (params: { data: UnmappedIdentity | undefined }) => {
          if (!params.data) return null;
          const row = params.data;
          if (showDismissed) {
            return (
              <Button
                size="sm"
                variant="outline"
                onClick={(e) => {
                  e.stopPropagation();
                  applyDismissed("restore", [row]);
                }}
                disabled={setDismissed.isPending}
              >
                <Undo2 className="h-3 w-3 mr-1" />
                Undo
              </Button>
            );
          }
          return (
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                onClick={(e) => {
                  e.stopPropagation();
                  setLinkTarget(row);
                }}
                disabled={resolve.isPending}
              >
                <LinkIcon className="h-3 w-3 mr-1" />
                Link to user
              </Button>
              <Button
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setCreateTarget(row);
                }}
                disabled={resolve.isPending}
              >
                <UserPlus className="h-3 w-3 mr-1" />
                Create user
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  applyDismissed("dismiss", [row]);
                }}
                disabled={setDismissed.isPending}
              >
                <EyeOff className="h-3 w-3 mr-1" />
                Dismiss
              </Button>
            </div>
          );
        },
      },
    ],
    [
      resolve.isPending,
      setDismissed.isPending,
      copyId,
      showDismissed,
      applyDismissed,
      selected,
      selectedRows.length,
      allSelected,
      toggleAll,
      toggleRow,
    ],
  );

  const showEmpty = !isLoading && (data?.length ?? 0) === 0;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      {/* Toolbar: search left (flex-1), kind-filter dropdown right. Single
          row — the filter is a Popover+Command combobox so it scales as we
          add new identity kinds (mirrors the user-picker pattern from
          merge-modal.tsx). Toolbar stays outside the scrollable region so it
          remains visible while the table scrolls internally. */}
      <div className="flex flex-nowrap items-center gap-2 shrink-0">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) =>
              setParam("unmappedQ", e.target.value, { reset: ["unmappedPeoplePage"] })
            }
            placeholder="Search unmapped — ID, name, event…"
            className="pl-8 h-9"
            disabled={showEmpty}
          />
          {query && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
              {filteredData?.length ?? 0} / {data?.length ?? 0}
            </div>
          )}
        </div>

        <Popover open={filterOpen} onOpenChange={setFilterOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              role="combobox"
              aria-expanded={filterOpen}
              className="h-9 w-[150px] shrink-0 justify-between font-normal md:w-[180px]"
            >
              <span className="flex items-center gap-1.5 min-w-0">
                {kind === "all" ? (
                  <Filter className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                ) : (
                  <IntegrationIcon
                    kind={kind}
                    className="h-3.5 w-3.5 text-foreground/70 shrink-0"
                  />
                )}
                <span className="text-muted-foreground shrink-0">Filter:</span>
                <span className="truncate text-foreground">{KIND_LABEL[kind]}</span>
              </span>
              <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="end">
            <Command>
              <CommandInput placeholder="Search kinds…" />
              <CommandList>
                <CommandEmpty>No kinds found.</CommandEmpty>
                <CommandGroup>
                  {KIND_FILTERS.map((k) => (
                    <CommandItem
                      key={k}
                      value={KIND_LABEL[k]}
                      onSelect={() => {
                        setParam("kind", k, {
                          defaultValue: "all",
                          reset: ["unmappedPeoplePage"],
                        });
                        setFilterOpen(false);
                      }}
                      className="gap-2"
                    >
                      <Check
                        className={cn("h-4 w-4 shrink-0", kind === k ? "opacity-100" : "opacity-0")}
                      />
                      {k === "all" ? (
                        <Filter className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      ) : (
                        <IntegrationIcon
                          kind={k}
                          className="h-3.5 w-3.5 text-foreground/70 shrink-0"
                        />
                      )}
                      <span>{KIND_LABEL[k]}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      <div className="flex flex-wrap items-center gap-4 shrink-0 text-xs text-muted-foreground">
        <label className="flex items-center gap-2">
          <Switch
            checked={includeBots}
            onCheckedChange={(checked) =>
              setParam("unmappedBots", checked ? "true" : "", { reset: ["unmappedPeoplePage"] })
            }
          />
          Show bots
        </label>
        <label className="flex items-center gap-2">
          <Switch
            checked={showDismissed}
            onCheckedChange={(checked) =>
              setParam("unmappedDismissed", checked ? "true" : "", {
                reset: ["unmappedPeoplePage"],
              })
            }
          />
          Show dismissed
        </label>
        {selectedRows.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => applyDismissed(showDismissed ? "restore" : "dismiss", selectedRows)}
            disabled={setDismissed.isPending}
          >
            {showDismissed ? (
              <Undo2 className="h-3 w-3 mr-1" />
            ) : (
              <EyeOff className="h-3 w-3 mr-1" />
            )}
            {showDismissed ? "Undo" : "Dismiss"} {selectedRows.length} selected
          </Button>
        )}
      </div>

      {showEmpty ? (
        <EmptyState
          icon={showDismissed ? EyeOff : UserPlus}
          title={showDismissed ? "No dismissed identities" : "No unmapped identities"}
          description={
            showDismissed
              ? "Identities you dismiss move here. Undo returns them to the queue."
              : "Inbound webhooks from unknown users will appear here for triage."
          }
        />
      ) : isMobile ? (
        // The grid pushes the Link and Create buttons off a phone's screen;
        // they sit under each row here.
        <MobileList
          label="Unmapped identities"
          loading={isLoading}
          emptyMessage="No unmapped identities for this filter."
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {(filteredData ?? []).map((row) => (
            <MobileListRow
              key={`${row.kind}:${row.externalId}`}
              onClick={() => copyId(row.externalId)}
              leading={<IntegrationIcon kind={row.kind} className="size-4 text-foreground/70" />}
              title={<span className="font-mono text-xs">{row.externalId}</span>}
              titleLines={1}
              meta={[
                KIND_LABEL[coerceKind(row.kind)] ?? row.kind,
                `${row.count.toLocaleString()} event${row.count === 1 ? "" : "s"}`,
                row.lastSeenAt ? formatSmartTime(row.lastSeenAt) : null,
              ]}
              extras={
                showDismissed ? (
                  <div className="flex gap-2 px-4 pb-3">
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      onClick={() => applyDismissed("restore", [row])}
                      disabled={setDismissed.isPending}
                    >
                      <Undo2 className="h-3 w-3 mr-1" />
                      Undo
                    </Button>
                  </div>
                ) : (
                  <div className="flex gap-2 px-4 pb-3">
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      onClick={() => setLinkTarget(row)}
                      disabled={resolve.isPending}
                    >
                      <LinkIcon className="h-3 w-3 mr-1" />
                      Link to user
                    </Button>
                    <Button
                      size="sm"
                      className="flex-1"
                      onClick={() => setCreateTarget(row)}
                      disabled={resolve.isPending}
                    >
                      <UserPlus className="h-3 w-3 mr-1" />
                      Create user
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => applyDismissed("dismiss", [row])}
                      disabled={setDismissed.isPending}
                      aria-label={`Dismiss ${row.externalId}`}
                    >
                      <EyeOff className="h-3 w-3" />
                    </Button>
                  </div>
                )
              }
            />
          ))}
        </MobileList>
      ) : (
        <DataGrid
          rowData={filteredData}
          columnDefs={columnDefs}
          loading={isLoading}
          paginationQueryKey="unmappedPeople"
          getRowId={(params) => rowKey(params.data)}
          emptyMessage={
            query.trim()
              ? "No unmapped identities match this search."
              : "No unmapped identities for this filter."
          }
        />
      )}

      <LinkToExistingDialog
        target={linkTarget}
        onOpenChange={(open) => {
          if (!open) setLinkTarget(null);
        }}
      />
      <ResolveCreateDialog
        target={createTarget}
        onOpenChange={(open) => {
          if (!open) setCreateTarget(null);
        }}
      />
    </div>
  );
}
