import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo } from "react";
import type { SwarmConfig } from "@/api/types";
import { Combobox } from "@/components/shared/combobox";
import { DataGrid } from "@/components/shared/data-grid";
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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSwarmConfig } from "@/hooks/use-swarm-config";
import { ConfigDetailDialog } from "./config-detail-dialog";
import { ConfigEntryDialog } from "./config-entry-dialog";

export function SwarmConfigSection() {
  const {
    isLoading,
    agentMap,
    dialogOpen,
    setDialogOpen,
    editEntry,
    deleteTarget,
    setDeleteTarget,
    detailEntry,
    setDetailEntry,
    scopeFilter,
    setScopeFilter,
    search,
    setSearch,
    agentFilter,
    setAgentFilter,
    handleAdd,
    handleEdit,
    handleSubmit,
    handleDelete,
    onRowClicked,
    filteredConfigs,
    agentOptions,
  } = useSwarmConfig();

  const columnDefs = useMemo<ColDef<SwarmConfig>[]>(
    () => [
      {
        field: "scope",
        headerName: "Scope",
        width: 110,
        minWidth: 90,
        cellRenderer: (params: { value: string }) => (
          <Badge variant="outline" size="tag">
            {params.value}
          </Badge>
        ),
      },
      {
        headerName: "Agent / Scope ID",
        width: 160,
        minWidth: 120,
        valueGetter: (params) => {
          const d = params.data;
          if (!d) return "—";
          if (d.scope === "agent" && d.scopeId)
            return agentMap.get(d.scopeId) ?? `${d.scopeId.slice(0, 8)}...`;
          if (d.scope === "repo" && d.scopeId) return `${d.scopeId.slice(0, 8)}...`;
          return "—";
        },
      },
      {
        field: "key",
        headerName: "Key",
        width: 200,
        minWidth: 140,
        cellRenderer: (params: { value: string }) => (
          <span className="font-mono select-text">{params.value}</span>
        ),
      },
      {
        field: "value",
        headerName: "Value",
        width: 260,
        minWidth: 160,
        maxWidth: 320,
        cellRenderer: (params: ICellRendererParams<SwarmConfig>) => {
          const cfg = params.data;
          if (!cfg) return null;
          if (cfg.isSecret) {
            return <span className="font-mono text-muted-foreground">••••••••</span>;
          }
          return <span className="font-mono truncate select-text">{cfg.value}</span>;
        },
      },
      {
        field: "description",
        headerName: "Description",
        flex: 1,
        minWidth: 160,
        cellRenderer: (params: { value: string | null }) => (
          <span className="text-muted-foreground truncate">{params.value ?? "—"}</span>
        ),
      },
      {
        headerName: "",
        width: 100,
        minWidth: 100,
        sortable: false,
        cellRenderer: (params: ICellRendererParams<SwarmConfig>) => {
          const cfg = params.data;
          if (!cfg) return null;
          return (
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="outline"
                className="h-7 w-7 border-border/60"
                onClick={(e) => {
                  e.stopPropagation();
                  handleEdit(cfg);
                }}
              >
                <Pencil className="h-3 w-3" />
              </Button>
              <Button
                size="icon"
                variant="destructive-outline"
                className="h-7 w-7"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteTarget(cfg);
                }}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          );
        },
      },
    ],
    [agentMap, handleEdit, setDeleteTarget],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Input
          placeholder="Search by key, description, or agent…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select value={scopeFilter} onValueChange={setScopeFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Scopes</SelectItem>
            <SelectItem value="global">Global</SelectItem>
            <SelectItem value="agent">Agent</SelectItem>
            <SelectItem value="repo">Repo</SelectItem>
          </SelectContent>
        </Select>
        {scopeFilter === "agent" && (
          <Combobox
            options={agentOptions}
            value={agentFilter}
            onChange={setAgentFilter}
            placeholder="All agents"
            searchPlaceholder="Search agents…"
            emptyMessage="No agents found"
            allowClear
            clearLabel="All agents"
            triggerClassName="w-[220px]"
          />
        )}
        <Button
          onClick={handleAdd}
          size="sm"
          className="gap-1 bg-primary hover:bg-primary/90 ml-auto"
        >
          <Plus className="h-3.5 w-3.5" /> Add Entry
        </Button>
      </div>

      <DataGrid
        rowData={filteredConfigs ?? []}
        columnDefs={columnDefs}
        onRowClicked={onRowClicked}
        loading={isLoading}
        emptyMessage="No configuration entries"
        enableCellTextSelection
      />

      <ConfigDetailDialog
        config={detailEntry}
        onOpenChange={(open) => !open && setDetailEntry(null)}
        agentName={detailEntry?.scopeId ? agentMap.get(detailEntry.scopeId) : undefined}
      />

      <ConfigEntryDialog
        key={editEntry?.id ?? "new"}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editEntry={editEntry}
        onSubmit={handleSubmit}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Config Entry</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete{" "}
              <strong className="font-mono">{deleteTarget?.key}</strong>? This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
