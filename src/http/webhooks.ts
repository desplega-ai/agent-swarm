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
import { workflowEventBus } from "../workflows/event-bus";
import { matchRoute } from "./utils";

export async function handleWebhooks(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
): Promise<boolean> {
  if (matchRoute(req.method, pathSegments, "POST", ["api", "github", "webhook"])) {
    // Check if GitHub integration is enabled
    if (!isGitHubEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "GitHub integration not configured" }));
      return true;
    }

    // Get event type and signature
    const eventType = req.headers["x-github-event"] as string | undefined;
    const signature = req.headers["x-hub-signature-256"] as string | undefined;

    // Parse request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString();

    // Verify webhook signature
    const isValid = await verifyWebhookSignature(rawBody, signature ?? null);
    if (!isValid) {
      console.log("[GitHub] Invalid webhook signature");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid signature" }));
      return true;
    }

    // Handle ping event (webhook setup verification)
    if (eventType === "ping") {
      console.log("[GitHub] Received ping event - webhook configured successfully");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "pong" }));
      return true;
    }

    // Parse JSON body
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return true;
    }

    console.log(`[GitHub] Received ${eventType} event`);

    // Route to appropriate handler
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
      console.error(`[GitHub] ❌ Error handling ${eventType} event: ${errorMessage}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error", message: errorMessage }));
    }
    return true;
  }

  // ============================================================================
  // AgentMail Webhook Endpoint
  // ============================================================================

  // POST /api/agentmail/webhook - Handle AgentMail webhook events
  if (matchRoute(req.method, pathSegments, "POST", ["api", "agentmail", "webhook"])) {
    // Check if AgentMail integration is enabled
    if (!isAgentMailEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "AgentMail integration not configured" }));
      return true;
    }

    // Read raw body (required for Svix signature verification)
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString();

    // Extract Svix headers for verification
    const svixHeaders: Record<string, string> = {};
    for (const key of ["svix-id", "svix-timestamp", "svix-signature"]) {
      const value = req.headers[key];
      if (typeof value === "string") {
        svixHeaders[key] = value;
      }
    }

    // Verify webhook signature
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

    // Process webhook asynchronously
    const payload = verified as AgentMailWebhookPayload;

    // Filter by inbox domain (only process messages for inboxes we care about)
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

    // Filter by sender domain (security — reject messages from untrusted senders)
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
