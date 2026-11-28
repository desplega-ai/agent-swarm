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
 *     declare its posture with an inline typed `rbac:` field on the route def.
 *     There is no backlog: a route without one fails the check.
 *
 * Stale allowlist entries fail the check, so the map stays honest.
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
  "realtime/auth", // Room tools enforce namespace access through the shared guard.
  "kv-write-auth", // kv-set / kv-delete / kv-incr shared write guard
  "task-tool-ctx", // assertOwnsTask → task.read.own / task.cancel.own / task.action.own
  "workflows/approval-cancel", // cancelApprovalRequest → approval.cancel.any
  "memory/key-guard", // assertKeyWritable → memory.write.consolidated (memory-store, memory-edit)
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
  "src/tools/runtime-pool-list.ts": "read-only configuration proxy",
  "src/tools/runtime-controller-list.ts": "read-only configuration proxy",
  "src/tools/runtime-pool-upsert.ts": "proxies to HTTP routes enforcing runtime_pool.write",
  "src/tools/runtime-pool-delete.ts": "proxies to HTTP routes enforcing runtime_pool.write",
  "src/tools/runtime-pool-bind-agent.ts": "proxies to HTTP routes enforcing runtime_pool.bind",
  "src/tools/runtime-pool-create-agent.ts": "proxies to HTTP routes enforcing runtime_pool.bind",
  "src/tools/app-list.ts": "app summaries are list-level; per-app filtering is future work",
  "src/tools/app-catalog.ts":
    "read-only static catalog of the app component/action vocabulary; takes no app id and returns no app data",
  "src/tools/objects.ts":
    "own-scoped: acts only on the caller's default agent-fs drive with the caller's own agent-scoped key, and agent-fs enforces drive permissions",
  "src/tools/sheets.ts":
    "own-scoped: acts only on the caller's default agent-fs drive with the caller's own agent-scoped key, and agent-fs enforces drive permissions",
  "src/tools/data.ts":
    "own-scoped: reads only through the caller's own agent-scoped agent-fs key (its default drive or a drive that key can read), and agent-fs enforces drive permissions",
  "src/tools/boards.ts":
    "own-scoped: acts only on the caller's default agent-fs drive with the caller's own agent-scoped key, and agent-fs enforces drive permissions",
  "src/tools/chat-reply.ts":
    "own-scoped: posts only to the chat thread of a task the caller owns or created",
  "src/tools/chat-post.ts":
    "open to all agents per the Chat SDK plan (2026-10-13); Slack's equivalent `slack-post` / `slack-read` is lead-gated, parity is an open decision for the operator",
  "src/tools/chat-open-dm.ts":
    "open to all agents per the Chat SDK plan (2026-10-13); Slack's equivalent `slack-post` / `slack-read` is lead-gated, parity is an open decision for the operator",
  "src/tools/chat-read-thread.ts":
    "open to all agents per the Chat SDK plan (2026-10-13); Slack's equivalent `slack-post` / `slack-read` is lead-gated, parity is an open decision for the operator",
  "src/tools/create-channel.ts": PIN_REASON,
  "src/tools/create-metric.ts": PIN_REASON,
  "src/tools/create-page.ts": PIN_REASON,
  "src/tools/db-query.ts": PIN_REASON,
  "src/tools/extension-delete.ts": "proxies to the extensions HTTP route enforcing extension.write",
  "src/tools/extension-enable.ts":
    "proxies to the extensions HTTP route enforcing extension.activate",
  "src/tools/extension-disable.ts":
    "proxies to the extensions HTTP route enforcing extension.activate",
  "src/tools/extension-activate-version.ts":
    "proxies to the extensions HTTP route enforcing extension.activate",
  "src/tools/extension-catalog.ts":
    "read-only proxy to GET /api/extensions/catalog, which is ungated like GET /api/extensions",
  "src/tools/extension-install.ts":
    "proxies to /api/extensions which enforces extension.write / GET is ungated",
  "src/tools/extension-list.ts":
    "proxies to /api/extensions which enforces extension.write / GET is ungated",
  "src/tools/model-profiles/check-model-profile.ts":
    "read-only, like the ungated GET /api/agents/{id}/profile-check",
  "src/tools/model-profiles/list-model-profiles.ts":
    "read-only, like the ungated GET /api/model-profiles",
  "src/tools/integration-status.ts":
    "read-only: the same integration setup states as the API-key GET /status, plus slugs of the script connections scoped to the caller",
  "src/tools/get-metrics.ts": PIN_REASON,
  "src/tools/get-swarm.ts": PIN_REASON,
  "src/tools/join-swarm.ts": PIN_REASON,
  "src/tools/kv/kv-get.ts": PIN_REASON,
  "src/tools/kv/kv-list.ts": PIN_REASON,
  "src/tools/list-channels.ts": PIN_REASON,
  "src/tools/mcp-servers/mcp-server-get.ts": PIN_REASON,
  "src/tools/mcp-servers/mcp-server-list.ts": PIN_REASON,
  "src/tools/memory-get.ts": PIN_REASON,
  "src/tools/memory-rate.ts": PIN_REASON,
  "src/tools/memory-search.ts": PIN_REASON,
  "src/tools/my-agent-info.ts": PIN_REASON,
  "src/tools/oauth-access-token.ts": PIN_REASON,
  "src/tools/poll-task.ts": PIN_REASON,
  "src/tools/post-message.ts": PIN_REASON,
  "src/tools/prompt-templates/get.ts": PIN_REASON,
  "src/tools/prompt-templates/list.ts": PIN_REASON,
  "src/tools/prompt-templates/preview.ts": PIN_REASON,
  "src/tools/read-messages.ts": PIN_REASON,
  "src/tools/register-agentmail-inbox.ts": PIN_REASON,
  "src/tools/repos/get-repos.ts": PIN_REASON,
  "src/tools/request-human-input.ts": PIN_REASON,
  "src/tools/resolve-user.ts": PIN_REASON,
  "src/tools/schedules/create-schedule.ts": PIN_REASON,
  "src/tools/schedules/delete-schedule.ts": PIN_REASON,
  "src/tools/schedules/list-schedules.ts": PIN_REASON,
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
  "src/tools/swarm-x.ts": PIN_REASON,
  "src/tools/system-one-decide.ts":
    "same posture as an ungated system-one-decision workflow node; the credential never leaves the server",
  "src/tools/tracker/tracker-link-task.ts": PIN_REASON,
  "src/tools/tracker/tracker-map-agent.ts": PIN_REASON,
  "src/tools/tracker/tracker-status.ts": PIN_REASON,
  "src/tools/tracker/tracker-sync-status.ts": PIN_REASON,
  "src/tools/tracker/tracker-unlink.ts": PIN_REASON,
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
    const gated = /\bcan\(/.test(src) || GATE_HELPER_SPECIFIERS.some((h) => src.includes(`${h}"`));
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

function checkRoutes(): string[] {
  const errors: string[] = [];
  for (const def of routeRegistry) {
    if (def.method === "get" || def.rbac !== undefined) continue;
    const key = `${def.method.toUpperCase()} ${def.path}`;
    errors.push(
      `${key}: non-GET route with no RBAC decision.\n` +
        `    Add \`rbac: { permission: "<verb>" }\` or \`rbac: { ungated: "<reason>" }\` to the route() def.`,
    );
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
