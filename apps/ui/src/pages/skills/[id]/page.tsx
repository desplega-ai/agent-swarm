import { ArrowLeft, FolderTree, Maximize2, Power, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { useDeleteSkill, useSkill, useSkillFile, useSkillFiles, useUpdateSkill } from "@/api/hooks";
import { MarkdownEditor } from "@/components/shared/markdown-editor";
import { MarkdownView, MonacoCodeBlock } from "@/components/shared/markdown-view";
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
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useIsMobile } from "@/hooks/use-mobile";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { formatRelativeTime } from "@/lib/utils";
import { ClampedDescription, ConfirmDialog, OverflowMenu } from "../components/phone-detail";
import { SkillUsagePanel } from "../components/skill-usage-panel";
import {
  formatCount,
  formatLocalDateTime,
  readUsageWindow,
  UsageWindowControl,
} from "../components/usage-shared";

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
  const { searchParams, setParam } = useUrlSearchState();
  const isMobile = useIsMobile();
  // Below lg the page flows in `<main>`'s scroll and the rail (frontmatter,
  // stats, owner) becomes a third tab. Stacked under a 30k-character SKILL.md
  // it would sit thousands of pixels down.
  const stacked = useMediaQuery("(max-width: 1023px)");
  const tabParam = readStringParam(searchParams, "tab", "content");
  const activeTab =
    tabParam === "usage" ? "usage" : tabParam === "details" && stacked ? "details" : "content";
  const usageWindow = readUsageWindow(searchParams);
  const { data: skill, isLoading } = useSkill(id!);
  const updateSkill = useUpdateSkill();
  const deleteSkill = useDeleteSkill();
  const [editContent, setEditContent] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // "" = the SKILL.md itself; any other value is a bundled-file path.
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const { data: skillFiles = [] } = useSkillFiles(id!);
  const { data: selectedFile, isLoading: isFileLoading } = useSkillFile(
    id!,
    selectedFilePath || null,
  );

  // The component stays mounted across /skills/:id navigations — drop any
  // bundled-file selection that belongs to the previous skill (state-adjust
  // during render instead of an effect, per the React docs pattern).
  const [lastSkillId, setLastSkillId] = useState(id);
  if (lastSkillId !== id) {
    setLastSkillId(id);
    setSelectedFilePath("");
  }

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

  const viewingFile = selectedFilePath !== "";
  const isMarkdownFile = selectedFilePath.endsWith(".md");
  // Monaco language from the file extension; `.tmpl` wrappers defer to the
  // inner extension (bash.sh.tmpl → sh). MonacoCodeBlock aliases sh → shell etc.
  const fileLanguage =
    selectedFilePath
      .replace(/\.tmpl$/, "")
      .split(".")
      .pop()
      ?.toLowerCase() ?? "";
  const readableText = viewingFile
    ? selectedFile && !selectedFile.isBinary
      ? selectedFile.content
      : ""
    : body;

  const complexIcon = skill.isComplex ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <FolderTree className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Complex skill" />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Complex skill — ships bundled files alongside SKILL.md. Use the file selector below to
        browse them.
      </TooltipContent>
    </Tooltip>
  ) : null;

  const badges = (
    <>
      <Badge variant="outline" size="tag">
        {skill.type}
      </Badge>
      <Badge
        variant="outline"
        size="tag"
        className={`${
          skill.scope === "global"
            ? "border-status-success/30 text-status-success-strong"
            : skill.scope === "swarm"
              ? "border-status-active/30 text-status-active-strong"
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
            ? "border-status-success/30 text-status-success-strong"
            : "border-status-error/30 text-status-error-strong"
        }`}
      >
        {skill.isEnabled ? "Enabled" : "Disabled"}
      </Badge>
      {skill.systemDefault && (
        <Badge
          variant="outline"
          size="tag"
          className="border-status-info/30 text-status-info-strong inline-flex items-center gap-1"
        >
          <ShieldCheck className="h-3 w-3" />
          System Default
        </Badge>
      )}
    </>
  );

  const actions = (
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
  );

  const railContent = (
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
        <QuickStat label="Uses (all time)" value={formatCount(skill.invocationCount ?? 0)} />
        <QuickStat
          label="Last Used"
          value={
            skill.lastInvokedAt ? (
              <span title={formatLocalDateTime(skill.lastInvokedAt)}>
                {formatRelativeTime(skill.lastInvokedAt)}
              </span>
            ) : (
              "Never"
            )
          }
        />
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
  );

  // The system-managed note. Desktop keeps it as an alert under the header; a
  // phone gets a bare one-liner in the Content tab (the System Default chip
  // already says it, this adds what to do about it).
  const systemNote = skill.systemDefault ? (
    isMobile ? (
      <p className="flex shrink-0 items-start gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="mt-px size-3.5 shrink-0 text-status-info-strong" />
        System-managed, re-seeded on each start. Fork it under a new name to edit.
      </p>
    ) : (
      <Alert className="shrink-0 border-status-info/30 bg-status-info/5">
        <AlertDescription>
          This skill is system-managed and re-seeded on each start. Fork it under a new name to
          customize its content.
        </AlertDescription>
      </Alert>
    )
  ) : null;

  // The reader's buttons. Desktop shows them in the toolbar over the card; a
  // phone puts them at the right end of the sticky tab row, so they stay under
  // the thumb however far the document has scrolled.
  const readerActions =
    editContent !== null ? (
      <div className="flex shrink-0 gap-2">
        <Button
          variant="outline"
          size="sm"
          className="max-lg:h-9"
          onClick={() => setEditContent(null)}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="max-lg:h-9"
          onClick={handleSaveContent}
          disabled={updateSkill.isPending}
        >
          Save
        </Button>
      </div>
    ) : (
      <div className="flex shrink-0 gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="size-8 max-lg:size-9"
              onClick={() => setIsReading(true)}
              disabled={!readableText.trim()}
              aria-label="Read full screen"
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Read full screen</TooltipContent>
        </Tooltip>
        {!skill.systemDefault && !viewingFile && (
          <Button
            variant="outline"
            size="sm"
            className="max-lg:h-9"
            onClick={() => setEditContent(skill.content)}
          >
            Edit
          </Button>
        )}
      </div>
    );

  const phoneActions = [
    {
      key: "toggle",
      label: skill.isEnabled ? "Disable skill" : "Enable skill",
      icon: <Power className="size-4" />,
      onSelect: handleToggleEnabled,
    },
    ...(skill.systemDefault
      ? []
      : [
          {
            key: "delete",
            label: "Delete skill",
            icon: <Trash2 className="size-4" />,
            destructive: true,
            onSelect: () => setConfirmingDelete(true),
          },
        ]),
  ];

  const tabsList = (
    <TabsList className="shrink-0 max-lg:h-10">
      <TabsTrigger value="content">Content</TabsTrigger>
      <TabsTrigger value="usage">Usage</TabsTrigger>
      {stacked ? <TabsTrigger value="details">Details</TabsTrigger> : null}
    </TabsList>
  );

  return (
    // Below lg `<main>` is the scroll container, so the page flows (max-lg:flex-none,
    // no overflow clip) and the SKILL.md viewer scrolls with it. From lg up the page
    // keeps its pinned layout with the viewer scrolling inside the card.
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden gap-3 max-lg:flex-none max-lg:overflow-visible max-md:gap-2">
      {isMobile ? (
        // Phone header, three rows at most: back + name + overflow menu, one row
        // of status chips, and a two-line description. In the old single row the
        // name column was ~100px wide and the chips drew over the buttons.
        <div className="flex shrink-0 flex-col gap-2">
          <div className="flex min-w-0 items-start gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="-ml-2.5 shrink-0"
              aria-label="Back to Skills"
              onClick={() => navigate("/skills")}
            >
              <ArrowLeft className="size-5" />
            </Button>
            <h1 className="flex min-h-9 min-w-0 flex-1 items-center gap-2 text-xl leading-tight font-semibold [overflow-wrap:anywhere]">
              <span className="min-w-0">{skill.name}</span>
              {complexIcon}
            </h1>
            <OverflowMenu actions={phoneActions} label="Skill actions" />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">{badges}</div>
          <ClampedDescription text={skill.description} />
          <ConfirmDialog
            open={confirmingDelete}
            onOpenChange={setConfirmingDelete}
            title={`Delete skill "${skill.name}"?`}
            description="This will permanently delete this skill and uninstall it from all agents."
            onConfirm={handleDelete}
          />
        </div>
      ) : (
        <>
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
                {complexIcon}
                {badges}
              </div>
            }
            action={actions}
          />
          <ClampedDescription text={skill.description} className="shrink-0" />
          {systemNote}
        </>
      )}

      <DetailPageBody
        className="flex-1 min-h-0 max-lg:flex-none"
        main={
          <Tabs
            value={activeTab}
            onValueChange={(value) => setParam("tab", value, { defaultValue: "content" })}
            className="flex flex-col flex-1 min-h-0 gap-3 max-lg:flex-none max-md:gap-2"
          >
            {stacked ? (
              // Sticky: the tabs and the reader's buttons stay on screen while
              // a long SKILL.md scrolls under them. The negative margin lets the
              // bar reach the edges of `<main>`, so text never peeks beside it.
              <div className="sticky top-0 z-20 -mx-4 flex items-center justify-between gap-2 border-b border-border-subtle bg-background px-4 py-2 md:-mx-6 md:px-6">
                {tabsList}
                {activeTab === "content" ? readerActions : null}
                {activeTab === "usage" ? (
                  <UsageWindowControl
                    size={isMobile ? "default" : "sm"}
                    value={usageWindow}
                    onChange={(value) => setParam("window", value, { defaultValue: "30d" })}
                  />
                ) : null}
              </div>
            ) : (
              tabsList
            )}
            <TabsContent
              value="content"
              className="flex flex-col flex-1 min-h-0 gap-3 max-lg:flex-none max-md:gap-2"
            >
              {isMobile ? systemNote : null}
              {skillFiles.length > 0 || !stacked ? (
                <div className="flex items-center justify-between gap-2 shrink-0">
                  {skillFiles.length > 0 ? (
                    <SearchableSelect
                      value={selectedFilePath}
                      onChange={setSelectedFilePath}
                      // The editor stays bound to SKILL.md while editing (Edit is
                      // only offered on SKILL.md), so switching files mid-edit
                      // would show a bundled file's path over SKILL.md's content
                      // and Save would silently overwrite SKILL.md.
                      disabled={editContent !== null}
                      options={[
                        { value: "", label: `${skill.name}/SKILL.md` },
                        ...skillFiles.map((file) => ({
                          value: file.path,
                          label: `${skill.name}/${file.path}`,
                          hint: file.isBinary ? "binary" : undefined,
                        })),
                      ]}
                      searchPlaceholder="Search files…"
                      // Phone: the picker takes the whole row (the buttons live in
                      // the sticky bar), instead of a fixed 220px floor.
                      triggerClassName="h-8 min-w-0 flex-1 px-2.5 text-sm text-muted-foreground max-lg:h-9 lg:w-auto lg:min-w-[220px] lg:max-w-[480px] lg:flex-none"
                      contentClassName="w-auto min-w-[320px] max-w-[calc(100vw-1.5rem)]"
                    />
                  ) : (
                    <span className="text-sm text-muted-foreground">SKILL.md content</span>
                  )}
                  {stacked ? null : readerActions}
                </div>
              ) : null}
              {editContent !== null ? (
                <MarkdownEditor
                  value={editContent}
                  onChange={setEditContent}
                  className="flex-1 min-h-[320px] max-lg:flex-none max-lg:h-[65dvh]"
                />
              ) : (
                // Phone and tablet: no card chrome, so the text runs the full
                // width of the page. From lg up it stays a card that scrolls inside.
                <Card className="flex-1 min-h-0 overflow-hidden py-0 max-lg:flex-none max-lg:overflow-visible max-lg:rounded-none max-lg:border-0 max-lg:bg-transparent max-lg:shadow-none">
                  <CardContent className="prose-doc h-full overflow-auto px-4 py-4 max-lg:h-auto max-lg:overflow-x-auto max-lg:overflow-y-visible max-lg:px-0 max-lg:pt-1">
                    {viewingFile ? (
                      isFileLoading ? (
                        <Skeleton className="h-32 w-full" />
                      ) : !selectedFile ? (
                        <p className="text-sm text-muted-foreground">File not found.</p>
                      ) : selectedFile.isBinary ? (
                        <p className="text-sm text-muted-foreground">
                          Binary file ({selectedFile.mimeType}
                          {selectedFile.size != null ? `, ${selectedFile.size} bytes` : ""}) — not
                          rendered.
                        </p>
                      ) : isMarkdownFile ? (
                        <MarkdownView text={selectedFile.content} normalizeSoftBreaks={false} />
                      ) : (
                        // `fill` needs a definite height: the card has one from lg up,
                        // a flowing phone page does not, so it gets a viewport-sized box.
                        <div className="h-full max-lg:h-[70dvh]">
                          <MonacoCodeBlock
                            language={fileLanguage}
                            value={selectedFile.content}
                            fill
                          />
                        </div>
                      )
                    ) : body.trim() ? (
                      <MarkdownView text={body} normalizeSoftBreaks={false} />
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        This skill has no content below its frontmatter.
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}
            </TabsContent>
            <TabsContent
              value="usage"
              className="flex-1 min-h-0 overflow-y-auto max-lg:flex-none max-lg:overflow-visible"
            >
              <SkillUsagePanel
                skillId={skill.id}
                window={usageWindow}
                onWindowChange={(value) => setParam("window", value, { defaultValue: "30d" })}
                compact={stacked}
              />
            </TabsContent>
            {stacked ? (
              <TabsContent value="details" className="pb-4">
                {railContent}
              </TabsContent>
            ) : null}
          </Tabs>
        }
        rail={stacked ? undefined : railContent}
      />

      {/* Focus-read view: the page chrome drops away and the body is measured
          to a comfortable reading column rather than stretched to the viewport. */}
      <Dialog open={isReading} onOpenChange={setIsReading}>
        <DialogContent
          showCloseButton
          className="flex h-[92vh] w-[96vw] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        >
          <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3 pr-12 md:px-6">
            <DialogTitle className="truncate text-sm font-semibold">{skill.name}</DialogTitle>
            <span className="truncate text-xs text-muted-foreground max-md:hidden">
              {skill.name}/{viewingFile ? selectedFilePath : "SKILL.md"}
            </span>
          </div>
          {viewingFile && !isMarkdownFile ? (
            // Code gets the full width and a definite height, so Monaco can
            // scroll a wrapped or minified line instead of clipping it.
            <div className="min-h-0 flex-1 overflow-hidden px-3 py-3 md:px-6 md:py-6">
              <MonacoCodeBlock language={fileLanguage} value={readableText} fill />
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto px-4 py-5 md:px-6 md:py-8">
              <div className="prose-doc mx-auto max-w-[72ch] text-[0.95rem] leading-[1.75]">
                <MarkdownView text={readableText} normalizeSoftBreaks={false} />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
