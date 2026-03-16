import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentMailWebhookPayload } from "../agentmail";
import {
  handleMessageReceived,
  isAgentMailEnabled,
  isInboxAllowed,
  isSenderAllowed,
  verifyAgentMailWebhook,
} from "../agentmail";
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
import { workflowEventBus } from "../workflows/event-bus";
import { route } from "./route-def";

// ─── Route Definitions (documentation only — webhooks handle their own body parsing) ─

const githubWebhook = route({
  method: "post",
  path: "/api/github/webhook",
  pattern: ["api", "github", "webhook"],
  summary: "Handle GitHub webhook events",
  tags: ["Webhooks"],
  auth: { apiKey: false },
  responses: {
    200: { description: "Event processed" },
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
    200: { description: "Event processed" },
    401: { description: "Invalid token" },
    503: { description: "GitLab integration not configured" },
  },
});

const agentmailWebhook = route({
  method: "post",
  path: "/api/agentmail/webhook",
  pattern: ["api", "agentmail", "webhook"],
  summary: "Handle AgentMail webhook events",
  tags: ["Webhooks"],
  auth: { apiKey: false },
  responses: {
    200: { description: "Event received" },
    401: { description: "Invalid signature" },
    503: { description: "AgentMail integration not configured" },
  },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

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
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "pong" }));
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

    console.log(`[GitHub] Received ${eventType} event`);

    let result: { created: boolean; taskId?: string } = { created: false };

    try {
      switch (eventType) {
        case "pull_request":
          result = await handlePullRequest(body as PullRequestEvent);
          break;
        case "issues":
          result = await handleIssue(body as IssueEvent);
          break;
        case "issue_comment":
          result = await handleComment(body as CommentEvent, "issue_comment");
          break;
        case "pull_request_review_comment":
          result = await handleComment(body as CommentEvent, "pull_request_review_comment");
          break;
        case "pull_request_review":
          result = await handlePullRequestReview(body as PullRequestReviewEvent);
          break;
        case "check_run":
          result = await handleCheckRun(body as CheckRunEvent);
          break;
        case "check_suite":
          result = await handleCheckSuite(body as CheckSuiteEvent);
          break;
        case "workflow_run":
          result = await handleWorkflowRun(body as WorkflowRunEvent);
          break;
        default:
          console.log(`[GitHub] Ignoring unsupported event type: ${eventType}`);
      }

      // Emit workflow trigger event for matching event types
      switch (eventType) {
        case "pull_request": {
          const pr = body as unknown as PullRequestEvent;
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
          const iss = body as unknown as IssueEvent;
          workflowEventBus.emit(`github.issue.${iss.action}`, {
            repo: iss.repository.full_name,
            number: iss.issue.number,
            title: iss.issue.title,
            action: iss.action,
          });
          break;
        }
        case "issue_comment": {
          const ic = body as unknown as CommentEvent;
          workflowEventBus.emit("github.issue_comment.created", {
            repo: ic.repository.full_name,
            number: ic.issue?.number,
            action: ic.action,
          });
          break;
        }
        case "pull_request_review": {
          const prr = body as unknown as PullRequestReviewEvent;
          workflowEventBus.emit("github.pull_request_review.submitted", {
            repo: prr.repository.full_name,
            number: prr.pull_request.number,
            state: prr.review.state,
            action: prr.action,
          });
          break;
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
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

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return true;
    }

    const objectKind = body.object_kind as string | undefined;
    console.log(`[GitLab] Received ${objectKind} event`);

    let result: { created: boolean; taskId?: string } = { created: false };

    try {
      switch (objectKind) {
        case "merge_request":
          result = await handleMergeRequest(body as unknown as MergeRequestEvent);
          break;
        case "issue":
          result = await handleGitLabIssue(body as unknown as GitLabIssueEvent);
          break;
        case "note":
          result = await handleNote(body as unknown as NoteEvent);
          break;
        case "pipeline":
          result = await handlePipeline(body as unknown as PipelineEvent);
          break;
        default:
          console.log(`[GitLab] Ignoring unsupported event type: ${objectKind}`);
      }

      // Emit workflow trigger events for GitLab
      switch (objectKind) {
        case "merge_request": {
          const mr = body as unknown as MergeRequestEvent;
          const action = mr.object_attributes.action;
          workflowEventBus.emit(`gitlab.merge_request.${action}`, {
            repo: mr.project.path_with_namespace,
            number: mr.object_attributes.iid,
            title: mr.object_attributes.title,
            body: mr.object_attributes.description,
            action,
            merged: mr.object_attributes.state === "merged",
            html_url: mr.object_attributes.url,
            user_login: mr.user.username,
          });
          break;
        }
        case "issue": {
          const iss = body as unknown as GitLabIssueEvent;
          workflowEventBus.emit(`gitlab.issue.${iss.object_attributes.action}`, {
            repo: iss.project.path_with_namespace,
            number: iss.object_attributes.iid,
            title: iss.object_attributes.title,
            action: iss.object_attributes.action,
          });
          break;
        }
        case "note": {
          const note = body as unknown as NoteEvent;
          workflowEventBus.emit("gitlab.note.created", {
            repo: note.project.path_with_namespace,
            number: note.merge_request?.iid ?? note.issue?.iid,
            action: "created",
          });
          break;
        }
        case "pipeline": {
          const pl = body as unknown as PipelineEvent;
          workflowEventBus.emit(`gitlab.pipeline.${pl.object_attributes.status}`, {
            repo: pl.project.path_with_namespace,
            number: pl.merge_request?.iid,
            status: pl.object_attributes.status,
            action: pl.object_attributes.status,
          });
          break;
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
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

    // Return 200 immediately — Svix best practice to avoid retries.
    // Processing happens asynchronously below; dedup is handled in handlers.ts.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: true }));

    const payload = verified as AgentMailWebhookPayload;

    if (
      payload.message &&
      !isInboxAllowed(payload.message.inbox_id, process.env.AGENTMAIL_INBOX_DOMAIN_FILTER)
    ) {
      const domain = payload.message.inbox_id.split("@")[1] ?? "unknown";
      console.log(
        `[AgentMail] Ignoring event for inbox domain "${domain}" (not in AGENTMAIL_INBOX_DOMAIN_FILTER)`,
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

  return false;
}
