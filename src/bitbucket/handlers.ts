/**
 * Bitbucket Cloud webhook event handlers.
 *
 * Mirrors src/azure-devops/handlers.ts and src/gitlab/handlers.ts:
 * - Parses webhook payloads (pull request created / commented / merged / declined)
 * - Creates agent tasks via createTaskWithSiblingAwareness()
 * - Deduplicates deliveries (X-Request-UUID) and events via in-memory TTL maps
 * - Detects bot mentions and reviewer requests
 */

import {
  failTask,
  findActiveTasksByVcs,
  findTaskByVcs,
  getAllAgents,
  incrKv,
  upsertKv,
} from "../be/db";
import { renderIdentity, resolveIdentity } from "../be/identity";
import { findUserByExternalId } from "../be/users";
import { resolveTemplate } from "../prompts/resolver";
import { bitbucketContextKey } from "../tasks/context-key";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { resolveBitbucketBotAccountId } from "./api";
import { getBitbucketBotName } from "./auth";
// Side-effect import: registers all Bitbucket event templates in the in-memory registry
import "./templates";
import type {
  BitbucketAccount,
  BitbucketPullRequest,
  PullRequestCommentEvent,
  PullRequestEvent,
} from "./types";

type HandlerResult = { created: boolean; taskId?: string };

// ── Dedup caches (same pattern as GitHub/GitLab) ──
const DEDUP_TTL_MS = 60_000;
const processedEvents = new Map<string, number>();
const processedDeliveries = new Map<string, number>();

function sweep(cache: Map<string, number>, now: number): void {
  for (const [k, ts] of cache) {
    if (now - ts > DEDUP_TTL_MS) cache.delete(k);
  }
}

/** Content-key dedup: true when the same event was handled in the last 60s. */
export function isDuplicate(key: string): boolean {
  const now = Date.now();
  sweep(processedEvents, now);
  if (processedEvents.has(key)) return true;
  processedEvents.set(key, now);
  return false;
}

/**
 * Hold the content-key reservation for `key` while `fn` runs. A throw releases
 * it, so Bitbucket's retry of a delivery that failed with a 5xx is not taken
 * for a duplicate. Returns null when the key is already held.
 */
async function withDedupReservation(
  key: string,
  fn: () => Promise<HandlerResult>,
): Promise<HandlerResult | null> {
  if (isDuplicate(key)) return null;
  try {
    return await fn();
  } catch (err) {
    processedEvents.delete(key);
    throw err;
  }
}

/**
 * Delivery dedup on `X-Request-UUID`. Bitbucket retries a delivery (same
 * UUID) when it gets a 5xx or times out, so only a delivery that was acked
 * is recorded — see `markDeliveryProcessed`.
 */
export function isDuplicateDelivery(requestUuid: string | undefined): boolean {
  if (!requestUuid) return false;
  sweep(processedDeliveries, Date.now());
  return processedDeliveries.has(requestUuid);
}

export function markDeliveryProcessed(requestUuid: string | undefined): void {
  if (requestUuid) processedDeliveries.set(requestUuid, Date.now());
}

/** Reset dedup state (tests). */
export function resetBitbucketDedup(): void {
  processedEvents.clear();
  processedDeliveries.clear();
}

// ── Helpers ──

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Mention patterns: the mention picker stores `@{<account_id>}` in the
 * comment's raw content; a typed mention stays plain `@name`.
 */
function mentionPatterns(botAccountId: string | null): RegExp[] {
  // `(?![\w-])` rather than `\b`, so `@agent-swarm-bot-two` is not the bot.
  const patterns = [new RegExp(`@${escapeRegExp(getBitbucketBotName())}(?![\\w-])`, "gi")];
  if (botAccountId) patterns.push(new RegExp(`@\\{${escapeRegExp(botAccountId)}\\}`, "gi"));
  return patterns;
}

export function detectMention(
  text: string | null | undefined,
  botAccountId: string | null,
): boolean {
  if (!text) return false;
  return mentionPatterns(botAccountId).some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

function extractMentionContext(text: string, botAccountId: string | null): string {
  return mentionPatterns(botAccountId)
    .reduce((acc, re) => acc.replace(re, ""), text)
    .trim();
}

function isBot(account: BitbucketAccount | undefined, botAccountId: string | null): boolean {
  return !!botAccountId && account?.account_id === botAccountId;
}

function pullRequestWebUrl(repo: string, pr: BitbucketPullRequest): string {
  return pr.links?.html?.href ?? `https://bitbucket.org/${repo}/pull-requests/${pr.id}`;
}

function contextKeyOf(event: PullRequestEvent): string {
  return bitbucketContextKey({
    repoUuid: event.repository.uuid,
    pullRequestId: event.pullrequest.id,
  });
}

// ── Payload shape ──

/** The pull request event, or null when the payload lacks the fields we read. */
export function pullRequestEventOf(body: unknown): PullRequestEvent | null {
  const event = body as Partial<PullRequestEvent> | null | undefined;
  const pr = event?.pullrequest;
  const repo = event?.repository;
  if (
    typeof pr?.id !== "number" ||
    typeof pr.title !== "string" ||
    typeof repo?.uuid !== "string" ||
    typeof repo.full_name !== "string" ||
    !event?.actor
  ) {
    return null;
  }
  return event as PullRequestEvent;
}

/** The comment event, or null when the pull request or comment is missing. */
export function pullRequestCommentEventOf(body: unknown): PullRequestCommentEvent | null {
  const event = pullRequestEventOf(body) as PullRequestCommentEvent | null;
  const comment = event?.comment;
  if (!event || typeof comment?.id !== "number" || typeof comment.content?.raw !== "string") {
    return null;
  }
  return event;
}

function warnMalformed(eventKey: string) {
  console.warn(`[Bitbucket] Ignoring ${eventKey} event: required payload fields are missing`);
}

export async function findLeadAgent() {
  const agents = await getAllAgents();
  return (
    agents.find((a) => a.role === "lead" && a.status === "idle") ??
    agents.find((a) => a.role === "lead") ??
    null
  );
}

// ── Identity resolution ──

const UNMAPPED_NAMESPACE = "integration:unmapped:bitbucket";
const UNMAPPED_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function externalIdOf(account: BitbucketAccount | undefined): string | null {
  return account?.account_id?.trim() || account?.uuid?.trim() || null;
}

/**
 * Resolve a Bitbucket account to a `users.id` via its linked `bitbucket`
 * identity (Atlassian `account_id`). Webhook payloads carry no email, so an
 * unknown sender is recorded as an unmapped tracker entry for operator triage.
 */
export async function resolveBitbucketSender(
  account: BitbucketAccount | undefined,
  sampleEventType: string,
  sampleContext: string,
): Promise<string | undefined> {
  const externalId = externalIdOf(account);
  if (!externalId) return undefined;
  const existing = await findUserByExternalId("bitbucket", externalId);
  if (existing) return existing.id;

  await upsertKv({
    namespace: UNMAPPED_NAMESPACE,
    key: `${externalId}:meta`,
    value: {
      lastSeenAt: new Date().toISOString(),
      displayName: account?.display_name,
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
 * Render a Bitbucket account for agent-visible text: the resolved canonical
 * name or the explicit UNKNOWN sentinel.
 */
export async function renderBitbucketIdentity(
  account: BitbucketAccount | undefined,
): Promise<string> {
  return renderIdentity(await resolveIdentity("bitbucket", externalIdOf(account) ?? ""));
}

async function createBitbucketTask(
  text: string,
  event: PullRequestEvent,
  fields: {
    taskType: "bitbucket-pr" | "bitbucket-comment";
    vcsEventType: string;
    author: BitbucketAccount | undefined;
    requestedByUserId: string | undefined;
    vcsCommentId?: number;
    parentTaskId?: string;
  },
): Promise<HandlerResult> {
  const { pullrequest: pr, repository } = event;
  const lead = await findLeadAgent();
  const task = await createTaskWithSiblingAwareness(
    text,
    {
      agentId: lead?.id ?? null,
      routingReason: lead ? "skill" : undefined,
      routingSource: lead ? "engine_default" : undefined,
      source: "bitbucket",
      vcsProvider: "bitbucket",
      taskType: fields.taskType,
      vcsRepo: repository.full_name,
      vcsEventType: fields.vcsEventType,
      vcsNumber: pr.id,
      vcsCommentId: fields.vcsCommentId,
      vcsAuthor: externalIdOf(fields.author) ?? undefined,
      requestedByUserId: fields.requestedByUserId,
      vcsUrl: pullRequestWebUrl(repository.full_name, pr),
      parentTaskId: fields.parentTaskId,
      contextKey: contextKeyOf(event),
    },
    { origin: "webhook" },
  );
  return { created: true, taskId: task.id };
}

// ── Event Handlers ──

/**
 * `pullrequest:created`: a bot mention in the description, or the bot listed
 * as a reviewer, creates one task.
 */
export async function handlePullRequestCreated(body: unknown): Promise<HandlerResult> {
  const event = pullRequestEventOf(body);
  if (!event) {
    warnMalformed("pullrequest:created");
    return { created: false };
  }
  const { pullrequest: pr, repository } = event;
  const repo = repository.full_name;
  const author = pr.author ?? event.actor;
  console.log(`[Bitbucket] PR #${pr.id} created by ${author.display_name} in ${repo}`);

  const botAccountId = await resolveBitbucketBotAccountId();
  if (isBot(author, botAccountId)) {
    console.log(`[Bitbucket] PR opened by the bot itself, skipping`);
    return { created: false };
  }

  const mentioned = detectMention(pr.description, botAccountId);
  const reviewRequested =
    !!botAccountId && (pr.reviewers ?? []).some((r) => r.account_id === botAccountId);
  if (!mentioned && !reviewRequested) {
    console.log(`[Bitbucket] PR opened without bot mention or review request, skipping`);
    return { created: false };
  }

  const dedupKey = `bitbucket-pr-${repository.uuid}-${pr.id}-created`;
  const outcome = await withDedupReservation(dedupKey, async () => {
    const requestedByUserId = await resolveBitbucketSender(
      author,
      "pull_request",
      `PR #${pr.id}: ${pr.title}`,
    );

    const context = pr.description ? extractMentionContext(pr.description, botAccountId) : "";
    // A mention is the explicit ask; the reviewer template is for a bare review request.
    const templateId = mentioned
      ? "bitbucket.pull_request.opened"
      : "bitbucket.pull_request.review_requested";
    const result = resolveTemplate(templateId, {
      pr_id: pr.id,
      pr_title: pr.title,
      repo,
      username: await renderBitbucketIdentity(author),
      source_branch: pr.source?.branch?.name ?? "",
      target_branch: pr.destination?.branch?.name ?? "",
      pr_url: pullRequestWebUrl(repo, pr),
      context_section: context ? `Context: ${context}\n\n` : "",
    });
    if (result.skipped) {
      return { created: false };
    }

    return createBitbucketTask(result.text, event, {
      taskType: "bitbucket-pr",
      vcsEventType: "pull_request",
      author,
      requestedByUserId,
    });
  });
  if (!outcome) console.log(`[Bitbucket] Skipping duplicate PR event`);
  return outcome ?? { created: false };
}

/**
 * `pullrequest:comment_created`: a bot mention in a new PR comment (general or
 * inline) creates a task, linked to any active task for the same PR.
 */
export async function handlePullRequestCommentCreated(body: unknown): Promise<HandlerResult> {
  const event = pullRequestCommentEventOf(body);
  if (!event) {
    warnMalformed("pullrequest:comment_created");
    return { created: false };
  }
  const { pullrequest: pr, repository, comment } = event;
  const repo = repository.full_name;
  const author = comment.user ?? event.actor;

  const botAccountId = await resolveBitbucketBotAccountId();
  if (isBot(author, botAccountId)) {
    return { created: false };
  }
  if (!detectMention(comment.content.raw, botAccountId)) {
    return { created: false };
  }

  console.log(`[Bitbucket] Comment by ${author.display_name} on PR #${pr.id} in ${repo}`);

  const dedupKey = `bitbucket-comment-${repository.uuid}-${pr.id}-${comment.id}`;
  const outcome = await withDedupReservation(dedupKey, async () => {
    const requestedByUserId = await resolveBitbucketSender(
      author,
      "pull_request_comment",
      comment.content.raw,
    );

    const existingTask = await findTaskByVcs(repo, pr.id, "bitbucket");
    const existingTaskNote = existingTask
      ? `\n\n_Note: There's an active task (${existingTask.id}) for this PR #${pr.id}._`
      : "";

    const line = comment.inline?.to ?? comment.inline?.from;
    const locationSection = comment.inline
      ? `File: ${comment.inline.path}${line != null ? `:${line}` : ""}\n`
      : "";

    const result = resolveTemplate("bitbucket.comment.mentioned", {
      pr_id: pr.id,
      pr_title: pr.title,
      username: await renderBitbucketIdentity(author),
      repo,
      pr_url: comment.links?.html?.href ?? pullRequestWebUrl(repo, pr),
      location_section: locationSection,
      context: extractMentionContext(comment.content.raw, botAccountId),
      existing_task_note: existingTaskNote,
    });
    if (result.skipped) {
      return { created: false };
    }

    return createBitbucketTask(result.text, event, {
      taskType: "bitbucket-comment",
      vcsEventType: "pull_request_comment",
      author,
      requestedByUserId,
      vcsCommentId: comment.id,
      parentTaskId: existingTask?.id,
    });
  });
  return outcome ?? { created: false };
}

/**
 * `pullrequest:fulfilled` / `pullrequest:rejected`: cancel every active task
 * for the PR.
 */
export async function handlePullRequestClosed(
  body: unknown,
  outcome: "merged" | "declined",
): Promise<HandlerResult> {
  const event = pullRequestEventOf(body);
  if (!event) {
    warnMalformed(outcome === "merged" ? "pullrequest:fulfilled" : "pullrequest:rejected");
    return { created: false };
  }
  const { pullrequest: pr, repository } = event;
  // Every active task, not only the newest: a comment task is a child of the
  // PR task, and failTask does not cascade up to the parent.
  const reason = outcome === "merged" ? "PR was merged" : "PR was declined";
  for (const task of await findActiveTasksByVcs(repository.full_name, pr.id, "bitbucket")) {
    console.log(`[Bitbucket] Cancelling task ${task.id} — ${reason}`);
    await failTask(task.id, reason);
  }
  return { created: false };
}
