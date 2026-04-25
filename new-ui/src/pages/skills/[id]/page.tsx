import { ArrowLeft, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { useDeleteSkill, useSkill, useUpdateSkill } from "@/api/hooks";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { formatRelativeTime } from "@/lib/utils";

export default function SkillDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: skill, isLoading } = useSkill(id!);
  const updateSkill = useUpdateSkill();
  const deleteSkill = useDeleteSkill();
  const [editContent, setEditContent] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!skill) {
    return <p className="text-muted-foreground">Skill not found.</p>;
  }

  const handleSaveContent = () => {
    if (editContent !== null) {
      updateSkill.mutate(
        { id: skill.id, data: { content: editContent } },
        { onSuccess: () => setEditContent(null) },
      );
    }
  };

  const handleToggleEnabled = () => {
    updateSkill.mutate({ id: skill.id, data: { isEnabled: !skill.isEnabled } });
  };

  const handleDelete = () => {
    deleteSkill.mutate(skill.id, { onSuccess: () => navigate("/skills") });
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden gap-3">
      <button
        type="button"
        onClick={() => navigate("/skills")}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground w-fit"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Skills
      </button>

      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">{skill.name}</h1>
          <Badge variant="outline" size="tag">
            {skill.type}
          </Badge>
          <Badge
            variant="outline"
            size="tag"
            className={`${
              skill.scope === "global"
                ? "border-emerald-500/30 text-emerald-400"
                : skill.scope === "swarm"
                  ? "border-amber-500/30 text-amber-400"
                  : ""
            }`}
          >
            {skill.scope}
          </Badge>
          <Badge
            variant="outline"
            size="tag"
            className={`${
              skill.isEnabled
                ? "border-emerald-500/30 text-emerald-400"
                : "border-red-500/30 text-red-400"
            }`}
          >
            {skill.isEnabled ? "Enabled" : "Disabled"}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleToggleEnabled}>
            {skill.isEnabled ? "Disable" : "Enable"}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive-outline" size="sm">
                <Trash2 className="h-4 w-4 mr-1" /> Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete skill "{skill.name}"?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete this skill and uninstall it from all agents.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <p className="text-sm text-muted-foreground shrink-0">{skill.description}</p>

      <Tabs defaultValue="content" className="flex flex-col flex-1 min-h-0">
        <TabsList className="shrink-0">
          <TabsTrigger value="content">Content</TabsTrigger>
          <TabsTrigger value="metadata">Metadata</TabsTrigger>
        </TabsList>

        <TabsContent value="content" className="flex flex-col flex-1 min-h-0 mt-4 gap-3">
          <div className="flex items-center justify-between shrink-0">
            <span className="text-sm text-muted-foreground">SKILL.md content</span>
            {editContent !== null ? (
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setEditContent(null)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSaveContent} disabled={updateSkill.isPending}>
                  Save
                </Button>
              </div>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setEditContent(skill.content)}>
                Edit
              </Button>
            )}
          </div>
          {editContent !== null ? (
            <Textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="flex-1 min-h-[300px] font-mono text-sm"
            />
          ) : (
            <pre className="flex-1 overflow-auto bg-muted p-4 rounded-lg text-sm font-mono whitespace-pre-wrap">
              {skill.content || "(empty)"}
            </pre>
          )}
        </TabsContent>

        <TabsContent value="metadata" className="mt-4 overflow-y-auto">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Details</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">ID</span>
                <p className="font-mono text-xs">{skill.id}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Version</span>
                <p>{skill.version}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Created</span>
                <p>{formatRelativeTime(skill.createdAt)}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Last Updated</span>
                <p>{formatRelativeTime(skill.lastUpdatedAt)}</p>
              </div>
              {skill.lastFetchedAt && (
                <div>
                  <span className="text-muted-foreground">Last Fetched</span>
                  <p>{formatRelativeTime(skill.lastFetchedAt)}</p>
                </div>
              )}
              {skill.ownerAgentId && (
                <div>
                  <span className="text-muted-foreground">Owner Agent</span>
                  <p className="font-mono text-xs">{skill.ownerAgentId}</p>
                </div>
              )}
              {skill.sourceRepo && (
                <>
                  <div>
                    <span className="text-muted-foreground">Source Repo</span>
                    <p>{skill.sourceRepo}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Source Path</span>
                    <p>{skill.sourcePath || "/"}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Branch</span>
                    <p>{skill.sourceBranch}</p>
                  </div>
                </>
              )}
              {skill.allowedTools && (
                <div>
                  <span className="text-muted-foreground">Allowed Tools</span>
                  <p>{skill.allowedTools}</p>
                </div>
              )}
              {skill.model && (
                <div>
                  <span className="text-muted-foreground">Model</span>
                  <p>{skill.model}</p>
                </div>
              )}
              <div>
                <span className="text-muted-foreground">Complex</span>
                <p>{skill.isComplex ? "Yes" : "No"}</p>
              </div>
              <div>
                <span className="text-muted-foreground">User Invocable</span>
                <p>{skill.userInvocable ? "Yes" : "No"}</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
