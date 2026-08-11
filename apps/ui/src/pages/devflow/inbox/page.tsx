import type { ColDef } from "ag-grid-community";
import { Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { DevFlowWorkItem } from "@/api/devflow-types";
import { useDevFlowWorkItems } from "@/api/hooks/use-devflow";
import { CaptureDialog } from "@/components/devflow/capture-dialog";
import { DevFlowStateBadge } from "@/components/devflow/devflow-state-badge";
import { DataGrid } from "@/components/shared/data-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export default function DevFlowInboxPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [captureOpen, setCaptureOpen] = useState(false);
  const { data, isLoading } = useDevFlowWorkItems({ search: search || undefined });
  const columns = useMemo<ColDef<DevFlowWorkItem>[]>(
    () => [
      { field: "title", headerName: "Idea", flex: 1, minWidth: 260 },
      {
        field: "state",
        headerName: "State",
        width: 118,
        cellRenderer: ({ value }: { value: DevFlowWorkItem["state"] }) => (
          <DevFlowStateBadge state={value} />
        ),
      },
      {
        field: "type",
        headerName: "Type",
        width: 120,
        cellRenderer: ({ value }: { value: string }) => (
          <Badge variant="outline" size="tag">
            {value}
          </Badge>
        ),
      },
      {
        field: "priority",
        headerName: "Priority",
        width: 105,
        valueFormatter: ({ value }) => value ?? "—",
      },
      {
        field: "createdAt",
        headerName: "Captured",
        width: 170,
        valueFormatter: ({ value }) => new Date(value).toLocaleString(),
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader
        title="Idea Inbox"
        description="Capture raw demand, then use bounded Agent Swarm evidence to move it toward a decision."
      />
      <div className="flex items-center gap-2">
        <div className="relative max-w-md flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search captured work…"
            className="pl-9"
          />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon" onClick={() => setCaptureOpen(true)} aria-label="Capture idea">
              <Plus />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Capture idea</TooltipContent>
        </Tooltip>
      </div>
      <DataGrid
        rowData={data?.items}
        columnDefs={columns}
        loading={isLoading}
        emptyMessage="No work has been captured yet"
        onRowClicked={(event) => event.data && navigate(`/devflow/work-items/${event.data.id}`)}
      />
      <CaptureDialog open={captureOpen} onOpenChange={setCaptureOpen} />
    </div>
  );
}
