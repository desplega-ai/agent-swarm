import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  listWorkflowRuns,
  listWorkflows,
  updateWorkflow,
} from "../be/db";
import { WorkflowDefinitionSchema } from "../types";
import { startWorkflowExecution } from "../workflows";
import { retryFailedRun } from "../workflows/resume";
import { matchRoute, parseBody } from "./utils";

export async function handleWorkflows(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  // GET /api/workflows
  if (matchRoute(req.method, pathSegments, "GET", ["api", "workflows"], true)) {
    const workflows = listWorkflows();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(workflows));
    return true;
  }

  // POST /api/workflows
  if (matchRoute(req.method, pathSegments, "POST", ["api", "workflows"], true)) {
    const body = await parseBody<Record<string, unknown>>(req);
    const parsed = WorkflowDefinitionSchema.safeParse(body.definition);
    if (!parsed.success) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid definition", details: parsed.error.issues }));
      return true;
    }
    const workflow = createWorkflow({
      name: body.name as string,
      description: body.description as string | undefined,
      definition: parsed.data,
      createdByAgentId: myAgentId ?? undefined,
    });
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(workflow));
    return true;
  }

  // GET /api/workflows/:id
  if (matchRoute(req.method, pathSegments, "GET", ["api", "workflows", null], true)) {
    const id = pathSegments[2]!;
    const workflow = getWorkflow(id);
    if (!workflow) {
      res.writeHead(404);
      res.end();
      return true;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(workflow));
    return true;
  }

  // PUT /api/workflows/:id
  if (matchRoute(req.method, pathSegments, "PUT", ["api", "workflows", null], true)) {
    const id = pathSegments[2]!;
    const body = await parseBody<Record<string, unknown>>(req);
    if (body.definition) {
      const parsed = WorkflowDefinitionSchema.safeParse(body.definition);
      if (!parsed.success) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid definition", details: parsed.error.issues }));
        return true;
      }
      body.definition = parsed.data;
    }
    const workflow = updateWorkflow(id, body);
    if (!workflow) {
      res.writeHead(404);
      res.end();
      return true;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(workflow));
    return true;
  }

  // DELETE /api/workflows/:id
  if (matchRoute(req.method, pathSegments, "DELETE", ["api", "workflows", null], true)) {
    const id = pathSegments[2]!;
    try {
      const deleted = deleteWorkflow(id);
      res.writeHead(deleted ? 204 : 404);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
      return true;
    }
    res.end();
    return true;
  }

  // POST /api/workflows/:id/trigger
  if (matchRoute(req.method, pathSegments, "POST", ["api", "workflows", null, "trigger"])) {
    const id = pathSegments[2]!;
    const workflow = getWorkflow(id);
    if (!workflow) {
      res.writeHead(404);
      res.end();
      return true;
    }
    if (!workflow.enabled) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Workflow is disabled" }));
      return true;
    }
    // Auth: global API key already checked upstream, OR check webhook secret
    const secret = queryParams.get("secret");
    if (!myAgentId && secret !== workflow.webhookSecret) {
      res.writeHead(401);
      res.end();
      return true;
    }
    const body = await parseBody<Record<string, unknown>>(req);
    const runId = await startWorkflowExecution(workflow, body);
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ runId }));
    return true;
  }

  // GET /api/workflows/:id/runs
  if (matchRoute(req.method, pathSegments, "GET", ["api", "workflows", null, "runs"])) {
    const id = pathSegments[2]!;
    const runs = listWorkflowRuns(id);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(runs));
    return true;
  }

  // GET /api/workflow-runs/:id
  if (matchRoute(req.method, pathSegments, "GET", ["api", "workflow-runs", null], true)) {
    const id = pathSegments[2]!;
    const run = getWorkflowRun(id);
    if (!run) {
      res.writeHead(404);
      res.end();
      return true;
    }
    const steps = getWorkflowRunStepsByRunId(id);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...run, steps }));
    return true;
  }

  // POST /api/workflow-runs/:id/retry
  if (matchRoute(req.method, pathSegments, "POST", ["api", "workflow-runs", null, "retry"])) {
    const id = pathSegments[2]!;
    try {
      await retryFailedRun(id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return true;
  }

  return false;
}
