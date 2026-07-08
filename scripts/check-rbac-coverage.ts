#!/usr/bin/env bun
/**
 * CI check: RBAC coverage (DES-445). Closes the gap the type system can't —
 * a NEW tool or route shipping without anyone deciding its RBAC posture.
 * Three invariants:
 *
 *  1. TOOLS — every file under src/tools/ that registers an MCP tool
 *     (contains `createToolRegistrar`) must either reach `can()` (directly,
 *     or by importing a gate-helper module) or be listed in
 *     UNGATED_TOOL_FILES below with a reason.
 *
 *  2. VERBS — every verb in the PERMISSIONS registry must have at least one
 *     live `can()` call site outside src/rbac/ (no dead verbs).
 *
 *  3. ROUTES — every non-GET route registered via the `route()` factory must
 *     declare its posture: either an inline typed `rbac:` field on the route
 *     def (preferred for new routes), or an entry in ROUTE_RBAC_BACKLOG
 *     below. The backlog documents pre-RBAC routes pinned ungated at slice 1;
 *     it should only ever shrink (entries migrate to inline `rbac:` fields).
 *
 * Stale allowlist/backlog entries fail the check, so the maps stay honest.
 * Modelled on scripts/check-sdk-tool-registration.ts.
 *
 * When this check fails for something you added, decide explicitly:
 *   - gate it: call can() in the handler (tools), or add can() + an inline
 *     `rbac: { permission: "<verb>" }` on the route def; register a new verb
 *     in src/rbac/permissions.ts + src/rbac/legacy-policy.ts if none fits;
 *   - or document it: `rbac: { ungated: "<reason>" }` on the route def, or an
 *     allowlist entry below (tools).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
// Side-effect import: populates routeRegistry with every route() definition.
import "../src/http/all-routes";
import { routeRegistry } from "../src/http/route-def";
import { PERMISSION_VERBS } from "../src/rbac/permissions";

const REPO_ROOT = join(import.meta.dir, "..");

// ─── 1. Tools ────────────────────────────────────────────────────────────────

/**
 * Modules that call can() on behalf of the tool files importing them. A tool
 * file importing one of these counts as gated.
 */
const GATE_HELPER_SPECIFIERS = [
  "kv-write-auth", // kv-set / kv-delete / kv-incr shared write guard
  "task-tool-ctx", // assertOwnsTask → task.read.own / task.cancel.own / task.action.own
];

/**
 * Tool-registration files with NO principal gate, pinned at the slice-1
 * inventory (plan Appendix A: every HARD authorization site at HEAD got a
 * verb; everything else was ungated by design — read-only, own-scoped, or
 * open-to-all-agents surfaces). New tool files must gate or be added here.
 */
const PIN_REASON =
  "no hard authorization gate at the slice-1 pin (plan Appendix A) — open to all authenticated agents";

const UNGATED_TOOL_FILES: Record<string, string> = {
  "src/tools/create-channel.ts": PIN_REASON,
  "src/tools/create-metric.ts": PIN_REASON,
  "src/tools/create-page.ts": PIN_REASON,
  "src/tools/db-query.ts": PIN_REASON,
  "src/tools/get-metrics.ts": PIN_REASON,
  "src/tools/get-swarm.ts": PIN_REASON,
  "src/tools/join-swarm.ts": PIN_REASON,
  "src/tools/kv/kv-get.ts": PIN_REASON,
  "src/tools/kv/kv-list.ts": PIN_REASON,
  "src/tools/list-channels.ts": PIN_REASON,
  "src/tools/list-services.ts": PIN_REASON,
  "src/tools/mcp-servers/mcp-server-get.ts": PIN_REASON,
  "src/tools/mcp-servers/mcp-server-list.ts": PIN_REASON,
  "src/tools/memory-edit.ts": PIN_REASON,
  "src/tools/memory-get.ts": PIN_REASON,
  "src/tools/memory-rate.ts": PIN_REASON,
  "src/tools/memory-search.ts": PIN_REASON,
  "src/tools/my-agent-info.ts": PIN_REASON,
  "src/tools/oauth-access-token.ts": PIN_REASON,
  "src/tools/poll-task.ts": PIN_REASON,
  "src/tools/post-message.ts": PIN_REASON,
  "src/tools/prompt-templates/delete.ts": PIN_REASON,
  "src/tools/prompt-templates/get.ts": PIN_REASON,
  "src/tools/prompt-templates/list.ts": PIN_REASON,
  "src/tools/prompt-templates/preview.ts": PIN_REASON,
  "src/tools/prompt-templates/set.ts": PIN_REASON,
  "src/tools/read-messages.ts": PIN_REASON,
  "src/tools/register-agentmail-inbox.ts": PIN_REASON,
  "src/tools/register-service.ts": PIN_REASON,
  "src/tools/repos/get-repos.ts": PIN_REASON,
  "src/tools/repos/update-repo.ts": PIN_REASON,
  "src/tools/request-human-input.ts": PIN_REASON,
  "src/tools/resolve-user.ts": PIN_REASON,
  "src/tools/schedules/create-schedule.ts": PIN_REASON,
  "src/tools/schedules/delete-schedule.ts": PIN_REASON,
  "src/tools/schedules/list-schedules.ts": PIN_REASON,
  "src/tools/schedules/patch-schedule.ts": PIN_REASON,
  "src/tools/schedules/run-schedule-now.ts": PIN_REASON,
  "src/tools/schedules/update-schedule.ts": PIN_REASON,
  "src/tools/script-apis.ts": PIN_REASON,
  "src/tools/script-delete.ts": PIN_REASON,
  "src/tools/script-query-types.ts": PIN_REASON,
  "src/tools/script-run.ts": PIN_REASON,
  "src/tools/script-runs.ts": PIN_REASON,
  "src/tools/script-search.ts": PIN_REASON,
  "src/tools/script-upsert.ts": PIN_REASON,
  "src/tools/skills/skill-get-file.ts": PIN_REASON,
  "src/tools/skills/skill-get.ts": PIN_REASON,
  "src/tools/skills/skill-list.ts": PIN_REASON,
  "src/tools/skills/skill-publish.ts": PIN_REASON,
  "src/tools/skills/skill-search.ts": PIN_REASON,
  "src/tools/skills/skill-sync-remote.ts": PIN_REASON,
  "src/tools/slack-download-file.ts": PIN_REASON,
  "src/tools/slack-list-channels.ts": PIN_REASON,
  "src/tools/slack-reply.ts": PIN_REASON,
  "src/tools/store-progress.ts": PIN_REASON,
  "src/tools/swarm-x.ts": PIN_REASON,
  "src/tools/tracker/tracker-link-task.ts": PIN_REASON,
  "src/tools/tracker/tracker-map-agent.ts": PIN_REASON,
  "src/tools/tracker/tracker-status.ts": PIN_REASON,
  "src/tools/tracker/tracker-sync-status.ts": PIN_REASON,
  "src/tools/tracker/tracker-unlink.ts": PIN_REASON,
  "src/tools/unregister-service.ts": PIN_REASON,
  "src/tools/update-service-status.ts": PIN_REASON,
  "src/tools/whatsapp-message.ts": PIN_REASON,
  "src/tools/workflows/cancel-workflow-run.ts": PIN_REASON,
  "src/tools/workflows/create-workflow.ts": PIN_REASON,
  "src/tools/workflows/delete-workflow.ts": PIN_REASON,
  "src/tools/workflows/get-workflow-run.ts": PIN_REASON,
  "src/tools/workflows/get-workflow.ts": PIN_REASON,
  "src/tools/workflows/list-workflow-runs.ts": PIN_REASON,
  "src/tools/workflows/list-workflows.ts": PIN_REASON,
  "src/tools/workflows/patch-workflow-node.ts": PIN_REASON,
  "src/tools/workflows/patch-workflow.ts": PIN_REASON,
  "src/tools/workflows/retry-workflow-run.ts": PIN_REASON,
  "src/tools/workflows/trigger-workflow.ts": PIN_REASON,
  "src/tools/workflows/update-workflow.ts": PIN_REASON,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function checkTools(): string[] {
  const errors: string[] = [];
  const toolFiles = walk(join(REPO_ROOT, "src/tools")).filter((f) => {
    const src = readFileSync(f, "utf8");
    // Registration files USE the registrar; utils.ts (which defines and
    // exports it) is not a tool file.
    return src.includes("createToolRegistrar") && !src.includes("export const createToolRegistrar");
  });
  const seen = new Set<string>();

  for (const file of toolFiles) {
    const rel = relative(REPO_ROOT, file);
    seen.add(rel);
    const src = readFileSync(file, "utf8");
    // Helper detection matches the import specifier's basename, so both
    // same-dir (./kv-write-auth) and aliased (@/tools/task-tool-ctx) imports count.
    const gated =
      /\bcan\(/.test(src) || GATE_HELPER_SPECIFIERS.some((h) => src.includes(`${h}"`));
    const allowlisted = rel in UNGATED_TOOL_FILES;

    if (gated && allowlisted) {
      errors.push(
        `${rel}: reaches can() but is still listed in UNGATED_TOOL_FILES — remove the stale entry.`,
      );
    } else if (!gated && !allowlisted) {
      errors.push(
        `${rel}: registers an MCP tool but neither reaches can() nor is listed in UNGATED_TOOL_FILES.\n` +
          `    Add a gate, or add:  "${rel}": "<reason>",`,
      );
    }
  }

  for (const rel of Object.keys(UNGATED_TOOL_FILES)) {
    if (!seen.has(rel)) {
      errors.push(`UNGATED_TOOL_FILES has a stale entry (file gone or no longer a tool): ${rel}`);
    }
  }
  return errors;
}

// ─── 2. Verbs ────────────────────────────────────────────────────────────────

function checkVerbs(): string[] {
  const errors: string[] = [];
  const files = walk(join(REPO_ROOT, "src")).filter(
    (f) => !relative(REPO_ROOT, f).startsWith("src/rbac/"),
  );
  const corpus = files.map((f) => readFileSync(f, "utf8")).join("\n");
  for (const verb of PERMISSION_VERBS) {
    if (!corpus.includes(`"${verb}"`)) {
      errors.push(
        `PERMISSIONS verb "${verb}" has no call site outside src/rbac/ — dead verb? ` +
          `Wire a can() gate or remove it from src/rbac/permissions.ts.`,
      );
    }
  }
  return errors;
}

// ─── 3. Routes ───────────────────────────────────────────────────────────────

/**
 * Non-GET routes pinned WITHOUT a principal gate at slice 1 (they still
 * require bearer auth via handleCore; "ungated" means no per-principal
 * authorization beyond that). This backlog must only shrink: when a route
 * gains a gate — or you make the posture explicit — move the decision to an
 * inline `rbac:` field on the route def and delete the entry here.
 */
const BACKLOG_REASON =
  "pre-RBAC route pinned ungated at slice 1 (bearer auth only, no principal gate)";

const ROUTE_RBAC_BACKLOG: Record<string, string> = {
  "DELETE /@swarm/api/{path}": BACKLOG_REASON,
  "DELETE /api/active-sessions/{id}": BACKLOG_REASON,
  "DELETE /api/active-sessions/by-task/{taskId}": BACKLOG_REASON,
  "DELETE /api/budgets/{scope}/{scopeId}": BACKLOG_REASON,
  "DELETE /api/mcp-oauth/{mcpServerId}": BACKLOG_REASON,
  "DELETE /api/mcp-servers/{id}": BACKLOG_REASON,
  "DELETE /api/mcp-servers/{id}/install/{agentId}": BACKLOG_REASON,
  "DELETE /api/memory/{id}": BACKLOG_REASON,
  "DELETE /api/metrics/definitions/{id}": BACKLOG_REASON,
  "DELETE /api/oauth/refresh-locks/{key}": BACKLOG_REASON,
  "DELETE /api/pages/{id}": BACKLOG_REASON,
  "DELETE /api/pricing/{provider}/{model}/{tokenClass}/{effectiveFrom}": BACKLOG_REASON,
  "DELETE /api/prompt-templates/{id}": BACKLOG_REASON,
  "DELETE /api/repos/{id}": BACKLOG_REASON,
  "DELETE /api/schedules/{id}": BACKLOG_REASON,
  "DELETE /api/script-runs/{id}": BACKLOG_REASON,
  "DELETE /api/scripts/{id}/apis/{endpointId}": BACKLOG_REASON,
  "DELETE /api/skills/{id}": BACKLOG_REASON,
  "DELETE /api/skills/{id}/files/{path}": BACKLOG_REASON,
  "DELETE /api/skills/{id}/install/{agentId}": BACKLOG_REASON,
  "DELETE /api/trackers/jira/disconnect": BACKLOG_REASON,
  "DELETE /api/trackers/jira/webhook/{id}": BACKLOG_REASON,
  "DELETE /api/trackers/linear/disconnect": BACKLOG_REASON,
  "DELETE /api/users/{id}/identities/{kind}/{externalId}": BACKLOG_REASON,
  "DELETE /api/users/{id}/mcp-tokens/{tokenId}": BACKLOG_REASON,
  "DELETE /api/workflows/{id}": BACKLOG_REASON,
  "PATCH /@swarm/api/{path}": BACKLOG_REASON,
  "PATCH /api/agents/{id}/harness-provider": BACKLOG_REASON,
  "PATCH /api/agents/{id}/runtime": BACKLOG_REASON,
  "PATCH /api/inbox-state": BACKLOG_REASON,
  "PATCH /api/keys/name": BACKLOG_REASON,
  "PATCH /api/scripts/{id}/apis/{endpointId}": BACKLOG_REASON,
  "PATCH /api/tasks/{id}/vcs": BACKLOG_REASON,
  "PATCH /api/users/{id}": BACKLOG_REASON,
  "PATCH /api/workflows/{id}": BACKLOG_REASON,
  "PATCH /api/workflows/{id}/nodes/{nodeId}": BACKLOG_REASON,
  "POST /@swarm/api/{path}": BACKLOG_REASON,
  "POST /api/active-sessions": BACKLOG_REASON,
  "POST /api/active-sessions/cleanup": BACKLOG_REASON,
  "POST /api/active-sessions/recover-orphaned-tasks": BACKLOG_REASON,
  "POST /api/agentmail/webhook": BACKLOG_REASON,
  "POST /api/agents": BACKLOG_REASON,
  "POST /api/approval-requests": BACKLOG_REASON,
  "POST /api/approval-requests/{id}/respond": BACKLOG_REASON,
  "POST /api/channel-activity/commit-cursors": BACKLOG_REASON,
  "POST /api/config/reload": BACKLOG_REASON,
  "POST /api/db-query": BACKLOG_REASON,
  "POST /api/events": BACKLOG_REASON,
  "POST /api/events/batch": BACKLOG_REASON,
  "POST /api/fs/agent-credentials": BACKLOG_REASON,
  "POST /api/github/webhook": BACKLOG_REASON,
  "POST /api/gitlab/webhook": BACKLOG_REASON,
  "POST /api/heartbeat/checklist": BACKLOG_REASON,
  "POST /api/heartbeat/sweep": BACKLOG_REASON,
  "POST /api/integrations/claude-managed/test": BACKLOG_REASON,
  "POST /api/integrations/kapso/webhook": BACKLOG_REASON,
  "POST /api/internal/raw-llm": BACKLOG_REASON,
  "POST /api/internal/script-runs/{runId}/agent-task": BACKLOG_REASON,
  "POST /api/internal/script-runs/{runId}/heartbeat": BACKLOG_REASON,
  "POST /api/internal/script-runs/{runId}/status": BACKLOG_REASON,
  "POST /api/internal/script-runs/{runId}/steps": BACKLOG_REASON,
  "POST /api/keys/clear-rate-limit": BACKLOG_REASON,
  "POST /api/keys/report-rate-limit": BACKLOG_REASON,
  "POST /api/keys/report-rate-limit-windows": BACKLOG_REASON,
  "POST /api/keys/report-usage": BACKLOG_REASON,
  "POST /api/mcp-bridge": BACKLOG_REASON,
  "POST /api/mcp-oauth/{mcpServerId}/manual-client": BACKLOG_REASON,
  "POST /api/mcp-oauth/{mcpServerId}/refresh": BACKLOG_REASON,
  "POST /api/mcp-servers": BACKLOG_REASON,
  "POST /api/mcp-servers/{id}/install": BACKLOG_REASON,
  "POST /api/memory/edit": BACKLOG_REASON,
  "POST /api/memory/index": BACKLOG_REASON,
  "POST /api/memory/list": BACKLOG_REASON,
  "POST /api/memory/rate": BACKLOG_REASON,
  "POST /api/memory/re-embed": BACKLOG_REASON,
  "POST /api/memory/search": BACKLOG_REASON,
  "POST /api/metrics/definitions": BACKLOG_REASON,
  "POST /api/metrics/definitions/{id}/run": BACKLOG_REASON,
  "POST /api/oauth/keep-warm/codex": BACKLOG_REASON,
  "POST /api/oauth/refresh-locks/{key}": BACKLOG_REASON,
  "POST /api/pages": BACKLOG_REASON,
  "POST /api/pages/{id}/launch": BACKLOG_REASON,
  "POST /api/pricing/{provider}/{model}/{tokenClass}": BACKLOG_REASON,
  "POST /api/prompt-templates/{id}/checkout": BACKLOG_REASON,
  "POST /api/prompt-templates/{id}/reset": BACKLOG_REASON,
  "POST /api/prompt-templates/preview": BACKLOG_REASON,
  "POST /api/prompt-templates/render": BACKLOG_REASON,
  "POST /api/repos": BACKLOG_REASON,
  "POST /api/schedules": BACKLOG_REASON,
  "POST /api/schedules/{id}/run": BACKLOG_REASON,
  "POST /api/script-runs": BACKLOG_REASON,
  "POST /api/scripts/{id}/apis": BACKLOG_REASON,
  "POST /api/scripts/{id}/apis/{endpointId}/rotate": BACKLOG_REASON,
  "POST /api/scripts/run": BACKLOG_REASON,
  "POST /api/scripts/search": BACKLOG_REASON,
  "POST /api/session-costs": BACKLOG_REASON,
  "POST /api/session-logs": BACKLOG_REASON,
  "POST /api/skills": BACKLOG_REASON,
  "POST /api/skills/{id}/files": BACKLOG_REASON,
  "POST /api/skills/{id}/install": BACKLOG_REASON,
  "POST /api/skills/install-remote": BACKLOG_REASON,
  "POST /api/skills/sync-filesystem": BACKLOG_REASON,
  "POST /api/skills/sync-remote": BACKLOG_REASON,
  "POST /api/tasks": BACKLOG_REASON,
  "POST /api/tasks/{id}/cancel": BACKLOG_REASON,
  "POST /api/tasks/{id}/context": BACKLOG_REASON,
  "POST /api/tasks/{id}/finish": BACKLOG_REASON,
  "POST /api/tasks/{id}/pause": BACKLOG_REASON,
  "POST /api/tasks/{id}/progress": BACKLOG_REASON,
  "POST /api/tasks/{id}/resume": BACKLOG_REASON,
  "POST /api/tasks/{id}/supersede": BACKLOG_REASON,
  "POST /api/trackers/jira/refresh": BACKLOG_REASON,
  "POST /api/trackers/jira/webhook-register": BACKLOG_REASON,
  "POST /api/trackers/jira/webhook/{token}": BACKLOG_REASON,
  "POST /api/trackers/linear/refresh": BACKLOG_REASON,
  "POST /api/trackers/linear/webhook": BACKLOG_REASON,
  "POST /api/users": BACKLOG_REASON,
  "POST /api/users/{id}/identities": BACKLOG_REASON,
  "POST /api/users/{id}/mcp-tokens": BACKLOG_REASON,
  "POST /api/users/{id}/merge": BACKLOG_REASON,
  "POST /api/users/unmapped/{kind}/{externalId}/resolve": BACKLOG_REASON,
  "POST /api/webhooks/{workflowId}": BACKLOG_REASON,
  "POST /api/workflow-events": BACKLOG_REASON,
  "POST /api/workflow-runs/{id}/cancel": BACKLOG_REASON,
  "POST /api/workflow-runs/{id}/retry": BACKLOG_REASON,
  "POST /api/workflow-runs/{runId}/events": BACKLOG_REASON,
  "POST /api/workflows": BACKLOG_REASON,
  "POST /api/workflows/{id}/trigger": BACKLOG_REASON,
  "POST /api/workflows/{id}/trigger/validate": BACKLOG_REASON,
  "POST /api/x/script/{endpointId}": BACKLOG_REASON,
  "POST /status/test-connection": BACKLOG_REASON,
  "PUT /@swarm/api/{path}": BACKLOG_REASON,
  "PUT /api/active-sessions/heartbeat/{taskId}": BACKLOG_REASON,
  "PUT /api/active-sessions/provider-session/{taskId}": BACKLOG_REASON,
  "PUT /api/agents/{id}/activity": BACKLOG_REASON,
  "PUT /api/agents/{id}/credential-status": BACKLOG_REASON,
  "PUT /api/agents/{id}/name": BACKLOG_REASON,
  "PUT /api/agents/{id}/profile": BACKLOG_REASON,
  "PUT /api/budgets/{scope}/{scopeId}": BACKLOG_REASON,
  "PUT /api/mcp-servers/{id}": BACKLOG_REASON,
  "PUT /api/metrics/definitions/{id}": BACKLOG_REASON,
  "PUT /api/pages/{id}": BACKLOG_REASON,
  "PUT /api/prompt-templates": BACKLOG_REASON,
  "PUT /api/repos/{id}": BACKLOG_REASON,
  "PUT /api/schedules/{id}": BACKLOG_REASON,
  "PUT /api/skills/{id}": BACKLOG_REASON,
  "PUT /api/skills/{id}/files/{path}": BACKLOG_REASON,
  "PUT /api/tasks/{id}/session": BACKLOG_REASON,
  "PUT /api/workflows/{id}": BACKLOG_REASON,
};

function checkRoutes(): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const def of routeRegistry) {
    if (def.method === "get") continue;
    const key = `${def.method.toUpperCase()} ${def.path}`;
    seen.add(key);
    const inline = def.rbac !== undefined;
    const backlogged = key in ROUTE_RBAC_BACKLOG;

    if (inline && backlogged) {
      errors.push(`${key}: has an inline rbac field — remove the stale ROUTE_RBAC_BACKLOG entry.`);
    } else if (!inline && !backlogged) {
      errors.push(
        `${key}: non-GET route with no RBAC decision.\n` +
          `    Preferred: add \`rbac: { permission: "<verb>" }\` or \`rbac: { ungated: "<reason>" }\` to the route() def.\n` +
          `    Or backlog it:  "${key}": BACKLOG_REASON,`,
      );
    }
  }

  for (const key of Object.keys(ROUTE_RBAC_BACKLOG)) {
    if (!seen.has(key)) {
      errors.push(`ROUTE_RBAC_BACKLOG has a stale entry (route gone or now GET): ${key}`);
    }
  }
  return errors;
}

// ─── 4. Route-import completeness ────────────────────────────────────────────

/**
 * The route checks only see routes whose module is imported by
 * `src/http/all-routes.ts` (that side-effect list is what populates
 * `routeRegistry`). A handler file that registers routes but is missing from
 * the list escapes the coverage check entirely AND generated OpenAPI — exactly
 * how `PUT /api/favorites` slipped through (codex review, PR #921). This guard
 * makes the list self-verifying: every `src/http` file that calls
 * `= route(` must be imported.
 */
function checkRouteImports(): string[] {
  const errors: string[] = [];
  const httpDir = join(REPO_ROOT, "src/http");

  const imported = new Set<string>();
  for (const m of readFileSync(join(httpDir, "all-routes.ts"), "utf8").matchAll(/"\.\/([^"]+)"/g)) {
    imported.add(m[1]);
  }

  for (const file of walk(httpDir)) {
    const rel = relative(httpDir, file).replace(/\.ts$/, "");
    if (rel === "all-routes" || rel === "route-def") continue;
    // Real route definitions are `const x = route({ ... })`; the bare
    // `route({` string also appears in comments, so key on the assignment.
    if (!/=\s*route\(/.test(readFileSync(file, "utf8"))) continue;
    if (!imported.has(rel)) {
      errors.push(
        `src/http/${rel}.ts registers routes but is not imported in src/http/all-routes.ts — ` +
          `its routes escape the coverage check and OpenAPI. Add \`import "./${rel}";\`.`,
      );
    }
  }
  return errors;
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const sections: Array<[string, string[]]> = [
  ["Route-import completeness", checkRouteImports()],
  ["MCP tools", checkTools()],
  ["Permission verbs", checkVerbs()],
  ["HTTP routes", checkRoutes()],
];

let failed = false;
for (const [name, errors] of sections) {
  if (errors.length > 0) {
    failed = true;
    console.error(`\nERROR: RBAC coverage — ${name} (${errors.length}):\n`);
    for (const e of errors) console.error(`  - ${e}`);
  }
}

if (failed) {
  console.error(
    "\nEvery tool file and non-GET route needs an explicit RBAC decision " +
      "(gate via can(), or a documented ungated reason). See the header of " +
      "scripts/check-rbac-coverage.ts.",
  );
  process.exit(1);
}

const nonGet = routeRegistry.filter((d) => d.method !== "get").length;
console.log(
  `RBAC coverage check passed (${PERMISSION_VERBS.length} verbs live, ` +
    `${nonGet} non-GET routes and all tool files have explicit posture).`,
);
