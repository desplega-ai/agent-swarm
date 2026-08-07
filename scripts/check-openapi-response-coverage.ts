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
 * Pre-existing untyped routes are pinned in scripts/.openapi-response-backlog
 * (one "METHOD /path" per line). The backlog only ever shrinks: covering a
 * backlogged route makes its entry stale, and stale entries fail the check.
 * Regenerate the file with:
 *
 *   bun scripts/check-openapi-response-coverage.ts --update-backlog
 *
 * Growth of the backlog shows up as added lines in the PR diff — new routes
 * are expected to declare their posture inline instead.
 *
 * Modelled on scripts/check-rbac-coverage.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Side-effect import: populates routeRegistry with every route() definition.
import "../src/http/all-routes";
import { routeRegistry } from "../src/http/route-def";

const BACKLOG_PATH = join(import.meta.dir, ".openapi-response-backlog");

/** 2xx codes that carry no body and therefore need no schema decision. */
const BODILESS = new Set([204, 205]);

interface RouteAudit {
  key: string;
  /** 2xx codes lacking both `schema` and `unstructured`. */
  undecided: number[];
  /** Responses declaring BOTH `schema` and `unstructured` (contradiction). */
  contradictory: number[];
}

function auditRoutes(): RouteAudit[] {
  return routeRegistry.map((def) => {
    const undecided: number[] = [];
    const contradictory: number[] = [];
    for (const [codeStr, resDef] of Object.entries(def.responses)) {
      const code = Number(codeStr);
      if (resDef.schema && resDef.unstructured) contradictory.push(code);
      if (code < 200 || code >= 300 || BODILESS.has(code)) continue;
      if (!resDef.schema && !resDef.unstructured) undecided.push(code);
    }
    return { key: `${def.method.toUpperCase()} ${def.path}`, undecided, contradictory };
  });
}

function readBacklog(): Set<string> {
  let raw = "";
  try {
    raw = readFileSync(BACKLOG_PATH, "utf8");
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

const audits = auditRoutes();
const uncovered = audits.filter((a) => a.undecided.length > 0);
const backlog = readBacklog();

if (process.argv.includes("--update-backlog")) {
  const keys = uncovered.map((a) => a.key).sort();
  const added = keys.filter((k) => !backlog.has(k));
  const removed = [...backlog].filter((k) => !keys.includes(k));
  const header =
    "# Routes whose 2xx responses predate the response-schema requirement.\n" +
    "# One 'METHOD /path' per line. This file only ever shrinks — regenerate\n" +
    "# with: bun scripts/check-openapi-response-coverage.ts --update-backlog\n";
  writeFileSync(BACKLOG_PATH, header + keys.join("\n") + (keys.length ? "\n" : ""));
  console.log(`Backlog rewritten: ${keys.length} routes (-${removed.length}, +${added.length}).`);
  if (added.length > 0) {
    console.warn(
      "\nWARNING: backlog GREW — new routes should declare `schema` or `unstructured` inline:",
    );
    for (const k of added) console.warn(`  + ${k}`);
  }
  process.exit(0);
}

const errors: string[] = [];

for (const a of audits) {
  for (const code of a.contradictory) {
    errors.push(`${a.key} ${code}: declares BOTH schema and unstructured — pick one.`);
  }
}

for (const a of uncovered) {
  if (!backlog.has(a.key)) {
    errors.push(
      `${a.key}: 2xx response(s) [${a.undecided.join(", ")}] with no shape decision.\n` +
        `    Declare \`schema: <zod>\` (and send via the handle's typed respond()) ` +
        `or \`unstructured: "<reason>"\` on the response def.`,
    );
  }
}

const uncoveredKeys = new Set(uncovered.map((a) => a.key));
const routeKeys = new Set(audits.map((a) => a.key));
for (const entry of backlog) {
  if (!routeKeys.has(entry)) {
    errors.push(`Stale backlog entry (route gone or renamed): ${entry} — remove it.`);
  } else if (!uncoveredKeys.has(entry)) {
    errors.push(`Stale backlog entry (route is now covered): ${entry} — remove it.`);
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
  `OpenAPI response coverage check passed (${audits.length - uncovered.length}/${audits.length} ` +
    `routes covered, ${uncovered.length} backlogged).`,
);
