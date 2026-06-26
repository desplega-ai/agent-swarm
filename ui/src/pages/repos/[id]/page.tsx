import {
  ArrowLeft,
  Check,
  ExternalLink,
  GitBranch,
  Pencil,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { useDeleteRepo, useRepo, useUpdateRepo } from "@/api/hooks/use-repos";
import type { RepoGuidelines, SwarmRepo } from "@/api/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DetailPageBody,
  DetailPageRail,
  QuickStat,
  QuickStats,
} from "@/components/ui/detail-page-layout";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { formatSmartTime } from "@/lib/utils";

interface RepoFormData {
  url: string;
  name: string;
  clonePath: string;
  defaultBranch: string;
  autoClone: boolean;
  hooks: { enabled: boolean };
}

function RepoEditDialog({
  open,
  onOpenChange,
  repo,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repo: SwarmRepo;
  onSubmit: (data: RepoFormData) => void;
}) {
  const [form, setForm] = useState<RepoFormData>({
    url: repo.url,
    name: repo.name,
    clonePath: repo.clonePath,
    defaultBranch: repo.defaultBranch,
    autoClone: repo.autoClone,
    hooks: repo.hooks,
  });

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
            <DialogTitle>Edit Repository</DialogTitle>
            <DialogDescription>Update repository settings.</DialogDescription>
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
              Update
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GuidelinesSection({ guidelines }: { guidelines: RepoGuidelines }) {
  const sections = [
    {
      title: "PR Checks",
      items: guidelines.prChecks,
      icon: <ShieldCheck className="h-4 w-4 text-status-active" />,
    },
    {
      title: "Merge Checks",
      items: guidelines.mergeChecks,
      icon: <GitBranch className="h-4 w-4 text-status-success" />,
    },
    {
      title: "Review Guidelines",
      items: guidelines.review,
      icon: <Check className="h-4 w-4 text-status-paused" />,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">Guidelines</h2>
        <Badge
          variant="outline"
          size="tag"
          className={
            guidelines.allowMerge
              ? "bg-status-success/15 text-status-success border-status-success/30"
              : "bg-status-error/15 text-status-error border-status-error/30"
          }
        >
          {guidelines.allowMerge ? "Merge allowed" : "Merge not allowed"}
        </Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {sections.map((section) => (
          <Card key={section.title}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                {section.icon}
                {section.title}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {section.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">None configured</p>
              ) : (
                <ul className="space-y-2">
                  {section.items.map((item, i) => (
                    <li key={i} className="text-sm">
                      <Streamdown>{item}</Streamdown>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function detectProvider(url: string): "github" | "gitlab" | null {
  if (url.includes("gitlab.com") || url.includes("gitlab.")) return "gitlab";
  if (url.includes("github.com")) return "github";
  return null;
}

export default function RepoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: repo, isLoading } = useRepo(id!);
  const updateRepo = useUpdateRepo();
  const deleteRepo = useDeleteRepo();
  const [editOpen, setEditOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-4 p-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!repo) {
    return <p className="text-muted-foreground">Repository not found.</p>;
  }

  const provider = detectProvider(repo.url);

  function handleEditSubmit(data: RepoFormData) {
    updateRepo.mutate({ id: repo!.id, data });
  }

  function handleDelete() {
    deleteRepo.mutate(repo!.id, { onSuccess: () => navigate("/settings/repos") });
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-auto gap-4">
      <button
        type="button"
        onClick={() => navigate("/settings/repos")}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground w-fit"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Repos
      </button>

      <PageHeader
        className="shrink-0"
        title={
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="text-xl font-semibold">{repo.name}</h1>
            {provider && (
              <Badge variant="outline" size="tag">
                {provider}
              </Badge>
            )}
            <Badge
              variant="outline"
              size="tag"
              className={
                repo.autoClone
                  ? "bg-status-success/15 text-status-success border-status-success/30"
                  : ""
              }
            >
              {repo.autoClone ? "Auto-clone ON" : "Auto-clone OFF"}
            </Badge>
            <Badge
              variant="outline"
              size="tag"
              className={
                repo.hooks.enabled
                  ? "bg-status-success/15 text-status-success border-status-success/30"
                  : ""
              }
            >
              {repo.hooks.enabled ? "Hooks ON" : "Hooks OFF"}
            </Badge>
          </div>
        }
        action={
          <>
            <Button size="sm" variant="outline" className="gap-1" onClick={() => setEditOpen(true)}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="destructive-outline" className="gap-1">
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Repository</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to delete <strong>{repo.name}</strong>? This action cannot
                    be undone.
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
          </>
        }
      />

      <DetailPageBody
        main={
          repo.guidelines ? (
            <GuidelinesSection guidelines={repo.guidelines} />
          ) : (
            <Card>
              <CardContent className="py-8 flex flex-col items-center text-muted-foreground">
                <X className="h-6 w-6 mb-2 opacity-40" />
                <p className="text-sm">No guidelines configured for this repository.</p>
              </CardContent>
            </Card>
          )
        }
        rail={
          <DetailPageRail>
            <QuickStats>
              <QuickStat
                label="URL"
                value={
                  <a
                    href={repo.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    <span className="truncate">{repo.url}</span>
                    <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
                  </a>
                }
              />
              <QuickStat label="Clone Path" value={repo.clonePath} mono />
              <QuickStat
                label="Default Branch"
                value={
                  <span className="inline-flex items-center gap-1">
                    <GitBranch className="h-3 w-3" /> {repo.defaultBranch}
                  </span>
                }
              />
              <QuickStat label="Created" value={formatSmartTime(repo.createdAt)} />
              <QuickStat label="Auto-clone" value={repo.autoClone ? "Enabled" : "Disabled"} />
              <QuickStat label="Git Hooks" value={repo.hooks.enabled ? "Enabled" : "Disabled"} />
            </QuickStats>
          </DetailPageRail>
        }
      />

      <RepoEditDialog
        key={repo.id}
        open={editOpen}
        onOpenChange={setEditOpen}
        repo={repo}
        onSubmit={handleEditSubmit}
      />
    </div>
  );
}
