#!/usr/bin/env bun
/**
 * CI check: OpenAPI response-schema coverage. A generated SDK is only as
 * type-safe as the response schemas in openapi.json — this closes the gap the
 * type system can't: a route shipping without anyone deciding what its
 * success responses look like on the wire.
 *
 * Rule: every 2xx response on a `route()` def (except bodiless 204/205) must
 * declare either
 *   - `schema: <zod schema>` — the JSON body shape; send it via the handle's
 *     typed `respond(res, code, data)` so the schema and the wire can't drift;
 *   - or `unstructured: "<reason>"` — an explicit opt-out for non-JSON bodies
 *     (SSE, binary, HTML, redirects, proxied upstream payloads, ...).
 *
 * Undecided responses are tracked PER STATUS CODE ("METHOD /path CODE" in
 * scripts/.openapi-response-backlog) so a new untyped 2xx added to a
 * backlogged route still fails — route-level exemption would silently cover
 * statuses introduced after the baseline (codex review, PR #1141). The
 * backlog only ever shrinks; stale entries fail. Regenerate with:
 *
 *   bun scripts/check-openapi-response-coverage.ts --update-backlog
 *
 * Growth shows up as added lines in the PR diff — new routes are expected to
 * declare their posture inline instead. Modelled on check-rbac-coverage.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 2xx codes that carry no body and therefore need no schema decision. */
const BODILESS = new Set([204, 205]);

interface AuditableResponse {
  schema?: unknown;
  unstructured?: string;
}

export interface AuditableRouteDef {
  method: string;
  path: string;
  responses: Record<number, AuditableResponse>;
}

export interface ResponseAudit {
  /** "METHOD /path CODE" for every 2xx lacking both schema and unstructured. */
  undecided: string[];
  /** "METHOD /path CODE" for responses declaring BOTH (contradiction). */
  contradictory: string[];
}

/** Pure audit over route defs — importable by tests. */
export function auditRouteResponses(defs: AuditableRouteDef[]): ResponseAudit {
  const undecided: string[] = [];
  const contradictory: string[] = [];
  for (const def of defs) {
    for (const [codeStr, resDef] of Object.entries(def.responses)) {
      const code = Number(codeStr);
      const key = `${def.method.toUpperCase()} ${def.path} ${code}`;
      if (resDef.schema && resDef.unstructured) contradictory.push(key);
      if (code < 200 || code >= 300 || BODILESS.has(code)) continue;
      if (!resDef.schema && !resDef.unstructured) undecided.push(key);
    }
  }
  return { undecided, contradictory };
}

function readBacklog(path: string): Set<string> {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return new Set();
  }
  return new Set(
    raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
}

if (import.meta.main) {
  // Side-effect import: populates routeRegistry with every route() definition.
  await import("../src/http/all-routes");
  const { routeRegistry } = await import("../src/http/route-def");

  const BACKLOG_PATH = join(import.meta.dir, ".openapi-response-backlog");
  const { undecided, contradictory } = auditRouteResponses(routeRegistry);
  const backlog = readBacklog(BACKLOG_PATH);

  if (process.argv.includes("--update-backlog")) {
    const keys = [...undecided].sort();
    const added = keys.filter((k) => !backlog.has(k));
    const removed = [...backlog].filter((k) => !keys.includes(k));
    const header =
      "# 2xx responses (METHOD /path CODE) that predate the response-schema\n" +
      "# requirement. This file only ever shrinks — regenerate with:\n" +
      "# bun scripts/check-openapi-response-coverage.ts --update-backlog\n";
    writeFileSync(BACKLOG_PATH, header + keys.join("\n") + (keys.length ? "\n" : ""));
    console.log(
      `Backlog rewritten: ${keys.length} responses (-${removed.length}, +${added.length}).`,
    );
    if (added.length > 0) {
      console.warn(
        "\nWARNING: backlog GREW — new responses should declare `schema` or `unstructured` inline:",
      );
      for (const k of added) console.warn(`  + ${k}`);
    }
    process.exit(0);
  }

  const errors: string[] = [];

  for (const key of contradictory) {
    errors.push(`${key}: declares BOTH schema and unstructured — pick one.`);
  }

  const undecidedSet = new Set(undecided);
  for (const key of undecided) {
    if (!backlog.has(key)) {
      errors.push(
        `${key}: 2xx response with no shape decision.\n` +
          `    Declare \`schema: <zod>\` (and send via the handle's typed respond()) ` +
          `or \`unstructured: "<reason>"\` on the response def.`,
      );
    }
  }

  for (const entry of backlog) {
    if (!undecidedSet.has(entry)) {
      errors.push(`Stale backlog entry (response covered, route gone, or renamed): ${entry}`);
    }
  }

  if (errors.length > 0) {
    console.error(`\nERROR: OpenAPI response coverage (${errors.length}):\n`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      "\nEvery 2xx response needs an explicit shape decision (schema or unstructured " +
        "reason). See the header of scripts/check-openapi-response-coverage.ts.",
    );
    process.exit(1);
  }

  console.log(
    `OpenAPI response coverage check passed (${routeRegistry.length} routes, ` +
      `${undecided.length} backlogged undecided response(s)).`,
  );
}
