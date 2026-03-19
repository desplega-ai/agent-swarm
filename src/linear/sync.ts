import { cancelTask, createTaskExtended, getAllAgents, getTaskById } from "../be/db";
import { getOAuthTokens } from "../be/db-queries/oauth";
import {
  createTrackerSync,
  getTrackerSyncByExternalId,
  updateTrackerSync,
} from "../be/db-queries/tracker";

/**
 * Acknowledge a Linear AgentSession by posting an activity.
 * The @linear/sdk doesn't support AgentSession yet, so we call the GraphQL API directly.
 * Creating an activity transitions the session from "pending" to "active".
 */
async function acknowledgeAgentSession(sessionId: string, message: string): Promise<void> {
  const tokens = getOAuthTokens("linear");
  if (!tokens) {
    console.log("[Linear Sync] No OAuth tokens, cannot acknowledge AgentSession");
    return;
  }

  const mutation = `
    mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
      agentActivityCreate(input: $input) {
        success
      }
    }
  `;

  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokens.accessToken}`,
    },
    body: JSON.stringify({
      query: mutation,
      variables: {
        input: {
          agentSessionId: sessionId,
          content: { type: "thought", body: message },
        },
      },
    }),
  });

  if (!res.ok) {
    console.error(
      `[Linear Sync] Failed to acknowledge AgentSession ${sessionId}: ${res.status} ${res.statusText}`,
    );
    return;
  }

  const result = (await res.json()) as {
    data?: { agentActivityCreate?: { success: boolean } };
    errors?: unknown[];
  };
  if (result.errors) {
    console.error("[Linear Sync] GraphQL errors acknowledging AgentSession:", result.errors);
    return;
  }

  console.log(`[Linear Sync] AgentSession ${sessionId} acknowledged`);
}

/**
 * Post a response activity to a Linear AgentSession (visible as a comment).
 */
export async function postAgentSessionResponse(sessionId: string, body: string): Promise<void> {
  const tokens = getOAuthTokens("linear");
  if (!tokens) return;

  const mutation = `
    mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
      agentActivityCreate(input: $input) { success }
    }
  `;

  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokens.accessToken}`,
    },
    body: JSON.stringify({
      query: mutation,
      variables: {
        input: {
          agentSessionId: sessionId,
          content: { type: "response", body },
        },
      },
    }),
  });

  if (!res.ok) {
    console.error(
      `[Linear Sync] Failed to post response to AgentSession ${sessionId}: ${res.status}`,
    );
  }
}

// Status mapping: Linear state names → swarm task statuses
const LINEAR_STATUS_MAP: Record<string, string> = {
  Backlog: "skip",
  Todo: "unassigned",
  "In Progress": "in_progress",
  Done: "completed",
  Canceled: "cancelled",
  Cancelled: "cancelled",
};

export function mapLinearStatusToSwarm(linearStateName: string): string | null {
  return LINEAR_STATUS_MAP[linearStateName] ?? null;
}

/**
 * Find the lead agent to receive Linear tasks.
 * Returns null if no lead is available (task will go to pool).
 */
function findLeadAgent() {
  const agents = getAllAgents();
  const onlineLead = agents.find((a) => a.isLead && a.status !== "offline");
  if (onlineLead) return onlineLead;
  return agents.find((a) => a.isLead) ?? null;
}

/**
 * Handle AgentSession events from Linear.
 * These are fired when an issue is assigned to the Linear agent integration,
 * triggering a new swarm task.
 */
export async function handleAgentSessionEvent(event: Record<string, unknown>): Promise<void> {
  // Linear sends AgentSessionEvent with agentSession.issue (not data.issue)
  const agentSession = event.agentSession as Record<string, unknown> | undefined;
  const data = agentSession ?? (event.data as Record<string, unknown> | undefined);
  if (!data) {
    console.log("[Linear Sync] AgentSession event has no agentSession/data, skipping");
    return;
  }

  const issue = data.issue as Record<string, unknown> | undefined;
  if (!issue) {
    console.log("[Linear Sync] AgentSession event has no issue data, skipping");
    return;
  }

  const issueId = String(issue.id ?? "");
  const issueIdentifier = String(issue.identifier ?? "");
  const issueTitle = String(issue.title ?? "");
  const issueUrl = String(issue.url ?? "");
  const issueDescription = issue.description ? String(issue.description) : "";
  const sessionUrl = agentSession ? String(agentSession.url ?? "") : "";

  if (!issueId) {
    console.log("[Linear Sync] AgentSession event has no issue ID, skipping");
    return;
  }

  // Check if we already track this issue
  const existing = getTrackerSyncByExternalId("linear", "task", issueId);
  if (existing) {
    console.log(
      `[Linear Sync] Issue ${issueIdentifier} already tracked as task ${existing.swarmId}, skipping`,
    );
    return;
  }

  const lead = findLeadAgent();

  const taskDescription = `[Linear ${issueIdentifier}] ${issueTitle}\n\nSource: Linear (Agent Session)\nURL: ${issueUrl}${sessionUrl ? `\nSession: ${sessionUrl}` : ""}\n${issueDescription ? `\nDescription:\n${issueDescription}\n` : ""}`;

  const task = createTaskExtended(taskDescription, {
    agentId: lead?.id ?? "",
    source: "linear",
    taskType: "linear-issue",
  });

  createTrackerSync({
    provider: "linear",
    entityType: "task",
    providerEntityType: "Issue",
    swarmId: task.id,
    externalId: issueId,
    externalIdentifier: issueIdentifier,
    externalUrl: issueUrl,
    lastSyncOrigin: "external",
    syncDirection: "inbound",
  });

  // Acknowledge the AgentSession (pending → active)
  const sessionId = agentSession ? String(agentSession.id ?? "") : "";
  if (sessionId) {
    acknowledgeAgentSession(
      sessionId,
      `Task received by Agent Swarm (${task.id}). Processing...`,
    ).catch((err) => {
      console.error("[Linear Sync] Failed to acknowledge AgentSession:", err);
    });
  }

  console.log(
    `[Linear Sync] Created task ${task.id} for ${issueIdentifier} -> ${lead?.name ?? "unassigned"}`,
  );
}

/**
 * Handle Issue update events from Linear webhooks.
 * Updates swarm task status when a tracked Linear issue changes state.
 */
export async function handleIssueUpdate(
  event: Record<string, unknown>,
  deliveryId?: string,
): Promise<void> {
  const data = event.data as Record<string, unknown> | undefined;
  if (!data) return;

  const issueId = String(data.id ?? "");
  if (!issueId) return;

  const sync = getTrackerSyncByExternalId("linear", "task", issueId);
  if (!sync) {
    // We don't track this issue — ignore
    return;
  }

  // Check if the status (state) changed
  const updatedFrom = event.updatedFrom as Record<string, unknown> | undefined;
  if (!updatedFrom) return;

  const state = data.state as Record<string, unknown> | undefined;
  if (!state) return;

  const stateName = String(state.name ?? "");
  const swarmStatus = mapLinearStatusToSwarm(stateName);

  if (!swarmStatus) {
    console.log(
      `[Linear Sync] Unknown Linear status "${stateName}" for issue ${issueId}, skipping`,
    );
    return;
  }

  // Update tracker_sync metadata
  updateTrackerSync(sync.id, {
    lastSyncOrigin: "external",
    lastSyncedAt: new Date().toISOString(),
    lastDeliveryId: deliveryId ?? null,
  });

  // Map status to swarm actions
  if (swarmStatus === "cancelled") {
    const task = getTaskById(sync.swarmId);
    if (task && !["completed", "failed", "cancelled"].includes(task.status)) {
      cancelTask(sync.swarmId, `Linear issue cancelled`);
      console.log(
        `[Linear Sync] Cancelled task ${sync.swarmId} (Linear issue ${data.identifier ?? issueId} cancelled)`,
      );
    }
    return;
  }

  if (swarmStatus === "completed") {
    // We don't auto-complete tasks from Linear — the agent decides when work is done
    console.log(
      `[Linear Sync] Linear issue ${data.identifier ?? issueId} marked Done — not auto-completing task ${sync.swarmId}`,
    );
    return;
  }

  // For skip / unassigned / in_progress — log but don't force status changes
  console.log(
    `[Linear Sync] Issue ${data.identifier ?? issueId} status → ${stateName} (mapped: ${swarmStatus})`,
  );
}

/**
 * Handle Issue delete events from Linear webhooks.
 * Cancels the swarm task if the tracked Linear issue is removed.
 */
export async function handleIssueDelete(event: Record<string, unknown>): Promise<void> {
  const data = event.data as Record<string, unknown> | undefined;
  if (!data) return;

  const issueId = String(data.id ?? "");
  if (!issueId) return;

  const sync = getTrackerSyncByExternalId("linear", "task", issueId);
  if (!sync) return;

  const task = getTaskById(sync.swarmId);
  if (task && !["completed", "failed", "cancelled"].includes(task.status)) {
    cancelTask(sync.swarmId, "Linear issue deleted");
    console.log(`[Linear Sync] Cancelled task ${sync.swarmId} (Linear issue ${issueId} deleted)`);
  }
}
