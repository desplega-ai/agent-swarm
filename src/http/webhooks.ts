import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { AgentMailWebhookPayload } from "../agentmail";
import {
  handleMessageReceived,
  isAgentMailEnabled,
  isInboxAllowed,
  isSenderAllowed,
  verifyAgentMailWebhook,
} from "../agentmail";
import { archiveInboundMessage } from "../agentmail/inbound-archive";
import type {
  PullRequestCommentedEvent,
  PullRequestCreatedEvent,
  WorkItemCommentedEvent,
  WorkItemCreatedEvent,
  WorkItemDeletedEvent,
  WorkItemRestoredEvent,
  WorkItemUpdatedEvent,
} from "../azure-devops";
import {
  commentedPayloadOf,
  createdPullRequestOf,
  handlePullRequestCommented,
  handlePullRequestCreated,
  handleWorkItemCommented,
  handleWorkItemCreated,
  handleWorkItemDeleted,
  handleWorkItemRestored,
  handleWorkItemUpdated,
  isAzureDevOpsEnabled,
  verifyAzureDevOpsWebhook,
} from "../azure-devops";
import {
  pullRequestCommentEventOf as bitbucketCommentEventOf,
  pullRequestEventOf as bitbucketPullRequestEventOf,
  handlePullRequestClosed as handleBitbucketPullRequestClosed,
  handlePullRequestCommentCreated as handleBitbucketPullRequestCommentCreated,
  handlePullRequestCreated as handleBitbucketPullRequestCreated,
  isBitbucketEnabled,
  isDuplicateDelivery as isDuplicateBitbucketDelivery,
  markDeliveryProcessed as markBitbucketDeliveryProcessed,
  verifyBitbucketWebhook,
} from "../bitbucket";
import type {
  CheckRunEvent,
  CheckSuiteEvent,
  CommentEvent,
  IssueEvent,
  PullRequestEvent,
  PullRequestReviewEvent,
  WorkflowRunEvent,
} from "../github";
import {
  handleCheckRun,
  handleCheckSuite,
  handleComment,
  handleIssue,
  handlePullRequest,
  handlePullRequestReview,
  handleWorkflowRun,
  isGitHubEnabled,
  verifyWebhookSignature,
} from "../github";
import type {
  IssueEvent as GitLabIssueEvent,
  MergeRequestEvent,
  NoteEvent,
  PipelineEvent,
} from "../gitlab";
import {
  handleIssue as handleGitLabIssue,
  handleMergeRequest,
  handleNote,
  handlePipeline,
  isGitLabEnabled,
  verifyGitLabWebhook,
} from "../gitlab";
import { gitlabWorkflowActionName } from "../gitlab/workflow-action-name";
import { trackBackground } from "../integrations/chat-sdk/background";
import { isChatSdkEnabled } from "../integrations/chat-sdk/config";
import {
  getChatInstance,
  isChatAdapterConfigured,
  isChatSdkStopping,
} from "../integrations/chat-sdk/runtime";
import { isTrustedTeamsServiceUrl } from "../integrations/chat-sdk/teams-origin";
import {
  type KapsoMessageActionResult,
  markKapsoMessageRead,
  sendKapsoReaction,
} from "../integrations/kapso/client";
import type { KapsoConfig } from "../integrations/kapso/config";
import { getKapsoConfig } from "../integrations/kapso/config";
import type { KapsoWebhookPayload } from "../integrations/kapso/inbound";
import { resolveKapsoRequestedByUserId, routeKapsoInbound } from "../integrations/kapso/inbound";
import { TaskCreationBlockedError } from "../tasks/errors";
import { getPublicMcpBaseUrl } from "../utils/constants";
import { scrubSecrets } from "../utils/secret-scrubber";
import { canonicalAzureDevOpsRepoUrl } from "../vcs/azure-devops";
import { getExecutorRegistry } from "../workflows";
import { workflowEventBus } from "../workflows/event-bus";
import { handleWebhookTrigger, verifyHmacSignature, WebhookError } from "../workflows/triggers";
import { route } from "./route-def";
import { BODY_TOO_LARGE, enforceContentLengthCap, jsonError } from "./utils";

// ─── Route Definitions (documentation only — webhooks handle their own body parsing) ─

/**
 * Shared shape returned by the GitHub/GitLab/Azure DevOps dispatch handlers in
 * ../github/handlers.ts, ../gitlab/handlers.ts and ../azure-devops/handlers.ts — `{ created: boolean;
 * taskId?: string }`, echoed back verbatim as the webhook ack body.
 */
const WebhookDispatchResultSchema = z.object({
  created: z.boolean(),
  taskId: z.string().optional(),
  skipped: z.boolean().optional(),
  reason: z.string().optional(),
  extension: z.object({ id: z.string(), name: z.string() }).optional(),
});

type WebhookDispatchResult = z.infer<typeof WebhookDispatchResultSchema>;

/**
 * Runs a webhook's task-creating handler. A `pre.task.create` extension block
 * is an expected outcome, not a server error: the delivery is acked with a
 * skipped result so the provider does not retry and the caller still emits the
 * delivery's workflow events. Any other error propagates.
 */
async function runBlockableHandler(
  source: string,
  handler: () => Promise<WebhookDispatchResult>,
): Promise<WebhookDispatchResult> {
  try {
    return await handler();
  } catch (err) {
    if (!(err instanceof TaskCreationBlockedError)) throw err;
    console.log(
      `[${source}] Task creation blocked by extension ${err.extension.name}: ${err.reason}`,
    );
    return { created: false, skipped: true, reason: err.reason, extension: err.extension };
  }
}

const githubWebhook = route({
  method: "post",
  path: "/api/github/webhook",
  pattern: ["api", "github", "webhook"],
  summary: "Handle GitHub webhook events",
  tags: ["Webhooks"],
  auth: { apiKey: false },
  responses: {
    200: {
      description: "Event processed",
      schema: z.union([z.object({ message: z.literal("pong") }), WebhookDispatchResultSchema]),
    },
    401: { description: "Invalid signature" },
    503: { description: "GitHub integration not configured" },
  },
});

const gitlabWebhook = route({
  method: "post",
  path: "/api/gitlab/webhook",
  pattern: ["api", "gitlab", "webhook"],
  summary: "Handle GitLab webhook events",
  tags: ["Webhooks"],
  auth: { apiKey: false },
  responses: {
    200: { description: "Event processed", schema: WebhookDispatchResultSchema },
    401: { description: "Invalid token" },
    503: { description: "GitLab integration not configured" },
  },
});

const azureDevOpsWebhook = route({
  method: "post",
  path: "/api/azure-devops/webhook",
  pattern: ["api", "azure-devops", "webhook"],
  summary: "Handle Azure DevOps service-hook events",
  tags: ["Webhooks"],
  auth: { apiKey: false },
  rbac: {
    ungated:
      "provider webhook: authenticated by the service-hook Basic auth secret, not a swarm principal",
  },
  responses: {
    200: { description: "Event processed", schema: WebhookDispatchResultSchema },
    401: { description: "Invalid Basic auth credentials" },
    503: { description: "Azure DevOps integration not configured" },
  },
});

const bitbucketWebhook = route({
  method: "post",
  path: "/api/bitbucket/webhook",
  pattern: ["api", "bitbucket", "webhook"],
  summary: "Handle Bitbucket Cloud webhook events",
  tags: ["Webhooks"],
  auth: { apiKey: false },
  rbac: {
    ungated:
      "provider webhook: authenticated by the per-webhook HMAC secret, not a swarm principal",
  },
  responses: {
    200: { description: "Event processed", schema: WebhookDispatchResultSchema },
    401: { description: "Invalid signature" },
    413: { description: "Body exceeds 1 MiB" },
    503: { description: "Bitbucket integration not configured" },
  },
});

/** Bitbucket Cloud event payloads are far below this. */
const BITBUCKET_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

const agentmailWebhook = route({
  method: "post",
  path: "/api/agentmail/webhook",
  pattern: ["api", "agentmail", "webhook"],
  summary: "Handle AgentMail webhook events",
  tags: ["Webhooks"],
  auth: { apiKey: false },
  responses: {
    200: { description: "Event received", schema: z.object({ received: z.literal(true) }) },
    401: { description: "Invalid signature" },
    503: { description: "AgentMail integration not configured or inbound archive unavailable" },
  },
});

const kapsoWebhook = route({
  method: "post",
  path: "/api/integrations/kapso/webhook",
  pattern: ["api", "integrations", "kapso", "webhook"],
  summary: "Handle native Kapso/WhatsApp webhook events",
  tags: ["Webhooks"],
  auth: { apiKey: false },
  responses: {
    200: {
      description: "Event received",
      schema: z.object({
        received: z.literal(true),
        routing: z.enum(["skip", "duplicate", "workflow", "task", "no_mapping", "error"]),
      }),
    },
    401: { description: "Invalid signature" },
    503: { description: "Kapso integration not configured" },
  },
});

const chatSdkWebhook = route({
  method: "post",
  path: "/api/integrations/chat/{adapter}/webhook",
  pattern: ["api", "integrations", "chat", null, "webhook"],
  summary: "Handle Chat SDK platform webhooks (Telegram, Slack, Discord, Teams)",
  tags: ["Webhooks"],
  params: z.object({ adapter: z.string().describe("Chat SDK adapter name, e.g. telegram") }),
  auth: { apiKey: false },
  rbac: {
    ungated:
      "provider webhook: the Chat SDK adapter verifies the platform signature (Telegram secret token, Slack signing secret, Discord Ed25519, Teams JWT)",
  },
  responses: {
    200: { description: "Adapter response", unstructured: "adapter response proxied as-is" },
    401: { description: "Invalid platform signature or secret token" },
    403: { description: "Teams activity whose serviceUrl is not a Bot Framework host" },
    404: { description: "Chat SDK disabled or adapter not configured" },
    413: { description: "Body exceeds 1 MiB" },
    503: { description: "Adapter configured but failed to start" },
  },
});

/**
 * Upper bound for a Chat SDK webhook body. Platform payloads are a few KB and
 * files travel by URL, so anything larger is not a platform delivery.
 */
const CHAT_SDK_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

// ─── Handler ─────────────────────────────────────────────────────────────────

/** False when a Teams activity body carries a `serviceUrl` that is not a Bot Framework host. */
function hasTrustedTeamsServiceUrl(body: Buffer): boolean {
  let serviceUrl: unknown;
  try {
    serviceUrl = (JSON.parse(body.toString("utf-8")) as { serviceUrl?: unknown } | null)
      ?.serviceUrl;
  } catch {
    // Not JSON: the adapter rejects it.
    return true;
  }
  if (serviceUrl === undefined || serviceUrl === null || serviceUrl === "") return true;
  return typeof serviceUrl === "string" && isTrustedTeamsServiceUrl(serviceUrl);
}

/**
 * Rebuild a Fetch `Request` from the raw Node request. Headers come from
 * `rawHeaders` pairs: building `Headers` from `IncomingMessage.headers`
 * comma-joins repeated values, which breaks signature checks.
 */
function toFetchRequest(req: IncomingMessage, rawBody: Buffer, fallbackPath: string): Request {
  const headers = new Headers();
  if (Array.isArray(req.rawHeaders) && req.rawHeaders.length > 0) {
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      headers.append(req.rawHeaders[i] as string, req.rawHeaders[i + 1] as string);
    }
  } else {
    for (const [name, value] of Object.entries(req.headers)) {
      for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
        headers.append(name, item);
      }
    }
  }
  return new Request(`${getPublicMcpBaseUrl()}${req.url ?? fallbackPath}`, {
    method: req.method ?? "POST",
    headers,
    body: rawBody.length > 0 ? new Uint8Array(rawBody) : undefined,
  });
}

function logKapsoAckResult(action: string, result: KapsoMessageActionResult): void {
  if (result.ok) return;
  console.warn(
    `[Kapso] Inbound acknowledgement ${action} failed: ${
      result.errorMessage ?? `status ${result.status}`
    }`,
  );
}

async function acknowledgeKapsoInboundMessage(
  payload: KapsoWebhookPayload,
  config: KapsoConfig,
): Promise<void> {
  const message = payload.message;
  const phoneNumberId = payload.phone_number_id;
  const messageId = message?.id;
  const to = message?.from ?? payload.conversation?.phone_number;

  if (payload.test || message?.kapso?.direction !== "inbound" || !phoneNumberId || !messageId) {
    return;
  }

  if (!config.apiKey) {
    console.warn("[Kapso] Cannot acknowledge inbound message: KAPSO_API_KEY is not configured");
    return;
  }

  const markRead = markKapsoMessageRead({
    apiBaseUrl: config.apiBaseUrl,
    apiKey: config.apiKey,
    phoneNumberId,
    messageId,
    typingIndicatorType: "text",
  });
  const react =
    to && to.length > 0
      ? sendKapsoReaction({
          apiBaseUrl: config.apiBaseUrl,
          apiKey: config.apiKey,
          phoneNumberId,
          to,
          messageId,
          emoji: "👀",
        })
      : Promise.resolve<KapsoMessageActionResult>({
          ok: false,
          status: 0,
          raw: null,
          errorMessage: "missing sender phone",
        });

  const [readResult, reactionResult] = await Promise.allSettled([markRead, react]);
  if (readResult.status === "fulfilled") {
    logKapsoAckResult("mark-as-read/typing", readResult.value);
  } else {
    console.warn(
      `[Kapso] Inbound acknowledgement mark-as-read/typing failed: ${readResult.reason}`,
    );
  }
  if (reactionResult.status === "fulfilled") {
    logKapsoAckResult("reaction", reactionResult.value);
  } else {
    console.warn(`[Kapso] Inbound acknowledgement reaction failed: ${reactionResult.reason}`);
  }
}

export async function handleWebhooks(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
): Promise<boolean> {
  // GitHub webhook — needs raw body for signature verification
  if (githubWebhook.match(req.method, pathSegments)) {
    if (!isGitHubEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "GitHub integration not configured" }));
      return true;
    }

    const eventType = req.headers["x-github-event"] as string | undefined;
    const signature = req.headers["x-hub-signature-256"] as string | undefined;

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString();

    const isValid = await verifyWebhookSignature(rawBody, signature ?? null);
    if (!isValid) {
      console.log("[GitHub] Invalid webhook signature");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid signature" }));
      return true;
    }

    if (eventType === "ping") {
      console.log("[GitHub] Received ping event - webhook configured successfully");
      githubWebhook.respond(res, 200, { message: "pong" });
      return true;
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return true;
    }

    const deliveryId = req.headers["x-github-delivery"] as string | undefined;
    console.log(`[GitHub] Received ${eventType} event (delivery ${deliveryId ?? "unknown"})`);

    let result: WebhookDispatchResult = { created: false };

    try {
      result = await runBlockableHandler("GitHub", async () => {
        switch (eventType) {
          case "pull_request":
            return await handlePullRequest(body as PullRequestEvent);
          case "issues":
            return await handleIssue(body as IssueEvent);
          case "issue_comment":
            return await handleComment(body as CommentEvent, "issue_comment");
          case "pull_request_review_comment":
            return await handleComment(body as CommentEvent, "pull_request_review_comment");
          case "pull_request_review":
            return await handlePullRequestReview(body as PullRequestReviewEvent);
          case "check_run":
            return await handleCheckRun(body as CheckRunEvent);
          case "check_suite":
            return await handleCheckSuite(body as CheckSuiteEvent);
          case "workflow_run":
            return await handleWorkflowRun(body as WorkflowRunEvent);
          default:
            console.log(`[GitHub] Ignoring unsupported event type: ${eventType}`);
            return { created: false };
        }
      });

      // Emit workflow trigger event for matching event types
      switch (eventType) {
        case "pull_request": {
          const pr = body as PullRequestEvent;
          workflowEventBus.emit(`github.pull_request.${pr.action}`, {
            repo: pr.repository.full_name,
            number: pr.pull_request.number,
            title: pr.pull_request.title,
            body: pr.pull_request.body,
            action: pr.action,
            merged: pr.pull_request.merged ?? false,
            html_url: pr.pull_request.html_url,
            user_login: pr.pull_request.user.login,
            changed_files: pr.pull_request.changed_files,
          });
          break;
        }
        case "issues": {
          const iss = body as IssueEvent;
          workflowEventBus.emit(`github.issue.${iss.action}`, {
            repo: iss.repository.full_name,
            number: iss.issue.number,
            title: iss.issue.title,
            action: iss.action,
          });
          break;
        }
        case "issue_comment": {
          const ic = body as CommentEvent;
          workflowEventBus.emit("github.issue_comment.created", {
            repo: ic.repository.full_name,
            number: ic.issue?.number,
            action: ic.action,
          });
          break;
        }
        case "pull_request_review": {
          const prr = body as PullRequestReviewEvent;
          workflowEventBus.emit("github.pull_request_review.submitted", {
            repo: prr.repository.full_name,
            number: prr.pull_request.number,
            state: prr.review.state,
            action: prr.action,
          });
          break;
        }
      }

      githubWebhook.respond(res, 200, result);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[GitHub] Error handling ${eventType} event: ${errorMessage}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error", message: errorMessage }));
    }
    return true;
  }

  // GitLab webhook — needs raw body + custom token verification
  if (gitlabWebhook.match(req.method, pathSegments)) {
    if (!isGitLabEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "GitLab integration not configured" }));
      return true;
    }

    const token = req.headers["x-gitlab-token"] as string | undefined;
    if (!verifyGitLabWebhook(token)) {
      console.log("[GitLab] Invalid webhook token");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid token" }));
      return true;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString();

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return true;
    }

    const objectKind = (body as { object_kind?: string }).object_kind;
    console.log(`[GitLab] Received ${objectKind} event`);

    let result: WebhookDispatchResult = { created: false };

    try {
      result = await runBlockableHandler("GitLab", async () => {
        switch (objectKind) {
          case "merge_request":
            return await handleMergeRequest(body as MergeRequestEvent);
          case "issue":
            return await handleGitLabIssue(body as GitLabIssueEvent);
          case "note":
            return await handleNote(body as NoteEvent);
          case "pipeline":
            return await handlePipeline(body as PipelineEvent);
          default:
            console.log(`[GitLab] Ignoring unsupported event type: ${objectKind}`);
            return { created: false };
        }
      });

      // Emit workflow trigger events for GitLab
      switch (objectKind) {
        case "merge_request": {
          const mr = body as MergeRequestEvent;
          const action = mr.object_attributes.action;
          const workflowAction = gitlabWorkflowActionName(action);
          const eventPayload = {
            repo: mr.project.path_with_namespace,
            number: mr.object_attributes.iid,
            title: mr.object_attributes.title,
            body: mr.object_attributes.description,
            action,
            merged: mr.object_attributes.state === "merged",
            html_url: mr.object_attributes.url,
            user_login: mr.user.username,
          };
          workflowEventBus.emit(`gitlab.merge_request.${workflowAction}`, eventPayload);
          if (workflowAction !== action) {
            workflowEventBus.emit(`gitlab.merge_request.${action}`, eventPayload);
          }
          break;
        }
        case "issue": {
          const iss = body as GitLabIssueEvent;
          const action = iss.object_attributes.action;
          const workflowAction = gitlabWorkflowActionName(action);
          const eventPayload = {
            repo: iss.project.path_with_namespace,
            number: iss.object_attributes.iid,
            title: iss.object_attributes.title,
            action,
          };
          workflowEventBus.emit(`gitlab.issue.${workflowAction}`, eventPayload);
          if (workflowAction !== action) {
            workflowEventBus.emit(`gitlab.issue.${action}`, eventPayload);
          }
          break;
        }
        case "note": {
          const note = body as NoteEvent;
          workflowEventBus.emit("gitlab.note.created", {
            repo: note.project.path_with_namespace,
            number: note.merge_request?.iid ?? note.issue?.iid,
            action: "created",
          });
          break;
        }
        case "pipeline": {
          const pl = body as PipelineEvent;
          workflowEventBus.emit(`gitlab.pipeline.${pl.object_attributes.status}`, {
            repo: pl.project.path_with_namespace,
            number: pl.merge_request?.iid,
            status: pl.object_attributes.status,
            action: pl.object_attributes.status,
          });
          break;
        }
      }

      gitlabWebhook.respond(res, 200, result);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[GitLab] Error handling ${objectKind} event: ${errorMessage}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
    return true;
  }

  // Azure DevOps service hook — Basic auth secret, JSON body keyed by eventType
  if (azureDevOpsWebhook.match(req.method, pathSegments)) {
    if (!isAzureDevOpsEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Azure DevOps integration not configured" }));
      return true;
    }

    if (!verifyAzureDevOpsWebhook(req.headers.authorization)) {
      console.log("[AzureDevOps] Invalid webhook credentials");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid credentials" }));
      return true;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString();

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return true;
    }

    const eventType = (body as { eventType?: string }).eventType;
    console.log(`[AzureDevOps] Received ${eventType} event`);

    let result: WebhookDispatchResult = { created: false };

    try {
      result = await runBlockableHandler("AzureDevOps", async () => {
        switch (eventType) {
          case "git.pullrequest.created":
            return await handlePullRequestCreated(body as PullRequestCreatedEvent);
          case "ms.vss-code.git-pullrequest-comment-event":
            return await handlePullRequestCommented(body as PullRequestCommentedEvent);
          case "workitem.created":
            return await handleWorkItemCreated(body as WorkItemCreatedEvent);
          case "workitem.updated":
            return await handleWorkItemUpdated(body as WorkItemUpdatedEvent);
          case "workitem.commented":
            return await handleWorkItemCommented(body as WorkItemCommentedEvent);
          case "workitem.deleted":
            return await handleWorkItemDeleted(body as WorkItemDeletedEvent);
          case "workitem.restored":
            return await handleWorkItemRestored(body as WorkItemRestoredEvent);
          default:
            console.log(`[AzureDevOps] Ignoring unsupported event type: ${eventType}`);
            return { created: false };
        }
      });

      // Emit workflow trigger events for Azure DevOps
      switch (eventType) {
        case "git.pullrequest.created": {
          const pr = createdPullRequestOf(body as PullRequestCreatedEvent);
          if (!pr) break;
          workflowEventBus.emit("azure-devops.pull_request.created", {
            repo: canonicalAzureDevOpsRepoUrl(pr.repository.remoteUrl),
            number: pr.pullRequestId,
            title: pr.title,
            body: pr.description,
            action: "created",
            user_login: pr.createdBy.uniqueName ?? pr.createdBy.id,
          });
          break;
        }
        case "ms.vss-code.git-pullrequest-comment-event": {
          const payload = commentedPayloadOf(body as PullRequestCommentedEvent);
          if (!payload) break;
          const { pullRequest: pr, comment } = payload;
          workflowEventBus.emit("azure-devops.pull_request.commented", {
            repo: canonicalAzureDevOpsRepoUrl(pr.repository.remoteUrl),
            number: pr.pullRequestId,
            action: "commented",
            user_login: comment.author.uniqueName ?? comment.author.id,
          });
          break;
        }
      }

      azureDevOpsWebhook.respond(res, 200, result);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[AzureDevOps] Error handling ${eventType} event: ${errorMessage}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
    return true;
  }

  // Bitbucket Cloud webhook — HMAC over the raw body, event keyed by X-Event-Key
  if (bitbucketWebhook.match(req.method, pathSegments)) {
    if (!isBitbucketEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bitbucket integration not configured" }));
      return true;
    }

    // The body is read before the HMAC check, so cap it like the Chat SDK
    // route: reject a declared or streamed body over the limit with 413.
    if (enforceContentLengthCap(req, res, BITBUCKET_WEBHOOK_MAX_BODY_BYTES) === BODY_TOO_LARGE) {
      return true;
    }
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      if (tooLarge) continue;
      receivedBytes += (chunk as Buffer).byteLength;
      if (receivedBytes > BITBUCKET_WEBHOOK_MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        jsonError(res, `Payload too large (max ${BITBUCKET_WEBHOOK_MAX_BODY_BYTES} bytes)`, 413);
        continue;
      }
      chunks.push(chunk as Buffer);
    }
    if (tooLarge) return true;
    const rawBody = Buffer.concat(chunks).toString();

    const signature = req.headers["x-hub-signature"] as string | undefined;
    if (!verifyBitbucketWebhook(rawBody, signature)) {
      console.log("[Bitbucket] Invalid webhook signature");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid signature" }));
      return true;
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return true;
    }

    const eventKey = req.headers["x-event-key"] as string | undefined;
    const requestUuid = req.headers["x-request-uuid"] as string | undefined;
    if (isDuplicateBitbucketDelivery(requestUuid)) {
      console.log(`[Bitbucket] Skipping duplicate delivery ${requestUuid}`);
      bitbucketWebhook.respond(res, 200, { created: false });
      return true;
    }
    console.log(`[Bitbucket] Received ${eventKey} event`);

    try {
      const result = await runBlockableHandler("Bitbucket", async () => {
        switch (eventKey) {
          case "pullrequest:created":
            return await handleBitbucketPullRequestCreated(body);
          case "pullrequest:comment_created":
            return await handleBitbucketPullRequestCommentCreated(body);
          case "pullrequest:fulfilled":
            return await handleBitbucketPullRequestClosed(body, "merged");
          case "pullrequest:rejected":
            return await handleBitbucketPullRequestClosed(body, "declined");
          default:
            console.log(`[Bitbucket] Ignoring unsupported event type: ${eventKey}`);
            return { created: false };
        }
      });

      // Emit workflow trigger events for Bitbucket
      const workflowEvent = {
        "pullrequest:created": "created",
        "pullrequest:comment_created": "commented",
        "pullrequest:fulfilled": "merged",
        "pullrequest:rejected": "declined",
      }[eventKey ?? ""];
      const prEvent = workflowEvent ? bitbucketPullRequestEventOf(body) : null;
      if (workflowEvent && prEvent) {
        const pr = prEvent.pullrequest;
        const comment =
          workflowEvent === "commented" ? bitbucketCommentEventOf(body)?.comment : undefined;
        const user = comment?.user ?? prEvent.actor;
        workflowEventBus.emit(`bitbucket.pull_request.${workflowEvent}`, {
          repo: prEvent.repository.full_name,
          number: pr.id,
          ...(workflowEvent === "commented"
            ? { body: comment?.content.raw }
            : { title: pr.title, body: pr.description ?? undefined }),
          action: workflowEvent,
          user_login: user.account_id ?? user.nickname ?? user.display_name,
        });
      }

      markBitbucketDeliveryProcessed(requestUuid);
      bitbucketWebhook.respond(res, 200, result);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[Bitbucket] Error handling ${eventKey} event: ${scrubSecrets(errorMessage)}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
    return true;
  }

  // AgentMail webhook — needs raw body for Svix signature verification
  if (agentmailWebhook.match(req.method, pathSegments)) {
    if (!isAgentMailEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "AgentMail integration not configured" }));
      return true;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString();

    const svixHeaders: Record<string, string> = {};
    for (const key of ["svix-id", "svix-timestamp", "svix-signature"]) {
      const value = req.headers[key];
      if (typeof value === "string") {
        svixHeaders[key] = value;
      }
    }

    const verified = verifyAgentMailWebhook(rawBody, svixHeaders);
    if (!verified) {
      console.log("[AgentMail] Invalid webhook signature");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid signature" }));
      return true;
    }

    const payload = verified as AgentMailWebhookPayload;
    try {
      await archiveInboundMessage(payload);
    } catch (err) {
      console.error("[AgentMail] Inbound archive failed; requesting webhook retry", err);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Inbound archive unavailable" }));
      return true;
    }
    // Only acknowledge received events after durable capture. Task routing below
    // remains independent: rejected senders and routing failures stay discoverable.
    agentmailWebhook.respond(res, 200, { received: true });

    if (
      payload.message &&
      !isInboxAllowed(payload.message.inbox_id, process.env.AGENTMAIL_INBOX_DOMAIN_FILTER)
    ) {
      console.log(
        `[AgentMail] Ignoring event for inbox "${payload.message.inbox_id}" (not in AGENTMAIL_INBOX_DOMAIN_FILTER)`,
      );
      return true;
    }

    if (
      payload.message &&
      !isSenderAllowed(payload.message.from_, process.env.AGENTMAIL_SENDER_DOMAIN_FILTER)
    ) {
      const from = Array.isArray(payload.message.from_)
        ? payload.message.from_.join(", ")
        : payload.message.from_;
      console.log(
        `[AgentMail] Ignoring event from sender "${from}" (not in AGENTMAIL_SENDER_DOMAIN_FILTER)`,
      );
      return true;
    }
    console.log(`[AgentMail] Received ${payload.event_type} event (${payload.event_id})`);

    try {
      switch (payload.event_type) {
        case "message.received.unauthenticated":
          console.warn(
            `[AgentMail] Received unauthenticated message - treating as received event for inbox ${payload.message?.inbox_id ?? "unknown"}`,
          );

          await handleMessageReceived(payload);
          break;

        case "message.received":
          await handleMessageReceived(payload);
          break;

        default:
          console.log(`[AgentMail] Ignoring event type: ${payload.event_type}`);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[AgentMail] Error handling ${payload.event_type} event: ${errorMessage}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
    }
    return true;
  }

  // Native Kapso/WhatsApp webhook — needs raw body for HMAC verification.
  // Registered numbers route here (register-kapso-number points Kapso's webhook
  // at this URL); the generic workflow-webhook path (/api/webhooks/{id}) is
  // untouched and still serves any number not registered in KV.
  if (kapsoWebhook.match(req.method, pathSegments)) {
    const config = await getKapsoConfig();
    if (!config.webhookHmacSecret) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Kapso integration not configured" }));
      return true;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const rawBody = Buffer.concat(chunks).toString();

    const signature = req.headers["x-webhook-signature"];
    const signatureValue = Array.isArray(signature) ? signature[0] : signature;
    if (
      !signatureValue ||
      !verifyHmacSignature(config.webhookHmacSecret, rawBody, signatureValue)
    ) {
      console.log("[Kapso] Invalid webhook signature");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid signature" }));
      return true;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return true;
    }

    void acknowledgeKapsoInboundMessage(payload, config);

    try {
      const routing = await routeKapsoInbound(payload);
      switch (routing.kind) {
        case "workflow":
          // Advanced override — dispatch through the workflow's webhook trigger.
          // This request was already verified against the Kapso webhook secret
          // over the raw body above, and `routing.workflowId` comes from an
          // operator-registered phone-number mapping — not from the payload. So
          // it does not have to satisfy the "workflow must declare a webhook
          // trigger" gate that protects the public /api/webhooks/:id endpoint.
          await handleWebhookTrigger(
            routing.workflowId,
            rawBody,
            req.headers,
            getExecutorRegistry(),
            {
              alreadyAuthenticated: true,
              requestedByUserId: await resolveKapsoRequestedByUserId(payload),
            },
          );
          break;
        case "no_mapping":
          console.warn(
            `[Kapso] No native mapping for phone_number_id "${routing.phoneNumberId}" — ignoring (register it with register-kapso-number)`,
          );
          break;
        case "task":
          console.log(`[Kapso] Dispatched kapso-inbound task ${routing.taskId}`);
          break;
        case "duplicate":
          console.log(`[Kapso] Duplicate delivery for message ${routing.messageId}, skipping`);
          break;
        case "skip":
          console.log(`[Kapso] Skipping event: ${routing.reason}`);
          break;
      }
      kapsoWebhook.respond(res, 200, { received: true, routing: routing.kind });
    } catch (err) {
      // Never fail the delivery on a downstream dispatch error — we already
      // verified + deduped. Log and ack so Kapso doesn't hammer retries.
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (err instanceof WebhookError) {
        console.warn(`[Kapso] Workflow dispatch rejected: ${errorMessage}`);
      } else {
        console.error(`[Kapso] Error handling inbound event: ${errorMessage}`);
      }
      kapsoWebhook.respond(res, 200, { received: true, routing: "error" });
    }
    return true;
  }

  // Chat SDK webhook: the adapter verifies the platform signature over the raw
  // body, so the request is proxied as-is and the adapter's response returned.
  if (chatSdkWebhook.match(req.method, pathSegments)) {
    const adapterName = pathSegments[3] ?? "";
    if (!isChatSdkEnabled() || !isChatAdapterConfigured(adapterName)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Chat SDK adapter not configured" }));
      return true;
    }
    if (isChatSdkStopping()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Chat SDK is shutting down" }));
      return true;
    }
    const chat = getChatInstance(adapterName);
    const handler = chat?.webhooks[adapterName];
    if (!handler) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Chat SDK adapter failed to start" }));
      return true;
    }

    // The route is unauthenticated and the adapter verifies the signature over
    // the buffered body, so the body is bounded before it is buffered. An
    // oversized stream is answered at once and drained without buffering, the
    // same way `parseBody` keeps the connection usable.
    if (enforceContentLengthCap(req, res, CHAT_SDK_WEBHOOK_MAX_BODY_BYTES) === BODY_TOO_LARGE) {
      return true;
    }
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      if (tooLarge) continue;
      receivedBytes += (chunk as Buffer).byteLength;
      if (receivedBytes > CHAT_SDK_WEBHOOK_MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        jsonError(res, `Payload too large (max ${CHAT_SDK_WEBHOOK_MAX_BODY_BYTES} bytes)`, 413);
        continue;
      }
      chunks.push(chunk as Buffer);
    }
    if (tooLarge) return true;
    const rawBody = Buffer.concat(chunks);
    // The Teams adapter replies, reads history and downloads files with the
    // bot token at the activity's serviceUrl, and caches it for DMs. Refuse an
    // untrusted one before the adapter sees the activity.
    if (adapterName === "teams" && !hasTrustedTeamsServiceUrl(rawBody)) {
      console.warn("[chat-sdk] teams webhook refused: serviceUrl is not a Bot Framework host");
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Untrusted Teams serviceUrl" }));
      return true;
    }
    const request = toFetchRequest(req, rawBody, `/api/integrations/chat/${adapterName}/webhook`);

    try {
      const response = await handler(request, {
        // Handler errors are logged by `trackBackground` in `handlers.ts`.
        waitUntil: trackBackground,
      });
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        responseHeaders[name] = value;
      });
      const body = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, responseHeaders);
      res.end(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[chat-sdk] ${adapterName} webhook failed: ${scrubSecrets(message)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: "Chat SDK webhook failed" }));
    }
    return true;
  }

  return false;
}
