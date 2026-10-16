/**
 * Azure Boards (work item) service-hook handlers.
 *
 * Mirrors src/jira/sync.ts:
 * - A work item assigned to the bot, or a bot mention in a description or
 *   comment, creates a swarm task linked to the work item via `tracker_sync`
 * - `createTrackerSyncIfAbsent` claims the work item before the task exists,
 *   so concurrent deliveries cannot create two tasks
 * - Deliveries are deduplicated on the service-hook notification id: an
 *   in-flight claim blocks concurrent retries, and a durable receipt is written
 *   only after the delivery was handled, so a failed one stays retryable
 * - Work-item ids are organization-local, so tracker keys carry the organization
 * - Events from an organization other than the configured one are dropped
 *   before any credentialed request; only actors mapped to a swarm user (or
 *   listed in AZURE_DEVOPS_ALLOWED_ACTORS) can create tasks
 * - Deleting a work item cancels its task; restoring it re-engages the swarm
 *
 * Payload facts (verified against real deliveries, resourceVersion 1.0):
 * - Identities in work-item fields are strings: "Display Name <unique@name>"
 * - `workitem.updated`: `resource.id` is the update id, the work item is
 *   `resource.workItemId`, and the hook also fires on comments, so assignment
 *   is detected from the `System.AssignedTo` field change
 * - `workitem.commented`: the comment HTML is `fields["System.History"]`
 */

import { cancelTask, getKv, getTaskById, upsertKv } from "../be/db";
import {
  createTrackerSyncIfAbsent,
  deleteTrackerSync,
  getTrackerSyncByExternalId,
  hasTrackerDelivery,
  markTrackerDelivery,
  updateTrackerSyncSwarmId,
} from "../be/db-queries/tracker";
import { resolveTemplate } from "../prompts/resolver";
import { azureDevOpsWorkItemContextKey } from "../tasks/context-key";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import type { TrackerSync } from "../tracker/types";
import { isTerminalTaskStatus } from "../types";
import { workflowEventBus } from "../workflows/event-bus";
import { resolveAzureDevOpsBotIdentity } from "./api";
import {
  AZURE_DEVOPS_BOT_NAME,
  getAzureDevOpsOrgUrl,
  isTrustedOrgUrl,
  normalizeOrgUrl,
  orgKeyOf,
} from "./auth";
import {
  authorizeAzureDevOpsActor,
  detectMention,
  escapeRegExp,
  findLeadAgent,
  renderAzureDevOpsIdentity,
  warnMalformed,
} from "./handlers";
import { htmlToText } from "./html";
// Side-effect import: registers all Azure DevOps event templates in the in-memory registry
import "./templates";
import type {
  AzureDevOpsIdentityRef,
  AzureDevOpsWorkItem,
  AzureDevOpsWorkItemFields,
  AzureDevOpsWorkItemUpdate,
  WorkItemCommentedEvent,
  WorkItemCreatedEvent,
  WorkItemDeletedEvent,
  WorkItemRestoredEvent,
  WorkItemUpdatedEvent,
} from "./types";

type HandlerResult = { created: boolean; taskId?: string };

const PROVIDER = "azure-devops";
const DELETED_REASON = "Azure DevOps work item deleted";
const DESCRIPTION_LIMIT = 4000;

// ── Payload guards ──

function hasFields(value: unknown): value is AzureDevOpsWorkItemFields {
  return typeof value === "object" && value !== null;
}

/** The work item of a created / commented / deleted / restored event, or null when malformed. */
export function workItemOf(
  event:
    | WorkItemCreatedEvent
    | WorkItemCommentedEvent
    | WorkItemDeletedEvent
    | WorkItemRestoredEvent
    | null
    | undefined,
): AzureDevOpsWorkItem | null {
  const resource = event?.resource;
  if (typeof event?.id !== "string" || typeof resource?.id !== "number") return null;
  return hasFields(resource.fields) ? resource : null;
}

/** The update of a `workitem.updated` event, or null when malformed. */
export function updatedPayloadOf(
  event: WorkItemUpdatedEvent | null | undefined,
): AzureDevOpsWorkItemUpdate | null {
  const resource = event?.resource;
  if (typeof event?.id !== "string" || typeof resource?.workItemId !== "number") return null;
  return hasFields(resource.revision?.fields) ? resource : null;
}

// ── Identity and mention helpers ──

/** Parse `"Display Name <unique@name>"`; a bare string is a display name. */
export function parseIdentityString(value: unknown): AzureDevOpsIdentityRef | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const match = value.match(/^(.*?)\s*<([^>]+)>\s*$/);
  const displayName = (match?.[1] || value).trim();
  const uniqueName = match?.[2]?.trim();
  return { id: uniqueName ?? displayName, displayName, uniqueName };
}

interface Bot {
  id: string | null;
  uniqueName: string | null;
}

/** Throws AzureDevOpsLookupError on a transient failure, so the delivery is retried. */
async function resolveBot(orgUrl: string | null): Promise<Bot> {
  return await resolveAzureDevOpsBotIdentity(orgUrl);
}

function isBotIdentity(identity: AzureDevOpsIdentityRef | null, bot: Bot): boolean {
  if (!identity) return false;
  if (bot.id && identity.id.toLowerCase() === bot.id.toLowerCase()) return true;
  const name = identity.uniqueName?.toLowerCase();
  return !!name && !!bot.uniqueName && name === bot.uniqueName.toLowerCase();
}

function isBotString(value: unknown, bot: Bot): boolean {
  return isBotIdentity(parseIdentityString(value), bot);
}

/** `<a data-vss-mention="version:2.0,{GUID}">@Name</a>`, as the identity picker writes it. */
function pickerMentionPattern(botId: string): RegExp {
  return new RegExp(
    `<a\\b[^>]*data-vss-mention="version:[\\d.]+,${escapeRegExp(botId)}"[^>]*>.*?</a>`,
    "gi",
  );
}

/** Plain-text patterns: `@AZURE_DEVOPS_BOT_NAME` and `@<local part of the bot sign-in name>`. */
function plainMentionPatterns(bot: Bot): RegExp[] {
  const names = [AZURE_DEVOPS_BOT_NAME];
  const local = bot.uniqueName?.split("@")[0];
  if (local) names.push(local);
  return names.map((name) => new RegExp(`@${escapeRegExp(name)}(?![\\w-])`, "gi"));
}

/** Whether `html` mentions the bot, and the text with the mention removed. */
function inspectMention(
  html: string | null | undefined,
  bot: Bot,
): { mentioned: boolean; text: string } {
  if (!html) return { mentioned: false, text: "" };
  let withoutPicker = html;
  let mentioned = false;
  if (bot.id) {
    const re = pickerMentionPattern(bot.id);
    mentioned = re.test(html);
    withoutPicker = html.replace(re, "");
  }
  let text = htmlToText(withoutPicker);
  const plain = plainMentionPatterns(bot);
  if (plain.some((re) => re.test(text)) || detectMention(text, null)) {
    mentioned = true;
  }
  for (const re of plain) text = text.replace(re, "");
  return { mentioned, text: text.trim() };
}

// ── Work item location ──

interface Org {
  /** Trusted organization URL, no trailing slash. */
  url: string;
  /** Canonical, lowercased organization identity, e.g. `dev.azure.com/acme`. */
  key: string;
}

/**
 * The organization a delivery belongs to, or null when it must be dropped.
 * Payload URLs are attacker-influenced, so they only select among trusted
 * organizations: with AZURE_DEVOPS_ORG_URL set they must match it, otherwise
 * they must be public Azure DevOps HTTPS URLs. Nothing credentialed runs
 * before this check.
 */
function orgFor(event: {
  resource?: { url?: string };
  resourceContainers?: {
    account?: { baseUrl?: string };
    collection?: { baseUrl?: string };
  };
}): Org | null {
  const containers = event.resourceContainers;
  const fromUrl = event.resource?.url?.split("/_apis/")[0];
  const candidates = [
    containers?.account?.baseUrl,
    containers?.collection?.baseUrl,
    fromUrl?.includes("://") ? fromUrl : undefined,
  ]
    .map((url) => normalizeOrgUrl(url))
    .filter((url): url is string => !!url);
  const configured = getAzureDevOpsOrgUrl();
  const url = candidates[0] ?? configured;
  if (!url || !isTrustedOrgUrl(url)) return null;
  // Every payload source must agree on one organization.
  const key = orgKeyOf(url);
  if (!key || candidates.some((c) => orgKeyOf(c) !== key)) return null;
  return { url, key };
}

function dropUntrustedOrg(eventType: string): HandlerResult {
  console.warn(`[AzureDevOps] Dropping ${eventType} event from an untrusted organization`);
  return { created: false };
}

/** Tracker `externalId`: work-item ids repeat across organizations. */
function trackerKey(org: Org, workItemId: number): string {
  return `${org.key}#${workItemId}`;
}

/** Organization name: the path segment of `dev.azure.com/{org}`, or the host label of `{org}.visualstudio.com`. */
function organizationOf(orgUrl: string | null): string {
  if (!orgUrl) return "unknown";
  try {
    const url = new URL(orgUrl);
    const segment = url.pathname.split("/").find(Boolean);
    return (segment ?? url.hostname.split(".")[0] ?? "unknown").replace(/:/g, "_");
  } catch {
    return "unknown";
  }
}

interface WorkItemContext {
  eventId: string;
  eventType: string;
  workItemId: number;
  fields: AzureDevOpsWorkItemFields;
  org: Org;
  /** Person that caused the event, as an identity object. */
  actor: AzureDevOpsIdentityRef | null;
}

function workItemUrl(ctx: WorkItemContext): string {
  const project = ctx.fields["System.TeamProject"];
  const base = ctx.org.url;
  return project
    ? `${base}/${encodeURIComponent(project)}/_workitems/edit/${ctx.workItemId}`
    : `${base}/_workitems/edit/${ctx.workItemId}`;
}

// ── Dedup and serialization ──

const RECEIPT_NAMESPACE = "integration:azure-devops:deliveries";
const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const inFlight = new Map<string, Promise<HandlerResult>>();

/**
 * Run `fn` once per `key`. A concurrent delivery with the same key shares the
 * first attempt's promise, so it observes that attempt's success or failure
 * instead of being acknowledged early. The durable receipt is only written after
 * `fn` returned, so a thrown error leaves every waiting delivery retryable.
 */
function withReceipt(key: string, fn: () => Promise<HandlerResult>): Promise<HandlerResult> {
  const pending = inFlight.get(key);
  // A waiter rethrows the first attempt's failure; on success it is a duplicate, so it creates nothing.
  if (pending) return pending.then(() => ({ created: false }));
  const attempt = (async (): Promise<HandlerResult> => {
    if ((await getKv(RECEIPT_NAMESPACE, key)) || (await hasTrackerDelivery(PROVIDER, key))) {
      return { created: false };
    }
    const result = await fn();
    await upsertKv({
      namespace: RECEIPT_NAMESPACE,
      key,
      value: { handledAt: new Date().toISOString() },
      valueType: "json",
      expiresAt: Date.now() + RECEIPT_TTL_MS,
    });
    return result;
  })().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, attempt);
  return attempt;
}

const workItemLocks = new Map<string, Promise<unknown>>();

/** Serialize handling per work item (the API server is the single DB owner, so in-process is enough). */
async function withWorkItemLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (workItemLocks.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  workItemLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (workItemLocks.get(key) === tail) workItemLocks.delete(key);
  }
}

/** Gate, receipt and lock shared by every work-item event. */
async function handleDelivery(
  org: Org,
  eventId: string,
  workItemId: number,
  fn: () => Promise<HandlerResult>,
  extraReceiptKey?: string,
): Promise<HandlerResult> {
  const locked = () => withWorkItemLock(trackerKey(org, workItemId), fn);
  return await withReceipt(eventId, () =>
    extraReceiptKey ? withReceipt(extraReceiptKey, locked) : locked(),
  );
}

// ── Task creation ──

type Trigger = "assigned" | "mentioned_description" | "mentioned_comment" | "restored";

const TRIGGER_LABEL: Record<Trigger, string> = {
  assigned: "work item assigned to the bot",
  mentioned_description: "bot mentioned in the description",
  mentioned_comment: "bot mentioned in a comment",
  restored: "work item restored",
};

async function createWorkItemTask(
  ctx: WorkItemContext,
  trigger: Trigger,
  opts: {
    followup: boolean;
    requestedByUserId: string;
    commentText?: string;
    parentTaskId?: string;
    existingTaskId?: string;
  },
): Promise<string | null> {
  const { fields } = ctx;
  const description = htmlToText(fields["System.Description"]).slice(0, DESCRIPTION_LIMIT);
  const common = {
    work_item_id: ctx.workItemId,
    work_item_type: fields["System.WorkItemType"] ?? "Work item",
    title: fields["System.Title"] ?? "(no title)",
    state: fields["System.State"] ?? "unknown",
    project: fields["System.TeamProject"] ?? "unknown",
    work_item_url: workItemUrl(ctx),
    username: ctx.actor ? await renderAzureDevOpsIdentity(ctx.actor) : "UNKNOWN",
  };

  const templateName = opts.followup
    ? "azure-devops.work_item.followup"
    : trigger === "mentioned_comment"
      ? "azure-devops.work_item.commented"
      : "azure-devops.work_item.assigned";
  const variables =
    templateName === "azure-devops.work_item.followup"
      ? { ...common, trigger: TRIGGER_LABEL[trigger], user_message: opts.commentText ?? "" }
      : templateName === "azure-devops.work_item.commented"
        ? {
            ...common,
            context: opts.commentText ?? "",
            existing_task_note: opts.existingTaskId
              ? `\n\n_Note: There's an active task (${opts.existingTaskId}) for this work item._`
              : "",
          }
        : {
            ...common,
            trigger: TRIGGER_LABEL[trigger],
            description_section: description ? `Description:\n${description}\n\n` : "",
          };

  const result = resolveTemplate(templateName, variables);
  if (result.skipped) return null;

  const lead = await findLeadAgent();
  const task = await createTaskWithSiblingAwareness(
    result.text,
    {
      agentId: lead?.id ?? null,
      routingReason: lead ? "skill" : undefined,
      routingSource: lead ? "engine_default" : undefined,
      source: "azure-devops",
      taskType: "azure-devops-work-item",
      requestedByUserId: opts.requestedByUserId,
      parentTaskId: opts.parentTaskId,
      contextKey: azureDevOpsWorkItemContextKey({
        organization: organizationOf(ctx.org.url),
        workItemId: ctx.workItemId,
      }),
    },
    { origin: "webhook" },
  );
  return task.id;
}

/**
 * Only actors mapped to a swarm user (or allowlisted) may create tasks: the
 * task text is untrusted work-item content handed to a PAT-enabled agent.
 */
async function authorizeActor(ctx: WorkItemContext, trigger: Trigger): Promise<string | null> {
  const userId = ctx.actor
    ? await authorizeAzureDevOpsActor(ctx.actor, "work_item", `${trigger} #${ctx.workItemId}`)
    : null;
  if (!userId) {
    console.warn(
      `[AzureDevOps] Ignoring ${TRIGGER_LABEL[trigger]} on work item #${ctx.workItemId}: actor is not a known swarm user`,
    );
  }
  return userId;
}

/**
 * Claim the work item in `tracker_sync`, then create or follow up a task:
 * - new link → initial task
 * - linked task still active → assignment is ignored; a mention creates a
 *   child task and leaves the link on the original task
 * - linked task terminal (or orphan link) → follow-up task, link repointed
 *
 * Callers hold the work-item lock, so a `pending:` link seen here is an
 * abandoned claim from a crashed delivery, not one in flight.
 */
async function routeToTask(
  ctx: WorkItemContext,
  trigger: Trigger,
  commentText?: string,
): Promise<HandlerResult> {
  const requestedByUserId = await authorizeActor(ctx, trigger);
  if (!requestedByUserId) return { created: false };

  const externalId = trackerKey(ctx.org, ctx.workItemId);
  const claim = await createTrackerSyncIfAbsent({
    provider: PROVIDER,
    entityType: "task",
    providerEntityType: "WorkItem",
    // Unique placeholder (UNIQUE(provider, entityType, swarmId)), replaced once the task exists.
    swarmId: `pending:${PROVIDER}:${externalId}`,
    externalId,
    externalIdentifier: `${ctx.fields["System.TeamProject"] ?? "unknown"}#${ctx.workItemId}`,
    externalUrl: workItemUrl(ctx),
    lastSyncOrigin: "external",
    syncDirection: "inbound",
  });
  const mentioned = trigger === "mentioned_comment" || trigger === "mentioned_description";

  if (claim.inserted) {
    let taskId: string | null = null;
    try {
      taskId = await createWorkItemTask(ctx, trigger, {
        followup: false,
        requestedByUserId,
        commentText,
      });
      if (taskId) {
        await updateTrackerSyncSwarmId(claim.sync.id, taskId);
        await markTrackerDelivery(PROVIDER, "task", externalId, ctx.eventId);
      }
    } finally {
      // No task: release the claim so a retry starts clean.
      if (!taskId) await deleteTrackerSync(claim.sync.id);
    }
    return taskId ? { created: true, taskId } : { created: false };
  }

  const prior =
    claim.sync.swarmId && !claim.sync.swarmId.startsWith("pending:")
      ? await getTaskById(claim.sync.swarmId)
      : null;
  if (prior && !isTerminalTaskStatus(prior.status)) {
    if (!mentioned) {
      console.log(
        `[AzureDevOps] Work item #${ctx.workItemId} re-triggered but task ${prior.id} is ${prior.status}, ignoring`,
      );
      return { created: false };
    }
    const taskId = await createWorkItemTask(ctx, trigger, {
      followup: false,
      requestedByUserId,
      commentText,
      parentTaskId: prior.id,
      existingTaskId: prior.id,
    });
    if (taskId) await markTrackerDelivery(PROVIDER, "task", externalId, ctx.eventId);
    return taskId ? { created: true, taskId } : { created: false };
  }

  const taskId = await createWorkItemTask(ctx, trigger, {
    followup: true,
    requestedByUserId,
    commentText,
  });
  if (!taskId) return { created: false };
  await updateTrackerSyncSwarmId(claim.sync.id, taskId);
  await markTrackerDelivery(PROVIDER, "task", externalId, ctx.eventId);
  return { created: true, taskId };
}

/** Assigned to the bot, else the description mentions it. */
async function triggerFromFields(
  fields: AzureDevOpsWorkItemFields,
  bot: Bot,
): Promise<Trigger | null> {
  if (isBotString(fields["System.AssignedTo"], bot)) return "assigned";
  return inspectMention(fields["System.Description"], bot).mentioned
    ? "mentioned_description"
    : null;
}

// ── Event handlers ──

/** `workitem.created`: assigned to the bot, or the description mentions it. */
export async function handleWorkItemCreated(event: WorkItemCreatedEvent): Promise<HandlerResult> {
  const item = workItemOf(event);
  if (!item) {
    warnMalformed(event);
    return { created: false };
  }
  const org = orgFor(event);
  if (!org) return dropUntrustedOrg(event.eventType);

  return await handleDelivery(org, event.id, item.id, async () => {
    const bot = await resolveBot(org.url);
    const actor = parseIdentityString(item.fields["System.ChangedBy"]);
    if (isBotIdentity(actor, bot)) return { created: false };

    const trigger = await triggerFromFields(item.fields, bot);
    if (!trigger) return { created: false };

    return await routeToTask(
      {
        eventId: event.id,
        eventType: event.eventType,
        workItemId: item.id,
        fields: item.fields,
        org,
        actor,
      },
      trigger,
    );
  });
}

/**
 * `workitem.updated`: only a change of `System.AssignedTo` to the bot triggers.
 * The hook also fires on comments and every other edit, so the field diff is
 * the filter, not the subscription.
 */
export async function handleWorkItemUpdated(event: WorkItemUpdatedEvent): Promise<HandlerResult> {
  const update = updatedPayloadOf(event);
  if (!update) {
    warnMalformed(event);
    return { created: false };
  }
  const change = update.fields?.["System.AssignedTo"];
  if (!change) return { created: false };
  const org = orgFor(event);
  if (!org) return dropUntrustedOrg(event.eventType);

  const routeAssignment = async (): Promise<HandlerResult> => {
    const bot = await resolveBot(org.url);
    if (!isBotString(change.newValue, bot) || isBotString(change.oldValue, bot)) {
      return { created: false };
    }
    if (isBotIdentity(update.revisedBy ?? null, bot)) return { created: false };

    return await routeToTask(
      {
        eventId: event.id,
        eventType: event.eventType,
        workItemId: update.workItemId,
        fields: update.revision.fields,
        org,
        actor: update.revisedBy ?? null,
      },
      "assigned",
    );
  };

  return await handleDelivery(org, event.id, update.workItemId, async () => {
    const result = await routeAssignment();
    // Published inside the receipt and lock so a retried delivery cannot repeat it.
    workflowEventBus.emit("azure-devops.work_item.assigned", {
      work_item_id: update.workItemId,
      title: update.revision.fields["System.Title"],
      project: update.revision.fields["System.TeamProject"],
      action: "assigned",
      assigned_to: change.newValue,
      previous_assignee: change.oldValue,
      user_login: update.revisedBy?.uniqueName ?? update.revisedBy?.id,
    });
    return result;
  });
}

/** `workitem.commented`: a bot mention in a newly published comment. */
export async function handleWorkItemCommented(
  event: WorkItemCommentedEvent,
): Promise<HandlerResult> {
  const item = workItemOf(event);
  if (!item) {
    warnMalformed(event);
    return { created: false };
  }
  // An edit re-fires the event with a higher comment version; only the first
  // version triggers, so fixing a typo in a mention does not spawn a second task.
  const ref = item.commentVersionRef;
  if (ref && ref.version > 1) return { created: false };
  const org = orgFor(event);
  if (!org) return dropUntrustedOrg(event.eventType);

  const routeComment = async (): Promise<HandlerResult> => {
    const bot = await resolveBot(org.url);
    const actor = parseIdentityString(item.fields["System.ChangedBy"]);
    if (isBotIdentity(actor, bot)) return { created: false };

    const { mentioned, text } = inspectMention(item.fields["System.History"], bot);
    if (!mentioned) return { created: false };

    return await routeToTask(
      {
        eventId: event.id,
        eventType: event.eventType,
        workItemId: item.id,
        fields: item.fields,
        org,
        actor,
      },
      "mentioned_comment",
      text,
    );
  };

  const commentKey = ref ? `comment:${trackerKey(org, item.id)}:${ref.commentId}` : undefined;
  return await handleDelivery(
    org,
    event.id,
    item.id,
    async () => {
      const result = await routeComment();
      // Published inside the receipt and lock so a retried delivery cannot repeat it.
      workflowEventBus.emit("azure-devops.work_item.commented", {
        work_item_id: item.id,
        title: item.fields["System.Title"],
        project: item.fields["System.TeamProject"],
        action: "commented",
        comment: item.fields["System.History"],
        user_login: item.fields["System.ChangedBy"],
      });
      return result;
    },
    commentKey,
  );
}

/** `workitem.deleted`: cancel the linked task if it is still active. The link stays for a restore. */
export async function handleWorkItemDeleted(event: WorkItemDeletedEvent): Promise<HandlerResult> {
  const item = workItemOf(event);
  if (!item) {
    warnMalformed(event);
    return { created: false };
  }
  const org = orgFor(event);
  if (!org) return dropUntrustedOrg(event.eventType);

  return await handleDelivery(org, event.id, item.id, async () => {
    const externalId = trackerKey(org, item.id);
    const sync = await getTrackerSyncByExternalId(PROVIDER, "task", externalId);
    if (!sync) return { created: false };

    const task =
      sync.swarmId && !sync.swarmId.startsWith("pending:") ? await getTaskById(sync.swarmId) : null;
    if (task && !isTerminalTaskStatus(task.status)) {
      await cancelTask(task.id, DELETED_REASON);
      console.log(`[AzureDevOps] Cancelled task ${task.id} (work item #${item.id} deleted)`);
    }
    await markTrackerDelivery(PROVIDER, "task", externalId, event.id);
    return { created: false };
  });
}

/**
 * `workitem.restored`: the inverse of deleted.
 * - Linked, and the task was cancelled by the delete: re-engage with a
 *   follow-up task when the work item is still assigned to the bot.
 * - Linked otherwise: nothing to undo.
 * - Never linked: handled like `workitem.created`.
 */
export async function handleWorkItemRestored(event: WorkItemRestoredEvent): Promise<HandlerResult> {
  const item = workItemOf(event);
  if (!item) {
    warnMalformed(event);
    return { created: false };
  }
  const org = orgFor(event);
  if (!org) return dropUntrustedOrg(event.eventType);

  return await handleDelivery(org, event.id, item.id, async () => {
    const bot = await resolveBot(org.url);
    const actor = parseIdentityString(item.fields["System.ChangedBy"]);
    const ctx: WorkItemContext = {
      eventId: event.id,
      eventType: event.eventType,
      workItemId: item.id,
      fields: item.fields,
      org,
      actor,
    };

    const externalId = trackerKey(org, item.id);
    const sync: TrackerSync | null = await getTrackerSyncByExternalId(PROVIDER, "task", externalId);
    if (!sync) {
      if (isBotIdentity(actor, bot)) return { created: false };
      const trigger = await triggerFromFields(item.fields, bot);
      return trigger ? await routeToTask(ctx, trigger) : { created: false };
    }

    const task =
      sync.swarmId && !sync.swarmId.startsWith("pending:") ? await getTaskById(sync.swarmId) : null;
    const cancelledByDelete = task?.status === "cancelled" && task.failureReason === DELETED_REASON;
    if (!cancelledByDelete || !isBotString(item.fields["System.AssignedTo"], bot)) {
      await markTrackerDelivery(PROVIDER, "task", externalId, event.id);
      return { created: false };
    }
    const requestedByUserId = await authorizeActor(ctx, "restored");
    if (!requestedByUserId) return { created: false };
    const taskId = await createWorkItemTask(ctx, "restored", { followup: true, requestedByUserId });
    if (!taskId) return { created: false };
    await updateTrackerSyncSwarmId(sync.id, taskId);
    await markTrackerDelivery(PROVIDER, "task", externalId, event.id);
    return { created: true, taskId };
  });
}
