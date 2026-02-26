import { useState, useMemo, useCallback } from "react";
import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { useRepos, useCreateRepo, useUpdateRepo, useDeleteRepo } from "@/api/hooks/use-repos";
import { DataGrid } from "@/components/shared/data-grid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { GitBranch, Plus, Pencil, Trash2, FolderGit2, ExternalLink } from "lucide-react";
import type { SwarmRepo } from "@/api/types";

interface RepoFormData {
  url: string;
  name: string;
  clonePath: string;
  defaultBranch: string;
  autoClone: boolean;
}

const emptyForm: RepoFormData = {
  url: "",
  name: "",
  clonePath: "",
  defaultBranch: "main",
  autoClone: false,
};

function RepoDialog({
  open,
  onOpenChange,
  editRepo,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editRepo: SwarmRepo | null;
  onSubmit: (data: RepoFormData) => void;
}) {
  const [form, setForm] = useState<RepoFormData>(
    editRepo
      ? {
          url: editRepo.url,
          name: editRepo.name,
          clonePath: editRepo.clonePath,
          defaultBranch: editRepo.defaultBranch,
          autoClone: editRepo.autoClone,
        }
      : emptyForm,
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit(form);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{editRepo ? "Edit Repository" : "Add Repository"}</DialogTitle>
            <DialogDescription>
              {editRepo ? "Update repository settings." : "Register a new repository."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="repo-url">Repository URL</Label>
              <Input
                id="repo-url"
                placeholder="https://github.com/org/repo"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="repo-name">Name</Label>
              <Input
                id="repo-name"
                placeholder="my-repo"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="repo-clone-path">Clone Path</Label>
              <Input
                id="repo-clone-path"
                placeholder="/workspace/repos/my-repo"
                value={form.clonePath}
                onChange={(e) => setForm({ ...form, clonePath: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="repo-branch">Default Branch</Label>
              <Input
                id="repo-branch"
                placeholder="main"
                value={form.defaultBranch}
                onChange={(e) => setForm({ ...form, defaultBranch: e.target.value })}
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="repo-auto-clone"
                checked={form.autoClone}
                onCheckedChange={(checked) => setForm({ ...form, autoClone: checked })}
              />
              <Label htmlFor="repo-auto-clone">Auto-clone on worker start</Label>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="bg-primary hover:bg-primary/90">
              {editRepo ? "Update" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ReposPage() {
  const { data: repos, isLoading } = useRepos();
  const createRepo = useCreateRepo();
  const updateRepo = useUpdateRepo();
  const deleteRepo = useDeleteRepo();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRepo, setEditingRepo] = useState<SwarmRepo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SwarmRepo | null>(null);

  function handleAdd() {
    setEditingRepo(null);
    setDialogOpen(true);
  }

  function handleEdit(repo: SwarmRepo) {
    setEditingRepo(repo);
    setDialogOpen(true);
  }

  function handleSubmit(data: RepoFormData) {
    if (editingRepo) {
      updateRepo.mutate({ id: editingRepo.id, data });
    } else {
      createRepo.mutate(data);
    }
    setEditingRepo(null);
  }

  function handleDelete() {
    if (deleteTarget) {
      deleteRepo.mutate(deleteTarget.id);
      setDeleteTarget(null);
    }
  }

  const columnDefs = useMemo<ColDef<SwarmRepo>[]>(
    () => [
      {
        field: "name",
        headerName: "Name",
        width: 180,
        cellRenderer: (params: { value: string }) => (
          <span className="font-semibold">{params.value}</span>
        ),
      },
      {
        field: "url",
        headerName: "URL",
        flex: 1,
        minWidth: 250,
        cellRenderer: (params: ICellRendererParams<SwarmRepo>) => {
          const url = params.value as string;
          if (!url) return "—";
          return (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <span className="truncate">{url}</span>
              <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
            </a>
          );
        },
      },
      {
        field: "clonePath",
        headerName: "Clone Path",
        width: 200,
        cellRenderer: (params: { value: string }) => (
          <span className="font-mono text-xs text-muted-foreground">{params.value || "—"}</span>
        ),
      },
      {
        field: "defaultBranch",
        headerName: "Branch",
        width: 120,
        cellRenderer: (params: { value: string }) => (
          <span className="inline-flex items-center gap-1 text-sm">
            <GitBranch className="h-3 w-3" />
            {params.value}
          </span>
        ),
      },
      {
        field: "autoClone",
        headerName: "Auto-Clone",
        width: 110,
        cellRenderer: (params: { value: boolean }) => (
          <Badge
            variant="outline"
            className={
              params.value
                ? "text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center bg-emerald-500/15 text-emerald-500 border-emerald-500/30"
                : "text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center"
            }
          >
            {params.value ? "ON" : "OFF"}
          </Badge>
        ),
      },
      {
        headerName: "",
        width: 100,
        sortable: false,
        filter: false,
        cellRenderer: (params: ICellRendererParams<SwarmRepo>) => {
          const repo = params.data;
          if (!repo) return null;
          return (
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="outline"
                className="h-7 w-7 border-border/60"
                onClick={(e) => {
                  e.stopPropagation();
                  handleEdit(repo);
                }}
              >
                <Pencil className="h-3 w-3" />
              </Button>
              <Button
                size="icon"
                variant="outline"
                className="h-7 w-7 border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteTarget(repo);
                }}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          );
        },
      },
    ],
    [],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<SwarmRepo>) => {
      // Skip if click originated from a button (action column)
      const target = event.event?.target as HTMLElement;
      if (target?.closest("button")) return;
      if (event.data) {
        setEditingRepo(event.data);
        setDialogOpen(true);
      }
    },
    [],
  );

  if (!isLoading && (!repos || repos.length === 0)) {
    return (
      <div className="flex flex-col flex-1 min-h-0 gap-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Repos</h1>
          <Button onClick={handleAdd} size="sm" className="gap-1 bg-primary hover:bg-primary/90">
            <Plus className="h-3.5 w-3.5" /> Add Repo
          </Button>
        </div>
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <FolderGit2 className="h-8 w-8 mb-2" />
          <p className="text-sm">No repositories registered</p>
        </div>

        <RepoDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          editRepo={editingRepo}
          onSubmit={handleSubmit}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Repos</h1>
        <Button onClick={handleAdd} size="sm" className="gap-1 bg-primary hover:bg-primary/90">
          <Plus className="h-3.5 w-3.5" /> Add Repo
        </Button>
      </div>

      <DataGrid
        rowData={repos ?? []}
        columnDefs={columnDefs}
        onRowClicked={onRowClicked}
        loading={isLoading}
        emptyMessage="No repositories registered"
      />

      <RepoDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editRepo={editingRepo}
        onSubmit={handleSubmit}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Repository</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This action cannot be undone.
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
