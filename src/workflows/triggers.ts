import { listWorkflows } from "../be/db";
import type { WorkflowNode } from "../types";
import { findEntryNodes, startWorkflowExecution } from "./engine";

export function evaluateWorkflowTriggers(eventType: string, eventData: unknown): void {
  const workflows = listWorkflows({ enabled: true });
  for (const workflow of workflows) {
    const entryNodes = findEntryNodes(workflow.definition);
    for (const node of entryNodes) {
      if (matchTriggerNode(node, eventType, eventData)) {
        startWorkflowExecution(workflow, eventData).catch((err) => {
          console.error(`[workflows] Failed to start workflow ${workflow.name}:`, err);
        });
      }
    }
  }
}

function matchTriggerNode(node: WorkflowNode, eventType: string, eventData: unknown): boolean {
  const data = eventData as Record<string, unknown>;

  switch (node.type) {
    case "trigger-new-task":
      if (eventType !== "task.created") return false;
      // Don't trigger on tasks created by workflows (prevent infinite loops)
      if (data.workflowRunId) return false;
      return matchTaskFilters(node.config as Record<string, unknown>, data);

    case "trigger-task-completed":
      if (eventType !== "task.completed") return false;
      return matchTaskFilters(node.config as Record<string, unknown>, data);

    case "trigger-github-event":
      if (!eventType.startsWith("github.")) return false;
      return matchEventFilters(node.config as Record<string, unknown>, eventType, "github", data);

    case "trigger-gitlab-event":
      if (!eventType.startsWith("gitlab.")) return false;
      return matchEventFilters(node.config as Record<string, unknown>, eventType, "gitlab", data);

    case "trigger-slack-message":
      if (eventType !== "slack.message") return false;
      return matchSlackFilters(node.config as Record<string, unknown>, data);

    case "trigger-email":
      if (eventType !== "agentmail.message.received") return false;
      return matchEmailFilters(node.config as Record<string, unknown>, data);

    case "trigger-webhook":
      return false; // Webhooks are triggered via HTTP, not event bus

    default:
      return false;
  }
}

function matchTaskFilters(config: Record<string, unknown>, data: Record<string, unknown>): boolean {
  if (config.matchTags && Array.isArray(config.matchTags)) {
    const taskTags = (data.tags as string[]) ?? [];
    if (!config.matchTags.every((t: string) => taskTags.includes(t))) return false;
  }
  if (config.matchSource && data.source !== config.matchSource) return false;
  if (config.matchTaskType && data.taskType !== config.matchTaskType) return false;
  if (config.matchAgentId && data.agentId !== config.matchAgentId) return false;
  return true;
}

function matchEventFilters(
  config: Record<string, unknown>,
  eventType: string,
  provider: "github" | "gitlab",
  data: Record<string, unknown>,
): boolean {
  if (config.matchEventType) {
    const expectedEvent = `${provider}.${config.matchEventType}`;
    if (eventType !== expectedEvent) return false;
  }
  if (config.matchRepo && data.repo !== config.matchRepo) return false;
  // Filter by allowed actions (e.g., actions: ["opened", "closed"])
  if (config.actions && Array.isArray(config.actions)) {
    if (!config.actions.includes(data.action)) return false;
  }
  return true;
}

function matchSlackFilters(
  config: Record<string, unknown>,
  data: Record<string, unknown>,
): boolean {
  if (config.matchChannel && data.channel !== config.matchChannel) return false;
  if (config.matchPattern) {
    const text = String(data.text ?? "");
    if (!new RegExp(config.matchPattern as string, "i").test(text)) return false;
  }
  return true;
}

function matchEmailFilters(
  config: Record<string, unknown>,
  data: Record<string, unknown>,
): boolean {
  if (config.matchInbox && data.inboxId !== config.matchInbox) return false;
  if (config.matchSenderDomain) {
    const from = String(data.from ?? "");
    if (!from.endsWith(`@${config.matchSenderDomain}`)) return false;
  }
  return true;
}
