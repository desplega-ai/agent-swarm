import { cancelTask, getAllAgents, getTaskById, resolveUser } from "../be/db";
import { getOAuthTokens } from "../be/db-queries/oauth";
import {
  createTrackerSync,
  deleteTrackerSync,
  getTrackerSyncByExternalId,
  updateTrackerSync,
} from "../be/db-queries/tracker";
import { ensureToken } from "../oauth/ensure-token";
import { resolveTemplate } from "../prompts/resolver";
import { linearContextKey } from "../tasks/context-key";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
// Side-effect import: registers all Linear event templates in the in-memory registry
import "./templates";

/**
 * In-memory map: swarmTaskId → Linear agentSessionId.
 * Used by outbound sync to post activities back to the AgentSession.
 * Not persisted — sessions are ephemeral and tied to the process lifetime.
 */
export const taskSessionMap = new Map<string, string>();

const AGENT_ACTIVITY_MUTATION = `
  mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
    agentActivityCreate(input: $input) { success }
  }
`;

const AGENT_SESSION_UPDATE_MUTATION = `
  mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
    agentSessionUpdate(id: $id, input: $input) { success }
  }
`;

/**
 * Low-level helper to post an activity to a Linear AgentSession via GraphQL.
 *
 * Activity types and their effect on session state:
 * - `thought` — internal note (dimmed), session becomes active
 * - `action`  — tool invocation, session becomes active
 * - `response` — final result, session auto-completes
 * - `error`   — error message, session transitions to error state
 *
 * No `signal` parameter is needed — Linear derives session state from the activity type.
 */
async function postAgentActivity(
  sessionId: string,
  content:
    | { type: "thought" | "response" | "error"; body: string }
    | { type: "action"; action: string; parameter?: string; result?: string },
): Promise<boolean> {
  await ensureToken("linear");
  const tokens = getOAuthTokens("linear");
  if (!tokens) {
    console.log("[Linear Sync] No OAuth tokens, cannot post AgentSession activity");
    return false;
  }

  const input = {
    agentSessionId: sessionId,
    content,
  };

  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokens.accessToken}`,
    },
    body: JSON.stringify({
      query: AGENT_ACTIVITY_MUTATION,
      variables: { input },
    }),
  });

  if (!res.ok) {
    console.error(
      `[Linear Sync] Failed to post activity to AgentSession ${sessionId}: ${res.status} ${res.statusText}`,
    );
    return false;
  }

  const result = (await res.json()) as {
    data?: { agentActivityCreate?: { success: boolean } };
    errors?: unknown[];
  };
  if (result.errors) {
    console.error("[Linear Sync] GraphQL errors posting AgentSession activity:", result.errors);
    return false;
  }

  return true;
}

/**
 * Update an AgentSession via the agentSessionUpdate mutation.
 * Used to set externalUrls, plan, etc.
 */
async function updateAgentSession(
  sessionId: string,
  input: Record<string, unknown>,
): Promise<boolean> {
  await ensureToken("linear");
  const tokens = getOAuthTokens("linear");
  if (!tokens) {
    console.log("[Linear Sync] No OAuth tokens, cannot update AgentSession");
    return false;
  }

  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokens.accessToken}`,
    },
    body: JSON.stringify({
      query: AGENT_SESSION_UPDATE_MUTATION,
      variables: { id: sessionId, input },
    }),
  });

  if (!res.ok) {
    console.error(
      `[Linear Sync] Failed to update AgentSession ${sessionId}: ${res.status} ${res.statusText}`,
    );
    return false;
  }

  const result = (await res.json()) as {
    data?: { agentSessionUpdate?: { success: boolean } };
    errors?: unknown[];
  };
  if (result.errors) {
    console.error("[Linear Sync] GraphQL errors updating AgentSession:", result.errors);
    return false;
  }

  return true;
}

/**
 * Acknowledge a Linear AgentSession by posting a thought activity.
 * Creating an activity transitions the session from "pending" to "active".
 */
async function acknowledgeAgentSession(sessionId: string, message: string): Promise<void> {
  const ok = await postAgentActivity(sessionId, { type: "thought", body: message });
  if (ok) {
    console.log(`[Linear Sync] AgentSession ${sessionId} acknowledged`);
  }
}

/**
 * Post a response activity to a Linear AgentSession (visible as a comment).
 */
export async function postAgentSessionResponse(sessionId: string, body: string): Promise<void> {
  await postAgentActivity(sessionId, { type: "response", body });
}

/**
 * Post a thought activity to a Linear AgentSession (dimmed internal thinking).
 */
export async function postAgentSessionThought(sessionId: string, body: string): Promise<void> {
  await postAgentActivity(sessionId, { type: "thought", body });
}

/**
 * Post an error activity to a Linear AgentSession.
 */
export async function postAgentSessionError(sessionId: string, body: string): Promise<void> {
  await postAgentActivity(sessionId, { type: "error", body });
}

/**
 * End a Linear AgentSession by posting a response or error activity.
 * A `response` activity auto-completes the session; an `error` activity marks it as errored.
 * No explicit signal is needed — Linear derives state from the activity type.
 */
export async function endAgentSession(
  sessionId: string,
  body: string,
  type: "response" | "error" = "response",
): Promise<void> {
  await postAgentActivity(sessionId, { type, body });
}

/**
 * Post an action activity to a Linear AgentSession (tool invocation).
 */
export async function postAgentSessionAction(
  sessionId: string,
  action: string,
  parameter?: string,
  result?: string,
): Promise<void> {
  const content: { type: "action"; action: string; parameter?: string; result?: string } = {
    type: "action",
    action,
  };
  if (parameter) content.parameter = parameter;
  if (result) content.result = result;
  await postAgentActivity(sessionId, content);
}

/**
 * Set externalUrls on an AgentSession so users can click through to the swarm dashboard.
 */
export async function updateAgentSessionExternalUrls(
  sessionId: string,
  urls: { label: string; url: string }[],
): Promise<void> {
  const ok = await updateAgentSession(sessionId, { externalUrls: urls });
  if (ok) {
    console.log(`[Linear Sync] Set externalUrls on AgentSession ${sessionId}`);
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

  // Extract actor identity from Linear webhook payload
  const actor = event.actor as Record<string, unknown> | undefined;
  const actorLinearId = actor ? String(actor.id ?? "") : "";
  const actorName = actor ? String(actor.name ?? "") : "";
  const actorEmail = actor ? String(actor.email ?? "") : "";
  const requestedByUserId = resolveUser({
    linearUserId: actorLinearId || undefined,
    email: actorEmail || undefined,
    name: actorName || undefined,
  })?.id;

  // Check if we already track this issue
  const existing = getTrackerSyncByExternalId("linear", "task", issueId);
  const sessionId = agentSession ? String(agentSession.id ?? "") : "";

  if (existing) {
    const existingTask = getTaskById(existing.swarmId);

    // If the task is still active, post a user-visible response on the new
    // session explaining that a sibling is already in flight and the new
    // session can be closed. Do NOT create a duplicate swarm task. If the user
    // wants to force a fresh run, they can re-assign the issue after the
    // current task finishes.
    if (existingTask && !["completed", "failed", "cancelled"].includes(existingTask.status)) {
      console.log(
        `[Linear Sync] Issue ${issueIdentifier} already tracked as active task ${existing.swarmId} (status: ${existingTask.status}), skipping duplicate`,
      );
      if (sessionId) {
        taskSessionMap.set(existingTask.id, sessionId);
        const refuseMsg = [
          `This issue is already being worked on — task \`${existing.swarmId}\` is currently \`${existingTask.status}\`.`,
          "",
          "To avoid duplicating work, I'm not starting a new session for this re-assignment. Progress on the active task will continue to be posted here.",
          "",
          "If you want to force a fresh run, wait for the current task to finish (or cancel it) and re-assign the issue.",
        ].join("\n");
        postAgentSessionResponse(sessionId, refuseMsg).catch((err) => {
          console.error("[Linear Sync] Failed to post hard-refuse response:", err);
        });
      }
      return;
    }

    // Task is done/failed/cancelled — create a follow-up task below
    console.log(
      `[Linear Sync] Issue ${issueIdentifier} was tracked as ${existingTask?.status ?? "unknown"} task ${existing.swarmId}, creating follow-up`,
    );
  }

  const lead = findLeadAgent();

  const sessionSection = sessionUrl ? `\nSession: ${sessionUrl}` : "";
  const descriptionSection = issueDescription ? `\nDescription:\n${issueDescription}\n` : "";
  const templateName = existing ? "linear.issue.reassigned" : "linear.issue.assigned";
  const templateResult = resolveTemplate(templateName, {
    issue_identifier: issueIdentifier,
    issue_title: issueTitle,
    issue_url: issueUrl,
    session_section: sessionSection,
    description_section: descriptionSection,
  });

  if (templateResult.skipped) {
    return;
  }

  const task = createTaskWithSiblingAwareness(templateResult.text, {
    agentId: lead?.id ?? "",
    source: "linear",
    taskType: "linear-issue",
    requestedByUserId,
    contextKey: linearContextKey({ issueIdentifier }),
  });

  // Delete old tracker_sync before creating new one (UNIQUE constraint)
  if (existing) {
    deleteTrackerSync(existing.id);
  }

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

  // Track the AgentSession so outbound sync can post activities to it
  if (sessionId) {
    taskSessionMap.set(task.id, sessionId);

    // Acknowledge the AgentSession (pending → active)
    const ackMsg = existing
      ? `Follow-up task created (${task.id}). Previous task was ${existing.swarmId}. Processing...`
      : `Task received by Agent Swarm (${task.id}). Processing...`;
    acknowledgeAgentSession(sessionId, ackMsg).catch((err) => {
      console.error("[Linear Sync] Failed to acknowledge AgentSession:", err);
    });

    // Set externalUrls so users can click through to the swarm dashboard
    const dashboardUrl = process.env.SWARM_DASHBOARD_URL || process.env.APP_URL;
    if (dashboardUrl) {
      updateAgentSessionExternalUrls(sessionId, [
        { label: "View in Agent Swarm", url: `${dashboardUrl}/tasks/${task.id}` },
      ]).catch((err) => {
        console.error("[Linear Sync] Failed to set externalUrls on AgentSession:", err);
      });
    }
  }

  const action = existing ? "follow-up" : "new";
  console.log(
    `[Linear Sync] Created ${action} task ${task.id} for ${issueIdentifier} -> ${lead?.name ?? "unassigned"}`,
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

/**
 * Handle "prompted" AgentSession events — user sent a follow-up message
 * in the Linear agent chat UI.
 */
export async function handleAgentSessionPrompted(event: Record<string, unknown>): Promise<void> {
  const agentSession = event.agentSession as Record<string, unknown> | undefined;
  if (!agentSession) {
    console.log("[Linear Sync] Prompted event has no agentSession, skipping");
    return;
  }

  const sessionId = String(agentSession.id ?? "");
  const issue = agentSession.issue as Record<string, unknown> | undefined;

  // User message is in event.agentActivity.content.body (not agentSession.comment.body)
  const agentActivity = event.agentActivity as Record<string, unknown> | undefined;
  const activityContent = agentActivity?.content as Record<string, unknown> | undefined;
  const userMessage = activityContent ? String(activityContent.body ?? "") : "";
  const activitySignal = agentActivity ? String(agentActivity.signal ?? "") : "";

  if (!issue) {
    console.log("[Linear Sync] Prompted event has no issue data, skipping");
    return;
  }

  const issueId = String(issue.id ?? "");
  const issueIdentifier = String(issue.identifier ?? "");
  const issueTitle = String(issue.title ?? "");
  const issueUrl = String(issue.url ?? "");

  // Handle stop signal — cancel the active task
  if (activitySignal === "stop") {
    const existing = getTrackerSyncByExternalId("linear", "task", issueId);
    if (existing) {
      const existingTask = getTaskById(existing.swarmId);
      if (existingTask && !["completed", "failed", "cancelled"].includes(existingTask.status)) {
        cancelTask(existing.swarmId, "Stopped by user from Linear");
        console.log(`[Linear Sync] Cancelled task ${existing.swarmId} (stop signal from Linear)`);
      }
    }
    if (sessionId) {
      endAgentSession(sessionId, "Task cancelled by user.", "response").catch((err) => {
        console.error("[Linear Sync] Failed to end session on stop:", err);
      });
    }
    return;
  }

  if (!issueId || !userMessage) {
    console.log("[Linear Sync] Prompted event missing issue ID or message, skipping");
    return;
  }

  // Look up existing tracker_sync for this issue
  const existing = getTrackerSyncByExternalId("linear", "task", issueId);

  if (existing) {
    const existingTask = getTaskById(existing.swarmId);

    // If the task is still in progress, acknowledge but don't create a new one
    if (existingTask && !["completed", "failed", "cancelled"].includes(existingTask.status)) {
      console.log(`[Linear Sync] Prompted on in-progress task ${existing.swarmId}, acknowledging`);
      if (sessionId) {
        postAgentSessionThought(
          sessionId,
          "Message received, but the agent is currently working on this task. Your message will be considered when possible.",
        ).catch((err) => {
          console.error("[Linear Sync] Failed to post thought for prompted event:", err);
        });
      }
      return;
    }
  }

  // Task is completed/failed/cancelled or doesn't exist — create a new follow-up task
  const lead = findLeadAgent();

  // Extract actor identity from Linear webhook payload
  const promptedActor = event.actor as Record<string, unknown> | undefined;
  const promptedActorLinearId = promptedActor ? String(promptedActor.id ?? "") : "";
  const promptedActorEmail = promptedActor ? String(promptedActor.email ?? "") : "";
  const promptedActorName = promptedActor ? String(promptedActor.name ?? "") : "";
  const promptedRequestedByUserId = resolveUser({
    linearUserId: promptedActorLinearId || undefined,
    email: promptedActorEmail || undefined,
    name: promptedActorName || undefined,
  })?.id;

  const followupResult = resolveTemplate("linear.issue.followup", {
    issue_identifier: issueIdentifier,
    issue_title: issueTitle,
    issue_url: issueUrl,
    user_message: userMessage,
  });

  if (followupResult.skipped) {
    return;
  }

  const task = createTaskWithSiblingAwareness(followupResult.text, {
    agentId: lead?.id ?? "",
    source: "linear",
    taskType: "linear-issue",
    requestedByUserId: promptedRequestedByUserId,
    contextKey: linearContextKey({ issueIdentifier }),
  });

  // Repoint the existing tracker_sync to the new follow-up task (can't create a
  // duplicate due to UNIQUE(provider, entityType, externalId) constraint)
  if (existing) {
    deleteTrackerSync(existing.id);
  }
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

  // Track session and acknowledge
  if (sessionId) {
    taskSessionMap.set(task.id, sessionId);
    acknowledgeAgentSession(
      sessionId,
      `Follow-up task created (${task.id}). Processing your message...`,
    ).catch((err) => {
      console.error("[Linear Sync] Failed to acknowledge prompted AgentSession:", err);
    });

    // Set externalUrls for the follow-up task
    const dashboardUrl = process.env.SWARM_DASHBOARD_URL || process.env.APP_URL;
    if (dashboardUrl) {
      updateAgentSessionExternalUrls(sessionId, [
        { label: "View in Agent Swarm", url: `${dashboardUrl}/tasks/${task.id}` },
      ]).catch((err) => {
        console.error("[Linear Sync] Failed to set externalUrls on prompted AgentSession:", err);
      });
    }
  }

  console.log(
    `[Linear Sync] Created follow-up task ${task.id} for ${issueIdentifier} (prompted) -> ${lead?.name ?? "unassigned"}`,
  );
}
