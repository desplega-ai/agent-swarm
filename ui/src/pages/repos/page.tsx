import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { ExternalLink, FolderGit2, GitBranch, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCreateRepo, useDeleteRepo, useRepos, useUpdateRepo } from "@/api/hooks/use-repos";
import type { SwarmRepo } from "@/api/types";
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
import { PageHeader } from "@/components/ui/page-header";
import { Switch } from "@/components/ui/switch";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";

interface RepoFormData {
  url: string;
  name: string;
  clonePath: string;
  defaultBranch: string;
  autoClone: boolean;
  hooks: { enabled: boolean };
}

const clonePathForName = (name: string) => (name ? `/workspace/personal/repos/${name}` : "");

const emptyForm: RepoFormData = {
  url: "",
  name: "",
  clonePath: "",
  defaultBranch: "main",
  autoClone: true,
  hooks: { enabled: true },
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
          hooks: editRepo.hooks,
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
                onChange={(e) => {
                  const name = e.target.value;
                  setForm((current) => ({
                    ...current,
                    name,
                    clonePath:
                      !editRepo &&
                      (!current.clonePath || current.clonePath === clonePathForName(current.name))
                        ? clonePathForName(name)
                        : current.clonePath,
                  }));
                }}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="repo-clone-path">Clone Path</Label>
              <Input
                id="repo-clone-path"
                placeholder="/workspace/personal/repos/my-repo"
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
            <div className="flex items-center gap-2">
              <Switch
                id="repo-hooks-enabled"
                checked={form.hooks.enabled}
                onCheckedChange={(checked) => setForm({ ...form, hooks: { enabled: checked } })}
              />
              <Label htmlFor="repo-hooks-enabled">Install git hooks</Label>
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

  const navigate = useNavigate();
  const { searchParams, setParam } = useUrlSearchState();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRepo, setEditingRepo] = useState<SwarmRepo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SwarmRepo | null>(null);
  const search = readStringParam(searchParams, "search");

  function handleAdd() {
    setEditingRepo(null);
    setDialogOpen(true);
  }

  const handleEdit = useCallback((repo: SwarmRepo) => {
    setEditingRepo(repo);
    setDialogOpen(true);
  }, []);

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
                ? "text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center bg-status-success/15 text-status-success border-status-success/30"
                : "text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center"
            }
          >
            {params.value ? "ON" : "OFF"}
          </Badge>
        ),
      },
      {
        headerName: "Hooks",
        width: 100,
        valueGetter: (params) => params.data?.hooks.enabled ?? false,
        cellRenderer: (params: { value: boolean }) => (
          <Badge
            variant="outline"
            className={
              params.value
                ? "text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center bg-status-success/15 text-status-success border-status-success/30"
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
                variant="destructive-outline"
                className="h-7 w-7"
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
    [handleEdit],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<SwarmRepo>) => {
      const target = event.event?.target as HTMLElement;
      if (target?.closest("button") || target?.closest("a")) return;
      if (event.data) {
        navigate(`/repos/${event.data.id}`);
      }
    },
    [navigate],
  );

  if (!isLoading && (!repos || repos.length === 0)) {
    return (
      <div className="flex flex-col flex-1 min-h-0 gap-4">
        <PageHeader
          title="Repos"
          action={
            <Button onClick={handleAdd} size="sm" className="gap-1 bg-primary hover:bg-primary/90">
              <Plus className="h-3.5 w-3.5" /> Add Repo
            </Button>
          }
        />
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <FolderGit2 className="h-8 w-8 mb-2" />
          <p className="text-sm">No repositories registered</p>
        </div>

        <RepoDialog
          key={editingRepo?.id ?? "new"}
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
      <PageHeader
        title="Repos"
        action={
          <Button onClick={handleAdd} size="sm" className="gap-1 bg-primary hover:bg-primary/90">
            <Plus className="h-3.5 w-3.5" /> Add Repo
          </Button>
        }
      />

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search repos…"
            value={search}
            onChange={(e) => setParam("search", e.target.value, { reset: ["reposPage"] })}
            className="pl-9"
          />
        </div>
      </div>

      <DataGrid
        rowData={repos ?? []}
        columnDefs={columnDefs}
        quickFilterText={search}
        onRowClicked={onRowClicked}
        loading={isLoading}
        emptyMessage="No repositories registered"
        paginationQueryKey="repos"
      />

      <RepoDialog
        key={editingRepo?.id ?? "new"}
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
              Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This action
              cannot be undone.
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
