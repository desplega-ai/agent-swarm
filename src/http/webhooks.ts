import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentMailWebhookPayload } from "../agentmail";
import {
  handleMessageReceived,
  isAgentMailEnabled,
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

export async function handleWebhooks(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
): Promise<boolean> {
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "github" &&
    pathSegments[2] === "webhook"
  ) {
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
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "agentmail" &&
    pathSegments[2] === "webhook"
  ) {
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
