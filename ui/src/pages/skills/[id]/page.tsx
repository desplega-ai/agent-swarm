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
import {
  DetailPageBody,
  DetailPageRail,
  QuickStat,
  QuickStats,
  Relationship,
  Relationships,
} from "@/components/ui/detail-page-layout";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
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

      <PageHeader
        className="shrink-0"
        title={
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="text-xl font-semibold">{skill.name}</h1>
            <Badge variant="outline" size="tag">
              {skill.type}
            </Badge>
            <Badge
              variant="outline"
              size="tag"
              className={`${
                skill.scope === "global"
                  ? "border-status-success/30 text-status-success"
                  : skill.scope === "swarm"
                    ? "border-status-active/30 text-status-active"
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
                  ? "border-status-success/30 text-status-success"
                  : "border-status-error/30 text-status-error"
              }`}
            >
              {skill.isEnabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
        }
        action={
          <>
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
          </>
        }
      />

      <p className="text-sm text-muted-foreground shrink-0">{skill.description}</p>

      <DetailPageBody
        className="flex-1 min-h-0"
        main={
          <div className="flex flex-col flex-1 min-h-0 gap-3">
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
          </div>
        }
        rail={
          <DetailPageRail>
            <QuickStats>
              <QuickStat label="ID" value={skill.id} mono />
              <QuickStat label="Version" value={skill.version} />
              <QuickStat label="Created" value={formatRelativeTime(skill.createdAt)} />
              <QuickStat label="Last Updated" value={formatRelativeTime(skill.lastUpdatedAt)} />
              {skill.lastFetchedAt && (
                <QuickStat label="Last Fetched" value={formatRelativeTime(skill.lastFetchedAt)} />
              )}
              {skill.model && <QuickStat label="Model" value={skill.model} mono />}
              {skill.allowedTools && <QuickStat label="Allowed Tools" value={skill.allowedTools} />}
              <QuickStat label="Complex" value={skill.isComplex ? "Yes" : "No"} />
              <QuickStat label="User Invocable" value={skill.userInvocable ? "Yes" : "No"} />
            </QuickStats>

            {(skill.ownerAgentId || skill.sourceRepo) && (
              <Relationships>
                {skill.ownerAgentId && (
                  <Relationship label="Owner Agent" to={`/agents/${skill.ownerAgentId}`}>
                    <span className="font-mono">{skill.ownerAgentId.slice(0, 8)}…</span>
                  </Relationship>
                )}
                {skill.sourceRepo && (
                  <Relationship label="Source">
                    <span className="font-mono text-[11px] truncate">
                      {skill.sourceRepo}
                      {skill.sourcePath && skill.sourcePath !== "/" ? ` · ${skill.sourcePath}` : ""}
                      {skill.sourceBranch ? ` @ ${skill.sourceBranch}` : ""}
                    </span>
                  </Relationship>
                )}
              </Relationships>
            )}
          </DetailPageRail>
        }
      />
    </div>
  );
}
