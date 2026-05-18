import type { ColDef } from "ag-grid-community";
import { Copy, LinkIcon, UserPlus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { useResolveUnmapped, useUnmapped } from "@/api/hooks/use-users";
import type { UnmappedIdentity } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, formatSmartTime } from "@/lib/utils";
import { IdentityBadge } from "../identity-badges";
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

export function UnmappedTab() {
  const [kind, setKind] = useState<KindFilter>("all");
  const { data, isLoading } = useUnmapped({ kind: kind === "all" ? undefined : kind });
  const resolve = useResolveUnmapped();

  const [linkTarget, setLinkTarget] = useState<UnmappedIdentity | null>(null);
  const [createTarget, setCreateTarget] = useState<UnmappedIdentity | null>(null);

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

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs text-muted-foreground mr-1">Filter:</span>
        {KIND_FILTERS.map((k) => (
          <Button
            key={k}
            size="sm"
            variant={kind === k ? "default" : "outline"}
            onClick={() => setKind(k)}
          >
            {KIND_LABEL[k]}
          </Button>
        ))}
      </div>

      {!isLoading && (data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={UserPlus}
          title="No unmapped identities"
          description="Inbound webhooks from unknown users will appear here for triage."
        />
      ) : (
        <DataGrid
          rowData={data}
          columnDefs={columnDefs}
          loading={isLoading}
          emptyMessage="No unmapped identities for this filter."
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
