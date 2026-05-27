import { createTaskExtended, getAgentById, getLeadAgent, getTaskAttachments } from "../be/db";
import { resolveTemplate } from "../prompts/resolver";
import type { AgentTask, TaskAttachment } from "../types";
// Side-effect import: registers task lifecycle templates in the in-memory registry.
import "../tools/templates";

function attachmentPointer(a: TaskAttachment): string {
  switch (a.kind) {
    case "url":
      return a.url ?? "";
    case "page":
      return `page:${a.pageId ?? ""}`;
    case "agent-fs":
      return `agent-fs:${a.path ?? ""}`;
    case "shared-fs":
      return `shared-fs:${a.path ?? ""}`;
  }
}

function formatAttachmentsBlock(attachments: TaskAttachment[]): string {
  if (attachments.length === 0) return "";
  const lines = attachments.map((a) => {
    const tag = a.isPrimary ? "[primary] " : "";
    const intent = a.intent ? ` (intent: ${a.intent})` : "";
    return `- ${tag}${a.name} - ${attachmentPointer(a)}${intent}`;
  });
  return `\n\nAttachments (${attachments.length}):\n${lines.join("\n")}`;
}

export async function createWorkerTaskFollowUp(args: {
  task: AgentTask;
  status: "completed" | "failed";
  output?: string;
  failureReason?: string;
}): Promise<AgentTask | null> {
  const { task, status, output, failureReason } = args;

  if (task.workflowRunId) return null;

  const taskAgent = await getAgentById(task.agentId ?? "");
  if (!taskAgent || taskAgent.isLead) return null;

  const leadAgent = await getLeadAgent();
  if (!leadAgent) return null;

  const agentName = taskAgent.name || task.agentId?.slice(0, 8) || "Unknown";
  const taskDesc = task.task.slice(0, 200);

  let followUpDescription: string;
  if (status === "completed") {
    const attachmentsBlock = formatAttachmentsBlock(await getTaskAttachments(task.id));
    const outputSummary = output
      ? `${output.slice(0, 500)}${output.length > 500 ? "..." : ""}${attachmentsBlock}`
      : `(no output)${attachmentsBlock}`;
    const completedResult = await resolveTemplate("task.worker.completed", {
      agent_name: agentName,
      task_desc: taskDesc,
      output_summary: outputSummary,
      task_id: task.id,
    });
    followUpDescription = completedResult.text;
  } else {
    const reason = failureReason || "(no reason given)";
    const failedResult = await resolveTemplate("task.worker.failed", {
      agent_name: agentName,
      task_desc: taskDesc,
      failure_reason: reason,
      task_id: task.id,
    });
    followUpDescription = failedResult.text;
  }

  return await createTaskExtended(followUpDescription, {
    agentId: leadAgent.id,
    source: "system",
    taskType: "follow-up",
    parentTaskId: task.id,
    slackChannelId: task.slackChannelId,
    slackThreadTs: task.slackThreadTs,
    slackUserId: task.slackUserId,
  });
}
