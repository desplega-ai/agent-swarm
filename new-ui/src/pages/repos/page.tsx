import { useState } from "react";
import { useRepos, useCreateRepo, useUpdateRepo, useDeleteRepo } from "@/api/hooks/use-repos";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { GitBranch, Plus, Pencil, Trash2, FolderGit2 } from "lucide-react";
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
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

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

  function handleDelete(id: string) {
    deleteRepo.mutate(id);
    setDeleteConfirm(null);
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Repos</h1>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Repos</h1>
        <Button onClick={handleAdd} className="gap-1 bg-primary hover:bg-primary/90">
          <Plus className="h-4 w-4" /> Add Repo
        </Button>
      </div>

      {repos && repos.length > 0 ? (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>URL</TableHead>
                <TableHead>Clone Path</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Auto-Clone</TableHead>
                <TableHead className="w-[100px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {repos.map((repo) => (
                <TableRow key={repo.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-1.5">
                      <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground" />
                      {repo.name}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-[250px] truncate">
                    {repo.url}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground font-mono text-xs">
                    {repo.clonePath}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1 text-sm">
                      <GitBranch className="h-3 w-3" />
                      {repo.defaultBranch}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={repo.autoClone ? "default" : "secondary"}
                      className={
                        repo.autoClone
                          ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                          : ""
                      }
                    >
                      {repo.autoClone ? "Yes" : "No"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => handleEdit(repo)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      {deleteConfirm === repo.id ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-red-400 hover:text-red-300"
                          onClick={() => handleDelete(repo.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      ) : (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => setDeleteConfirm(repo.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <FolderGit2 className="h-8 w-8 mb-2" />
          <p className="text-sm">No repositories registered</p>
        </div>
      )}

      <RepoDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editRepo={editingRepo}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
