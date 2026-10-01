/**
 * Azure DevOps service-hook event handlers.
 *
 * Mirrors src/gitlab/handlers.ts:
 * - Parses service-hook payloads (pull request created / commented on)
 * - Creates agent tasks via createTaskWithSiblingAwareness()
 * - Deduplicates events via in-memory TTL map
 * - Detects bot mentions
 */

import { findTaskByVcs, getAllAgents, incrKv, upsertKv } from "../be/db";
import { renderIdentity, resolveIdentity } from "../be/identity";
import { findOrCreateUserByEmail, findUserByExternalId, linkIdentity } from "../be/users";
import { resolveTemplate } from "../prompts/resolver";
import { azureDevOpsContextKey } from "../tasks/context-key";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { canonicalAzureDevOpsRepoUrl } from "../vcs/azure-devops";
import {
  type AzureDevOpsPullRequestRef,
  likeAzureDevOpsComment,
  resolveAzureDevOpsBotId,
} from "./api";
import { AZURE_DEVOPS_BOT_NAME, getAzureDevOpsOrgUrl, normalizeOrgUrl } from "./auth";
// Side-effect import: registers all Azure DevOps event templates in the in-memory registry
import "./templates";
import type {
  AzureDevOpsIdentityRef,
  AzureDevOpsPullRequest,
  PullRequestCommentedEvent,
  PullRequestCreatedEvent,
} from "./types";

type HandlerResult = { created: boolean; taskId?: string };

// ── Dedup cache (same pattern as GitHub/GitLab) ──
const processedEvents = new Map<string, number>();
const DEDUP_TTL_MS = 60_000;

function isDuplicate(key: string): boolean {
  const now = Date.now();
  // Cleanup expired
  for (const [k, ts] of processedEvents) {
    if (now - ts > DEDUP_TTL_MS) processedEvents.delete(k);
  }
  if (processedEvents.has(key)) return true;
  processedEvents.set(key, now);
  return false;
}

// ── Helpers ──

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Mention patterns: the identity picker stores `@<GUID>` in the comment body;
 * a typed mention stays plain `@name`.
 */
function mentionPatterns(botId: string | null): RegExp[] {
  const patterns = [new RegExp(`@${escapeRegExp(AZURE_DEVOPS_BOT_NAME)}\\b`, "gi")];
  if (botId) patterns.push(new RegExp(`@<${escapeRegExp(botId)}>`, "gi"));
  return patterns;
}

export function detectMention(text: string | null | undefined, botId: string | null): boolean {
  if (!text) return false;
  return mentionPatterns(botId).some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

function extractMentionContext(text: string, botId: string | null): string {
  return mentionPatterns(botId)
    .reduce((acc, re) => acc.replace(re, ""), text)
    .trim();
}

function isBot(identity: AzureDevOpsIdentityRef, botId: string | null): boolean {
  return !!botId && identity.id.toLowerCase() === botId.toLowerCase();
}

function pullRequestWebUrl(pr: AzureDevOpsPullRequest): string {
  const web = pr._links?.web?.href;
  if (web) return web.split("#")[0] as string;
  return `${canonicalAzureDevOpsRepoUrl(pr.repository.remoteUrl)}/pullrequest/${pr.pullRequestId}`;
}

function branchName(refName: string): string {
  return refName.replace(/^refs\/heads\//, "");
}

function orgUrlFor(event: PullRequestCreatedEvent | PullRequestCommentedEvent): string | null {
  const containers = event.resourceContainers;
  return (
    normalizeOrgUrl(containers?.account?.baseUrl ?? containers?.collection?.baseUrl) ??
    getAzureDevOpsOrgUrl()
  );
}

/** Thread id of a comment, parsed from its `_links` (the payload has no field for it). */
function threadIdOf(links: { self?: { href: string }; threads?: { href: string } } | undefined) {
  const href = links?.threads?.href ?? links?.self?.href ?? "";
  const match = href.match(/\/threads\/(\d+)/);
  return match ? Number(match[1]) : null;
}

async function findLeadAgent() {
  const agents = await getAllAgents();
  return (
    agents.find((a) => a.role === "lead" && a.status === "idle") ??
    agents.find((a) => a.role === "lead") ??
    null
  );
}

// ── Identity resolution ──

const UNMAPPED_NAMESPACE = "integration:unmapped:azure-devops";
const UNMAPPED_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AZURE_DEVOPS_WEBHOOK_ACTOR = { kind: "system", id: "webhook:azure-devops" } as const;

function externalIdOf(identity: AzureDevOpsIdentityRef): string {
  return identity.uniqueName?.trim() || identity.id;
}

/**
 * Resolve an Azure DevOps identity to a `users.id`. Same cascade as GitLab:
 * linked identity (`uniqueName`) → email when `uniqueName` is one → unmapped
 * tracker entry for operator triage.
 */
async function resolveAzureDevOpsSender(
  identity: AzureDevOpsIdentityRef,
  sampleEventType: string,
  sampleContext: string,
): Promise<string | undefined> {
  const externalId = externalIdOf(identity);
  const existing = await findUserByExternalId("azure-devops", externalId);
  if (existing) return existing.id;

  if (externalId.includes("@")) {
    const { user: linked } = await findOrCreateUserByEmail(
      externalId,
      { name: identity.displayName },
      AZURE_DEVOPS_WEBHOOK_ACTOR,
    );
    await linkIdentity(linked.id, "azure-devops", externalId, AZURE_DEVOPS_WEBHOOK_ACTOR);
    return linked.id;
  }

  await upsertKv({
    namespace: UNMAPPED_NAMESPACE,
    key: `${externalId}:meta`,
    value: {
      lastSeenAt: new Date().toISOString(),
      sampleEventType,
      sampleContext: sampleContext.slice(0, 100),
    },
    valueType: "json",
    expiresAt: Date.now() + UNMAPPED_TTL_MS,
  });
  await incrKv(UNMAPPED_NAMESPACE, `${externalId}:count`, 1);
  return undefined;
}

/**
 * Render an Azure DevOps identity for agent-visible text: the resolved
 * canonical name or the explicit UNKNOWN sentinel.
 */
async function renderAzureDevOpsIdentity(identity: AzureDevOpsIdentityRef): Promise<string> {
  return renderIdentity(await resolveIdentity("azure-devops", externalIdOf(identity)));
}

// ── Event Handlers ──

/** `git.pullrequest.created`: a bot mention in the description creates a task. */
export async function handlePullRequestCreated(
  event: PullRequestCreatedEvent,
): Promise<HandlerResult> {
  const pr = event.resource;
  const repo = canonicalAzureDevOpsRepoUrl(pr.repository.remoteUrl);
  console.log(
    `[AzureDevOps] PR #${pr.pullRequestId} created by ${pr.createdBy.displayName} in ${repo}`,
  );

  const orgUrl = orgUrlFor(event);
  const botId = await resolveAzureDevOpsBotId(orgUrl);
  if (isBot(pr.createdBy, botId)) {
    console.log(`[AzureDevOps] PR opened by the bot itself, skipping`);
    return { created: false };
  }
  if (!detectMention(pr.description, botId)) {
    console.log(`[AzureDevOps] PR opened without bot mention, skipping`);
    return { created: false };
  }

  const dedupKey = `azure-devops-pr-${pr.repository.id}-${pr.pullRequestId}-created`;
  if (isDuplicate(dedupKey)) {
    console.log(`[AzureDevOps] Skipping duplicate PR event`);
    return { created: false };
  }

  const requestedByUserId = await resolveAzureDevOpsSender(
    pr.createdBy,
    "pull_request",
    `PR !${pr.pullRequestId}: ${pr.title}`,
  );

  const context = pr.description ? extractMentionContext(pr.description, botId) : "";
  const prUrl = pullRequestWebUrl(pr);
  const result = resolveTemplate("azure-devops.pull_request.opened", {
    pr_id: pr.pullRequestId,
    pr_title: pr.title,
    repo,
    project: pr.repository.project.name,
    repository: pr.repository.name,
    username: await renderAzureDevOpsIdentity(pr.createdBy),
    source_branch: branchName(pr.sourceRefName),
    target_branch: branchName(pr.targetRefName),
    pr_url: prUrl,
    context_section: context ? `Context: ${context}\n\n` : "",
  });
  if (result.skipped) {
    return { created: false };
  }

  const lead = await findLeadAgent();
  const task = await createTaskWithSiblingAwareness(
    result.text,
    {
      agentId: lead?.id ?? null,
      routingReason: lead ? "skill" : undefined,
      routingSource: lead ? "engine_default" : undefined,
      source: "azure-devops",
      vcsProvider: "azure-devops",
      taskType: "azure-devops-pr",
      vcsRepo: repo,
      vcsEventType: "pull_request",
      vcsNumber: pr.pullRequestId,
      vcsAuthor: externalIdOf(pr.createdBy),
      requestedByUserId,
      vcsUrl: prUrl,
      contextKey: azureDevOpsContextKey({
        repositoryId: pr.repository.id,
        pullRequestId: pr.pullRequestId,
      }),
    },
    { origin: "webhook" },
  );

  return { created: true, taskId: task.id };
}

/**
 * `ms.vss-code.git-pullrequest-comment-event`: a bot mention in a new PR
 * comment creates a task, linked to any active task for the same PR.
 */
export async function handlePullRequestCommented(
  event: PullRequestCommentedEvent,
): Promise<HandlerResult> {
  const { comment, pullRequest: pr } = event.resource;
  const repo = canonicalAzureDevOpsRepoUrl(pr.repository.remoteUrl);

  if (comment.commentType === "system") {
    return { created: false };
  }
  // The event also fires on edits; only a newly published comment triggers,
  // so fixing a typo in a mention does not spawn a second task.
  if (comment.lastContentUpdatedDate && comment.lastContentUpdatedDate !== comment.publishedDate) {
    console.log(`[AzureDevOps] Ignoring edited comment ${comment.id} on PR #${pr.pullRequestId}`);
    return { created: false };
  }

  const orgUrl = orgUrlFor(event);
  const botId = await resolveAzureDevOpsBotId(orgUrl);
  if (isBot(comment.author, botId)) {
    return { created: false };
  }
  if (!detectMention(comment.content, botId)) {
    return { created: false };
  }

  console.log(
    `[AzureDevOps] Comment by ${comment.author.displayName} on PR #${pr.pullRequestId} in ${repo}`,
  );

  const threadId = threadIdOf(comment._links);
  const dedupKey = `azure-devops-comment-${pr.repository.id}-${pr.pullRequestId}-${threadId}-${comment.id}`;
  if (isDuplicate(dedupKey)) {
    return { created: false };
  }

  const requestedByUserId = await resolveAzureDevOpsSender(
    comment.author,
    "pull_request_comment",
    comment.content,
  );

  // Check if there's already an active task for this PR
  const existingTask = await findTaskByVcs(repo, pr.pullRequestId);
  const existingTaskNote = existingTask
    ? `\n\n_Note: There's an active task (${existingTask.id}) for this PR #${pr.pullRequestId}._`
    : "";

  const prUrl = pullRequestWebUrl(pr);
  const result = resolveTemplate("azure-devops.comment.mentioned", {
    pr_id: pr.pullRequestId,
    pr_title: pr.title,
    username: await renderAzureDevOpsIdentity(comment.author),
    repo,
    project: pr.repository.project.name,
    repository: pr.repository.name,
    pr_url: prUrl,
    context: extractMentionContext(comment.content, botId),
    existing_task_note: existingTaskNote,
  });
  if (result.skipped) {
    return { created: false };
  }

  const lead = await findLeadAgent();
  const task = await createTaskWithSiblingAwareness(
    result.text,
    {
      agentId: lead?.id ?? null,
      routingReason: lead ? "skill" : undefined,
      routingSource: lead ? "engine_default" : undefined,
      source: "azure-devops",
      vcsProvider: "azure-devops",
      taskType: "azure-devops-comment",
      vcsRepo: repo,
      vcsEventType: "pull_request_comment",
      vcsNumber: pr.pullRequestId,
      vcsCommentId: comment.id,
      vcsAuthor: externalIdOf(comment.author),
      requestedByUserId,
      vcsUrl: prUrl,
      parentTaskId: existingTask?.id,
      contextKey: azureDevOpsContextKey({
        repositoryId: pr.repository.id,
        pullRequestId: pr.pullRequestId,
      }),
    },
    { origin: "webhook" },
  );

  if (orgUrl && threadId !== null) {
    const ref: AzureDevOpsPullRequestRef = {
      orgUrl,
      projectId: pr.repository.project.id,
      repositoryId: pr.repository.id,
      pullRequestId: pr.pullRequestId,
    };
    try {
      await likeAzureDevOpsComment(ref, threadId, comment.id);
    } catch {}
  }

  return { created: true, taskId: task.id };
}
