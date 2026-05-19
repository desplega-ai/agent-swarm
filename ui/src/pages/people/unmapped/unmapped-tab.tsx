import type { ColDef } from "ag-grid-community";
import { Check, ChevronsUpDown, Copy, Filter, LinkIcon, Search, UserPlus } from "lucide-react";
import { useCallback, useDeferredValue, useMemo, useState } from "react";
import { toast } from "sonner";
import { useResolveUnmapped, useUnmapped } from "@/api/hooks/use-users";
import type { UnmappedIdentity } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, formatSmartTime } from "@/lib/utils";
import { IdentityBadge } from "../identity-badges";
import { IntegrationIcon } from "../integration-icons";
import { LinkToExistingDialog } from "./link-to-existing-dialog";
import { ResolveCreateDialog } from "./resolve-create-dialog";

const KIND_FILTERS = ["all", "slack", "linear", "github", "gitlab"] as const;
type KindFilter = (typeof KIND_FILTERS)[number];

const KIND_LABEL: Record<KindFilter, string> = {
  all: "All",
  slack: "Slack",
  linear: "Linear",
  github: "GitHub",
  gitlab: "GitLab",
};

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

function unmappedMatches(row: UnmappedIdentity, query: string): boolean {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = buildUnmappedHaystack(row);
  return tokens.every((t) => hay.includes(t));
}

export function UnmappedTab() {
  const [kind, setKind] = useState<KindFilter>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const { data, isLoading } = useUnmapped({ kind: kind === "all" ? undefined : kind });
  const resolve = useResolveUnmapped();

  const [linkTarget, setLinkTarget] = useState<UnmappedIdentity | null>(null);
  const [createTarget, setCreateTarget] = useState<UnmappedIdentity | null>(null);

  // FE-only search across externalId, displayName (meta), kind, and sample
  // event type. Payload is small (triage queue, typically <100 entries), so
  // no server-side query param needed.
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  const filteredData = useMemo(() => {
    if (!data) return undefined;
    const q = deferredQuery.trim();
    if (!q) return data;
    return data.filter((row) => unmappedMatches(row, q));
  }, [data, deferredQuery]);

  const copyId = useCallback((externalId: string) => {
    navigator.clipboard.writeText(externalId).then(
      () => toast.success(`Copied "${externalId}"`),
      () => toast.error("Copy failed"),
    );
  }, []);

  const columnDefs = useMemo<ColDef<UnmappedIdentity>[]>(
    () => [
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
        width: 280,
        cellRenderer: (params: { data: UnmappedIdentity | undefined }) => {
          if (!params.data) return null;
          const row = params.data;
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
            </div>
          );
        },
      },
    ],
    [resolve.isPending, copyId],
  );

  const showEmpty = !isLoading && (data?.length ?? 0) === 0;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      {/* Toolbar: search left (flex-1), kind-filter dropdown right. Single
          row — the filter is a Popover+Command combobox so it scales as we
          add new identity kinds (mirrors the user-picker pattern from
          merge-modal.tsx). Toolbar stays outside the scrollable region so it
          remains visible while the table scrolls internally. */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
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
              className="h-9 w-[180px] justify-between font-normal"
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
                        setKind(k);
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

      {showEmpty ? (
        <EmptyState
          icon={UserPlus}
          title="No unmapped identities"
          description="Inbound webhooks from unknown users will appear here for triage."
        />
      ) : (
        <DataGrid
          rowData={filteredData}
          columnDefs={columnDefs}
          loading={isLoading}
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
