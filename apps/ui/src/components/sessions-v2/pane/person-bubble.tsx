import { useUsers } from "@/api/hooks/use-users";
import type { AgentTask, AgentTaskSource } from "@/api/types";
import { stripContextFooter } from "@/components/session-panel/model";
import { TaskPromptAttachments } from "@/components/shared/task-attachments-section";
import { UserAvatar } from "@/components/shared/user-avatar";
import { useCurrentUser } from "@/contexts/current-user-context";
import { userName } from "@/lib/sessions-v2";
import { cn } from "@/lib/utils";
import { MessageCopyButton, MessageTime } from "./swarm-reply";

/** Where a message came from, when not the dashboard (SPEC R10.1). */
function viaNote(task: AgentTask, rootSource: AgentTaskSource): string | null {
  if (task.source === "slack") return "From Slack";
  if (task.source === "chat") return "From a chat channel";
  // Only the lead's answer goes to the Slack thread. The person's text stays here.
  if (task.source === "ui" && rootSource === "slack") return "Sent from the dashboard";
  return null;
}

/**
 * A person's message (SPEC R10.1). Mine sit on the right with no name;
 * other people's sit on the left with their name. The avatar is beside the
 * bubble, on its first line. The meta row under the bubble holds the time,
 * the via note, and a Copy that fades in on hover.
 */
export function PersonBubble({
  task,
  rootSource,
}: {
  task: AgentTask;
  /** The root's source: a dashboard message in a Slack session says where it was sent. */
  rootSource: AgentTaskSource;
}) {
  const { userId } = useCurrentUser();
  const { data: users } = useUsers();
  const personId = task.requestedByUserId;
  const mine = !!personId && personId === userId;
  const name = personId ? userName(users, personId) : "Someone";
  const text = stripContextFooter(task.task);
  const via = viaNote(task, rootSource);
  const external = task.source !== "ui";
  return (
    <section
      aria-label={mine ? "Your message" : `Message from ${name}`}
      className={cn("group/message flex min-w-0 items-start gap-2.5", mine && "flex-row-reverse")}
    >
      <UserAvatar
        id={personId ?? task.id}
        name={name}
        // Centered on the first line: 8 px padding plus half a line, minus half the avatar.
        className={cn("mt-2", mine && "@max-[30rem]/turns:hidden")}
      />
      <div className={cn("flex max-w-[85%] min-w-0 flex-col gap-1.5", mine && "items-end")}>
        <TaskPromptAttachments taskId={task.id} attachments={task.attachments} />
        <div
          className={cn(
            // Phones read message text at 16 px (UX review R9). Desktop keeps 14 px.
            "min-w-0 rounded-2xl px-3.5 py-2 text-base leading-relaxed whitespace-pre-wrap wrap-anywhere md:text-sm",
            mine ? "rounded-tr-sm bg-muted" : "rounded-tl-sm border border-border bg-card",
            // A message from Slack or a chat channel stays greyed (SPEC R2).
            external && "border border-dashed bg-surface text-muted-foreground",
          )}
        >
          {text}
        </div>
        <div
          className={cn(
            "flex max-w-full min-w-0 items-center gap-1.5 text-muted-foreground",
            mine && "justify-end",
          )}
        >
          {mine ? null : (
            <span className="min-w-0 truncate font-mono text-meta tracking-wider uppercase">
              {name} ·
            </span>
          )}
          <MessageTime at={task.createdAt} />
          {via ? (
            <span className="min-w-0 truncate text-meta" title={via}>
              · {via}
            </span>
          ) : null}
          <MessageCopyButton text={text} hover />
        </div>
      </div>
    </section>
  );
}
