import { ArrowLeft, Maximize2, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { useDeleteSkill, useSkill, useUpdateSkill } from "@/api/hooks";
import { MarkdownEditor } from "@/components/shared/markdown-editor";
import { MarkdownView } from "@/components/shared/markdown-view";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Card, CardContent } from "@/components/ui/card";
import {
  DetailPageBody,
  DetailPageRail,
  DetailPageSection,
  QuickStat,
  QuickStats,
  Relationship,
  Relationships,
} from "@/components/ui/detail-page-layout";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelativeTime } from "@/lib/utils";

/**
 * Split a SKILL.md into its YAML frontmatter block and the markdown body.
 * The API rejects skill content without frontmatter, so every skill has one —
 * and rendering it as markdown would garble it (`---` becomes a rule and the
 * `description:` line becomes a setext heading), so it's surfaced separately.
 */
function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { frontmatter: null, body: content };
  return { frontmatter: match[1], body: content.slice(match[0].length) };
}

interface FrontmatterEntry {
  key: string;
  value: string;
  /** Indent level, so `metadata: { type: … }` nests under its parent. */
  depth: number;
}

/**
 * Flatten skill frontmatter into displayable key/value rows. Deliberately not a
 * YAML parser — skill frontmatter is a shallow `key: value` map (plus the odd
 * one-level `metadata:` block), and pulling in a parser to render a sidebar
 * would be the wrong trade. Anything that doesn't look like `key: value`
 * (list items, folded scalars) falls back to a valueless row so nothing is
 * silently dropped.
 */
function parseFrontmatter(yaml: string): FrontmatterEntry[] {
  const entries: FrontmatterEntry[] = [];
  for (const rawLine of yaml.split("\n")) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    const separator = line.indexOf(":");
    if (separator === -1) {
      entries.push({ key: line, value: "", depth: indent > 0 ? 1 : 0 });
      continue;
    }
    entries.push({
      key: line.slice(0, separator).trim(),
      // Strip matching wrapper quotes — `description: "…"` reads better bare.
      value: line
        .slice(separator + 1)
        .trim()
        .replace(/^(["'])([\s\S]*)\1$/, "$2"),
      depth: indent > 0 ? 1 : 0,
    });
  }
  return entries;
}

export default function SkillDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: skill, isLoading } = useSkill(id!);
  const updateSkill = useUpdateSkill();
  const deleteSkill = useDeleteSkill();
  const [editContent, setEditContent] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);

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

  // Frontmatter lives in the rail; only the markdown body goes in the card.
  const { frontmatter, body } = splitFrontmatter(skill.content ?? "");
  const frontmatterEntries = frontmatter ? parseFrontmatter(frontmatter) : [];

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
            {skill.systemDefault && (
              <Badge
                variant="outline"
                size="tag"
                className="border-status-info/30 text-status-info inline-flex items-center gap-1"
              >
                <ShieldCheck className="h-3 w-3" />
                System Default
              </Badge>
            )}
          </div>
        }
        action={
          <>
            <Button variant="outline" size="sm" onClick={handleToggleEnabled}>
              {skill.isEnabled ? "Disable" : "Enable"}
            </Button>
            {!skill.systemDefault && (
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
            )}
          </>
        }
      />

      <p className="text-sm text-muted-foreground shrink-0">{skill.description}</p>
      {skill.systemDefault && (
        <Alert className="shrink-0 border-status-info/30 bg-status-info/5">
          <AlertDescription>
            This skill is system-managed and re-seeded on each start. Fork it under a new name to
            customize its content.
          </AlertDescription>
        </Alert>
      )}

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
                <div className="flex gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="size-8"
                        onClick={() => setIsReading(true)}
                        disabled={!body.trim()}
                        aria-label="Read full screen"
                      >
                        <Maximize2 className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Read full screen</TooltipContent>
                  </Tooltip>
                  {!skill.systemDefault && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditContent(skill.content)}
                    >
                      Edit
                    </Button>
                  )}
                </div>
              )}
            </div>
            {editContent !== null ? (
              <MarkdownEditor
                value={editContent}
                onChange={setEditContent}
                className="flex-1 min-h-[320px]"
              />
            ) : (
              <Card className="flex-1 min-h-0 overflow-hidden py-0">
                <CardContent className="prose-doc h-full overflow-auto px-4 py-4">
                  {body.trim() ? (
                    <MarkdownView text={body} normalizeSoftBreaks={false} />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      This skill has no content below its frontmatter.
                    </p>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        }
        rail={
          <DetailPageRail>
            {frontmatterEntries.length > 0 && (
              <DetailPageSection title="Frontmatter">
                <dl className="flex flex-col gap-2">
                  {frontmatterEntries.map((entry) => (
                    <div
                      key={`${entry.depth}:${entry.key}`}
                      className={entry.depth > 0 ? "pl-3 border-l border-border" : undefined}
                    >
                      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        {entry.key}
                      </dt>
                      {entry.value && (
                        <dd className="text-xs text-foreground break-words">{entry.value}</dd>
                      )}
                    </div>
                  ))}
                </dl>
              </DetailPageSection>
            )}

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
              <QuickStat label="System Default" value={skill.systemDefault ? "Yes" : "No"} />
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

      {/* Focus-read view: the page chrome drops away and the body is measured
          to a comfortable reading column rather than stretched to the viewport. */}
      <Dialog open={isReading} onOpenChange={setIsReading}>
        <DialogContent
          showCloseButton
          className="flex h-[92vh] w-[96vw] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        >
          <div className="flex shrink-0 items-center gap-3 border-b px-6 py-3">
            <DialogTitle className="truncate text-sm font-semibold">{skill.name}</DialogTitle>
            <span className="truncate text-xs text-muted-foreground">SKILL.md</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-6 py-8">
            <div className="prose-doc mx-auto max-w-[72ch] text-[0.95rem] leading-[1.75]">
              <MarkdownView text={body} normalizeSoftBreaks={false} />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
