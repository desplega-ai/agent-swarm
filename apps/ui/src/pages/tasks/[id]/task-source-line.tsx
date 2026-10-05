import {
  Bot,
  CalendarClock,
  Check,
  CircleDot,
  Code,
  Cog,
  Copy,
  type LucideIcon,
  Mail,
  MessagesSquare,
  Monitor,
  Workflow,
} from "lucide-react";
import { Fragment, type ReactNode, useId, useMemo } from "react";
import { Link } from "react-router-dom";
import type { AgentTask } from "@/api/types";
import { BrandLogo } from "@/components/shared/brand-logo";
import { MarkdownView } from "@/components/shared/markdown-view";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { formatSlackMentions, parseSlackPrompt, type SlackPrompt } from "@/lib/slack-text";
import { cn } from "@/lib/utils";
import { taskSourceLabel } from "./task-details-rail";
import { NARROW_INLINE_TARGET, NARROW_TARGET } from "./touch-targets";

type SourceTask = Pick<
  AgentTask,
  | "task"
  | "source"
  | "scheduleId"
  | "workflowRunId"
  | "vcsProvider"
  | "vcsRepo"
  | "vcsUrl"
  | "vcsNumber"
  | "vcsEventType"
>;

/** Monochrome marks in `public/integration-logos/`. */
const SOURCE_LOGOS: Record<string, string> = {
  slack: "/integration-logos/slack.svg",
  github: "/integration-logos/github.svg",
  gitlab: "/integration-logos/gitlab.svg",
  linear: "/integration-logos/linear.svg",
  jira: "/integration-logos/jira.svg",
};

/** Icons for the sources that have no brand mark. */
const SOURCE_ICONS: Record<string, LucideIcon> = {
  agentmail: Mail,
  api: Code,
  comb: MessagesSquare,
  mcp: Bot,
  schedule: CalendarClock,
  system: Cog,
  ui: Monitor,
  workflow: Workflow,
};

const LINK_CLASS = "text-primary hover:underline";
/** A short link in the line: 44 px tall in the narrow layout. */
const TARGET_LINK_CLASS = cn(LINK_CLASS, NARROW_INLINE_TARGET);

/**
 * A name in the source line ("Taras"), one step stronger than the line. It
 * truncates when the narrow layout's one-row line runs out of room.
 */
function Who({ children }: { children: ReactNode }) {
  return <span className="min-w-0 truncate font-medium text-foreground">{children}</span>;
}

function SourceMark({ source }: { source: string }) {
  const logo = SOURCE_LOGOS[source];
  if (logo) return <BrandLogo src={logo} className="size-3.5" />;
  const Icon = SOURCE_ICONS[source] ?? CircleDot;
  return <Icon aria-hidden className="size-3.5 shrink-0" />;
}

/** "PR", "MR" or "Issue" for a VCS event type. Empty when unknown. */
function vcsKind(eventType: string | undefined): string {
  if (!eventType) return "";
  if (eventType.startsWith("pull_request")) return "PR";
  if (eventType.startsWith("merge_request")) return "MR";
  if (eventType.startsWith("issue")) return "Issue";
  return "";
}

interface SourceView {
  /** The first visible part of the line. */
  lead: ReactNode;
  /**
   * Whether `lead` names the source. When it does not (a speaker, a PR
   * link), screen readers get the source name before it: the mark is
   * decorative.
   */
  named: boolean;
  /**
   * Whether `lead` can shorten (a name or a repo truncates). A short link or
   * label keeps its width.
   */
  shrinks: boolean;
  /** Further parts, separated by dots. */
  extras: { key: string; node: ReactNode }[];
}

function describeSource(
  task: SourceTask,
  source: string,
  prompt: SlackPrompt,
  names: { requestedBy: string | null; creator: string | null },
): SourceView {
  const label = taskSourceLabel(source);
  switch (source) {
    case "slack": {
      const speaker = prompt.speaker ?? names.requestedBy;
      const count = prompt.thread.length;
      const extras =
        count > 0
          ? [
              {
                key: "thread",
                node: (
                  <span className="shrink-0 whitespace-nowrap">
                    {count} earlier {count === 1 ? "message" : "messages"}
                  </span>
                ),
              },
            ]
          : [];
      return speaker
        ? { lead: <Who>{speaker}</Who>, named: false, shrinks: true, extras }
        : { lead: label, named: true, shrinks: false, extras };
    }
    case "github":
    case "gitlab": {
      const kind = vcsKind(task.vcsEventType);
      const repo = task.vcsRepo ? (
        <span className="min-w-0 truncate" title={task.vcsRepo}>
          {task.vcsRepo}
        </span>
      ) : null;
      if (task.vcsUrl && task.vcsNumber) {
        return {
          lead: (
            <a
              href={task.vcsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn("font-medium", TARGET_LINK_CLASS)}
            >
              {kind ? `${kind} ` : ""}#{task.vcsNumber}
            </a>
          ),
          named: false,
          shrinks: false,
          extras: repo ? [{ key: "repo", node: repo }] : [],
        };
      }
      if (task.vcsUrl && task.vcsRepo) {
        return {
          lead: (
            <a
              href={task.vcsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "min-w-0 truncate",
                LINK_CLASS,
                NARROW_TARGET,
                "@max-[64rem]:leading-11",
              )}
            >
              {task.vcsRepo}
            </a>
          ),
          named: false,
          shrinks: true,
          extras: [],
        };
      }
      return repo
        ? { lead: repo, named: false, shrinks: true, extras: [] }
        : { lead: label, named: true, shrinks: false, extras: [] };
    }
    case "ui":
      return {
        lead: names.requestedBy ? (
          <span className="min-w-0 truncate">
            <Who>{names.requestedBy}</Who> in the dashboard
          </span>
        ) : (
          label
        ),
        named: true,
        shrinks: !!names.requestedBy,
        extras: [],
      };
    case "api":
      return {
        lead: names.requestedBy ? (
          <span className="min-w-0 truncate">
            <Who>{names.requestedBy}</Who> via the API
          </span>
        ) : (
          label
        ),
        named: true,
        shrinks: !!names.requestedBy,
        extras: [],
      };
    case "mcp":
      return {
        lead: names.creator ? (
          <span className="min-w-0 truncate">
            Delegated by <Who>{names.creator}</Who>
          </span>
        ) : (
          label
        ),
        named: true,
        shrinks: !!names.creator,
        extras: [],
      };
    case "schedule":
      return {
        lead: task.scheduleId ? (
          <Link to={`/schedules/${task.scheduleId}`} className={TARGET_LINK_CLASS}>
            {label}
          </Link>
        ) : (
          label
        ),
        named: true,
        shrinks: false,
        extras: [],
      };
    case "workflow":
      return {
        lead: task.workflowRunId ? (
          <Link to={`/workflow-runs/${task.workflowRunId}`} className={TARGET_LINK_CLASS}>
            Workflow run
          </Link>
        ) : (
          label
        ),
        named: true,
        shrinks: false,
        extras: [],
      };
    default:
      return { lead: label, named: true, shrinks: false, extras: [] };
  }
}

function Dot() {
  return (
    <span aria-hidden className="shrink-0">
      ·
    </span>
  );
}

/**
 * The full prompt in a dialog: the earlier Slack thread messages as quotes,
 * then the ask as markdown. Mention tokens read as names. "Copy prompt"
 * copies the prompt exactly as stored.
 */
function TaskPromptDialog({
  task,
  prompt,
  description,
}: {
  task: SourceTask;
  prompt: SlackPrompt;
  description: string;
}) {
  const { copied, copy } = useCopyToClipboard();
  const threadHeadingId = useId();
  const askHeadingId = useId();
  // A prompt that is only a thread block has no ask: show the whole prompt.
  const ask = formatSlackMentions(prompt.ask).trim() || formatSlackMentions(task.task).trim();
  const hasThread = prompt.thread.length > 0;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className={cn(
            "hit-area -mx-1.5 text-[13px] text-primary hover:text-primary",
            NARROW_TARGET,
          )}
        >
          View full prompt
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[min(85dvh,48rem)] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border-subtle px-6 pt-6 pb-4">
          <DialogTitle>Full prompt</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
          {hasThread ? (
            <section aria-labelledby={threadHeadingId} className="space-y-2">
              <h3 id={threadHeadingId} className="text-xs font-medium text-muted-foreground">
                Earlier in the thread
              </h3>
              <ol className="space-y-2">
                {prompt.thread.map((message, index) => (
                  // Thread messages have no id. The list is parsed once and never reorders.
                  <li key={index}>
                    <blockquote className="border-l-2 border-border pl-3 text-sm leading-relaxed break-words whitespace-pre-wrap">
                      {message.speaker ? (
                        <span className="font-semibold text-foreground">{message.speaker}: </span>
                      ) : null}
                      <span className="text-muted-foreground">
                        {formatSlackMentions(message.text)}
                      </span>
                    </blockquote>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          <section aria-labelledby={hasThread ? askHeadingId : undefined} className="space-y-2">
            {hasThread ? (
              <h3 id={askHeadingId} className="text-xs font-medium text-muted-foreground">
                {prompt.speaker ? `${prompt.speaker} asked` : "The ask"}
              </h3>
            ) : null}
            <div className="text-sm leading-relaxed break-words">
              <MarkdownView text={ask} />
            </div>
          </section>
        </div>
        <DialogFooter className="border-t border-border-subtle px-6 py-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copy(task.task)}
            aria-label={copied ? "Copied" : undefined}
          >
            {copied ? <Check /> : <Copy />}
            Copy prompt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Where a task came from, under its title: the source's mark, who or what
 * sent it, and a "View full prompt" button. A Slack task names the speaker
 * and counts the earlier thread messages. A GitHub or GitLab task links its
 * PR or issue. Other sources show their name.
 */
export function TaskSourceLine({
  task,
  requestedByName,
  creatorName,
}: {
  task: SourceTask;
  /** The requesting user's name, when the users list has it. */
  requestedByName: string | null;
  /** The name of the agent that created the task, when it is not the assignee. */
  creatorName: string | null;
}) {
  const prompt = useMemo(() => parseSlackPrompt(task.task), [task.task]);
  // A task from a GitHub or GitLab event reads as that event, whatever its
  // `source` (an API call can carry VCS fields too).
  const vcs =
    task.vcsProvider === "github" || task.vcsProvider === "gitlab"
      ? task.vcsProvider
      : task.source === "github" || task.source === "gitlab"
        ? task.source
        : null;
  const source = task.source === "slack" ? "slack" : (vcs ?? task.source);
  const label = taskSourceLabel(source);
  const view = describeSource(task, source, prompt, {
    requestedBy: requestedByName,
    creator: creatorName,
  });
  const count = prompt.thread.length;
  const description =
    source === "slack"
      ? count > 0
        ? `From Slack, with ${count} earlier ${count === 1 ? "message" : "messages"} from the thread.`
        : "From Slack."
      : "The prompt this task was created with.";

  return (
    // Wide: the line wraps. Narrow: one row, 44 px tall for "View full
    // prompt", where a name or a repo truncates instead.
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-6 text-muted-foreground @max-[64rem]:flex-nowrap">
      <span
        className={cn("inline-flex items-center gap-1.5", view.shrinks ? "min-w-0" : "shrink-0")}
      >
        <SourceMark source={source} />
        {view.named ? null : <span className="sr-only">{label}: </span>}
        {view.lead}
      </span>
      {view.extras.map((extra) => (
        <Fragment key={extra.key}>
          <Dot />
          {extra.node}
        </Fragment>
      ))}
      <Dot />
      <TaskPromptDialog task={task} prompt={prompt} description={description} />
    </div>
  );
}
