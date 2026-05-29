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

export function createWorkerTaskFollowUp(args: {
  task: AgentTask;
  status: "completed" | "failed";
  output?: string;
  failureReason?: string;
}): AgentTask | null {
  const { task, status, output, failureReason } = args;

  if (task.workflowRunId) return null;
  if (task.followUpConfig?.disabled === true) return null;

  const taskAgent = getAgentById(task.agentId ?? "");
  if (!taskAgent || taskAgent.isLead) return null;

  const leadAgent = getLeadAgent();
  if (!leadAgent) return null;

  const agentName = taskAgent.name || task.agentId?.slice(0, 8) || "Unknown";
  const taskDesc = task.task.slice(0, 200);
  const creatorAgent = task.creatorAgentId
    ? `${task.creatorAgentId}${task.creatorAgentId === leadAgent.id ? " (you)" : ""}`
    : "<none>";
  const instructions =
    status === "completed"
      ? (task.followUpConfig?.onCompleted ?? "")
      : (task.followUpConfig?.onFailed ?? "");
  const followUpInstructions = instructions
    ? `\nAdditional instructions from the task creator:\n${instructions}\n`
    : "";

  let followUpDescription: string;
  if (status === "completed") {
    const attachmentsBlock = formatAttachmentsBlock(getTaskAttachments(task.id));
    const outputSummary = output
      ? `${output.slice(0, 500)}${output.length > 500 ? "..." : ""}${attachmentsBlock}`
      : `(no output)${attachmentsBlock}`;
    const completedResult = resolveTemplate("task.worker.completed", {
      agent_name: agentName,
      task_desc: taskDesc,
      creator_agent: creatorAgent,
      output_summary: outputSummary,
      follow_up_instructions: followUpInstructions,
      task_id: task.id,
    });
    followUpDescription = completedResult.text;
  } else {
    const reason = failureReason || "(no reason given)";
    const failedResult = resolveTemplate("task.worker.failed", {
      agent_name: agentName,
      task_desc: taskDesc,
      creator_agent: creatorAgent,
      failure_reason: reason,
      follow_up_instructions: followUpInstructions,
      task_id: task.id,
    });
    followUpDescription = failedResult.text;
  }

  return createTaskExtended(followUpDescription, {
    agentId: leadAgent.id,
    source: "system",
    taskType: "follow-up",
    parentTaskId: task.id,
    slackChannelId: task.slackChannelId,
    slackThreadTs: task.slackThreadTs,
    slackUserId: task.slackUserId,
  });
}
