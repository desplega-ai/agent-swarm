import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { Plus, Search } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useCreateEpic, useEpics } from "@/api/hooks/use-epics";
import type { EpicStatus, EpicWithProgress } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatSmartTime } from "@/lib/utils";

interface EpicFormData {
  name: string;
  goal: string;
  description: string;
  priority: number;
  tags: string;
  leadAgentId: string;
}

const emptyEpicForm: EpicFormData = {
  name: "",
  goal: "",
  description: "",
  priority: 50,
  tags: "",
  leadAgentId: "",
};

function EpicDialog({
  open,
  onOpenChange,
  onSubmit,
  editData,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: EpicFormData) => void;
  editData?: EpicFormData | null;
}) {
  const { data: agents } = useAgents();
  const [form, setForm] = useState<EpicFormData>(editData ?? emptyEpicForm);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit(form);
    if (!editData) setForm(emptyEpicForm);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{editData ? "Edit Epic" : "Create Epic"}</DialogTitle>
            <DialogDescription>
              {editData ? "Update epic details." : "Create a new epic to organize tasks."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Name *</Label>
              <Input
                placeholder="Epic name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Goal *</Label>
              <Textarea
                placeholder="What should this epic achieve?"
                value={form.goal}
                onChange={(e) => setForm({ ...form, goal: e.target.value })}
                required
                rows={2}
              />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                placeholder="Additional details..."
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={2}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Priority (0–100)</Label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
                />
              </div>
              <div className="space-y-2">
                <Label>Lead Agent</Label>
                <Select
                  value={form.leadAgentId}
                  onValueChange={(v) => setForm({ ...form, leadAgentId: v === "_none" ? "" : v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">None</SelectItem>
                    {agents?.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                        {a.isLead ? " (Lead)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Tags (comma-separated)</Label>
              <Input
                placeholder="frontend, urgent"
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              className="bg-primary hover:bg-primary/90"
              disabled={!form.name.trim() || !form.goal.trim()}
            >
              {editData ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function EpicsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const createEpic = useCreateEpic();

  function handleCreateSubmit(data: EpicFormData) {
    const tags = data.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    createEpic.mutate({
      name: data.name,
      goal: data.goal,
      ...(data.description && { description: data.description }),
      ...(data.priority !== 50 && { priority: data.priority }),
      ...(tags.length > 0 && { tags }),
      ...(data.leadAgentId && { leadAgentId: data.leadAgentId }),
    });
  }

  const filters = useMemo(() => {
    const f: { status?: string } = {};
    if (statusFilter !== "all") f.status = statusFilter;
    return f;
  }, [statusFilter]);

  const { data: epicsData, isLoading } = useEpics(
    Object.keys(filters).length > 0 ? filters : undefined,
  );

  const columnDefs = useMemo<ColDef<EpicWithProgress>[]>(
    () => [
      {
        field: "name",
        headerName: "Name",
        width: 250,
        cellRenderer: (params: { value: string }) => (
          <span className="font-semibold">{params.value}</span>
        ),
      },
      {
        field: "status",
        headerName: "Status",
        width: 120,
        cellRenderer: (params: { value: EpicStatus }) => <StatusBadge status={params.value} />,
      },
      {
        field: "goal",
        headerName: "Goal",
        flex: 1,
        minWidth: 250,
        cellRenderer: (params: { value: string }) => (
          <span className="truncate text-muted-foreground">{params.value}</span>
        ),
      },
      {
        field: "progress",
        headerName: "Progress",
        width: 150,
        cellRenderer: (params: { value: number; data: EpicWithProgress | undefined }) => {
          const pct = params.value ?? 0;
          return (
            <div className="flex items-center gap-2 w-full h-full">
              <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-xs font-mono text-muted-foreground w-10 text-right">
                {Math.round(pct)}%
              </span>
            </div>
          );
        },
      },
      {
        headerName: "Tasks",
        width: 80,
        valueGetter: (params) => params.data?.taskStats?.total ?? 0,
      },
      {
        field: "createdAt",
        headerName: "Created",
        width: 150,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
    ],
    [],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<EpicWithProgress>) => {
      if (event.data) navigate(`/epics/${event.data.id}`);
    },
    [navigate],
  );

  // Cast epics to EpicWithProgress — the API returns them with taskStats/progress
  const epics = (epicsData?.epics ?? []) as unknown as EpicWithProgress[];

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Epics</h1>
        <Button
          onClick={() => setDialogOpen(true)}
          size="sm"
          className="gap-1 bg-primary hover:bg-primary/90"
        >
          <Plus className="h-3.5 w-3.5" /> Create Epic
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search epics..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="paused">Paused</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataGrid
        rowData={epics}
        columnDefs={columnDefs}
        quickFilterText={search}
        onRowClicked={onRowClicked}
        loading={isLoading}
        emptyMessage="No epics found"
      />

      <EpicDialog open={dialogOpen} onOpenChange={setDialogOpen} onSubmit={handleCreateSubmit} />
    </div>
  );
}
