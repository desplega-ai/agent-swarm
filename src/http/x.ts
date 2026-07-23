import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { recordInlineScriptRun } from "../be/db";
import {
  getScriptApiConnectionDescriptors,
  getScriptMcpConnectionDescriptors,
} from "../be/script-connections";
import { buildScriptCredentialBindingsWithFailures } from "../be/script-credential-broker";
import {
  getScriptApiById,
  getScriptApiSecret,
  getScriptById,
  recordScriptApiUsage,
} from "../be/scripts/db";
import type { RunScriptOutput } from "../scripts-runtime/loader";
import { runScript } from "../scripts-runtime/loader";
import { scrubObject, scrubSecrets } from "../utils/secret-scrubber";
import { validateJsonSchema } from "../workflows/json-schema-validator";
import { route } from "./route-def";
import { BODY_TOO_LARGE, enforceContentLengthCap, json, jsonError, parseBody } from "./utils";

// ─────────────────────────────────────────────────────────────────────────────
// `/api/x/*` — externally-exposed swarm-created assets. v1 ships exactly one:
// `POST /api/x/script/<endpointId>`, which runs a script bound to a public
// endpoint (see `script_apis`). Future external asset types live under the same
// `x` prefix.
//
// CORS: this namespace intentionally allows ANY origin by default. CORS is
// applied globally in `src/http/index.ts` (`setCorsHeaders`) — the request
// Origin is echoed (credentialed) or `*` is sent when absent, and OPTIONS
// preflight is answered with 204 in `src/http/core.ts`. So nothing origin-
// specific is needed here.
// FUTURE: to allow per-endpoint origin control, add an `allowedOrigins` column
// to `script_apis` and, when set for the matched endpoint, override
// `Access-Control-Allow-Origin` to that allowlist instead of inheriting the
// permissive global default.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const TIMEOUT_HEADER = "x-swarm-timeout-ms";
// Args are a JSON payload, not a file upload — 1MB matches the sandbox's own
// stdout cap. Applies even to authMode: 'none' endpoints, where the caller is
// otherwise fully unauthenticated.
const MAX_BODY_BYTES = 1 * 1024 * 1024;

const scriptApiRoute = route({
  method: "post",
  path: "/api/x/script/{endpointId}",
  pattern: ["api", "x", "script", null],
  operationId: "x_script_run",
  summary: "Invoke an externally-exposed swarm script",
  description:
    "Runs the script bound to this endpoint and returns a JSON envelope " +
    "`{ ok, result, error, durationMs }` (HTTP 200) once execution is reached. " +
    "Auth/routing failures use 401 (bad/missing bearer) and 404 (unknown or " +
    "disabled endpoint). Optional `X-Swarm-Timeout-Ms` header (default 60000, " +
    "clamped 1000–300000) sets the wall-clock timeout.",
  tags: ["External APIs"],
  params: z.object({ endpointId: z.string() }),
  auth: { apiKey: false },
  responses: {
    200: { description: "Script executed — see `ok` in the envelope" },
    401: { description: "Missing or invalid bearer token" },
    404: { description: "Endpoint not found or disabled" },
    501: { description: "workspace-rw scripts are not supported" },
  },
});

function extractBearer(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function resolveTimeoutMs(req: IncomingMessage): number {
  const raw = req.headers[TIMEOUT_HEADER];
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (!val) return DEFAULT_TIMEOUT_MS;
  const n = Number(val);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)));
}

type ExternalError = { type: string; message: string; details?: string[] };

function buildExecutionError(output: RunScriptOutput): ExternalError {
  if (output.runtimeError) {
    return {
      type: "runtime_error",
      message: `${output.runtimeError.name}: ${output.runtimeError.message}`,
    };
  }
  switch (output.error) {
    case "timeout":
      return { type: "timeout", message: "Script timed out" };
    case "import_violation":
      return { type: "import_violation", message: output.stderr || "Disallowed import" };
    default:
      return {
        type: "runtime_error",
        message: output.error
          ? `Script failed: ${output.error}`
          : `Script exited with code ${output.exitCode}`,
      };
  }
}

export async function handleX(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
): Promise<boolean> {
  if (!scriptApiRoute.match(req.method, pathSegments)) return false;

  const endpointId = pathSegments[3] ?? "";
  const endpoint = getScriptApiById(endpointId);
  // Treat disabled endpoints as not-found so we don't leak their existence.
  if (!endpoint || !endpoint.enabled) {
    json(res, { error: { type: "not_found", message: "Endpoint not found" } }, 404);
    return true;
  }

  if (endpoint.authMode === "bearer") {
    const provided = extractBearer(req);
    const expected = getScriptApiSecret(endpointId);
    if (!provided || !expected || !timingSafeEqualStr(provided, expected)) {
      json(
        res,
        { error: { type: "unauthorized", message: "Invalid or missing bearer token" } },
        401,
      );
      return true;
    }
  }

  if (enforceContentLengthCap(req, res, MAX_BODY_BYTES) === BODY_TOO_LARGE) return true;

  // The whole JSON body is the script's `args`.
  let args: unknown;
  try {
    args = await parseBody(req);
  } catch {
    json(res, {
      ok: false,
      result: null,
      error: { type: "invalid_json", message: "Request body must be valid JSON" },
      durationMs: 0,
    });
    return true;
  }

  const script = getScriptById(endpoint.scriptId);
  if (!script) {
    json(res, { error: { type: "not_found", message: "Script not found" } }, 404);
    return true;
  }
  if (script.fsMode === "workspace-rw") {
    jsonError(res, "workspace-rw scripts are not supported", 501);
    return true;
  }

  // Typed input validation against the stored args JSON schema (when present).
  // Scripts predating the schema column, or where extraction failed, have a
  // null schema — we skip and let the in-subprocess Zod check surface as a
  // runtime_error instead.
  if (script.argsJsonSchema) {
    try {
      const schema = JSON.parse(script.argsJsonSchema) as Record<string, unknown>;
      const errors = validateJsonSchema(schema, args ?? null);
      if (errors.length > 0) {
        json(res, {
          ok: false,
          result: null,
          error: { type: "args_validation", message: errors.join("; "), details: errors },
          durationMs: 0,
        });
        return true;
      }
    } catch {
      // Malformed stored schema — don't block execution on it.
    }
  }

  const timeoutMs = resolveTimeoutMs(req);
  const startedAt = new Date().toISOString();

  const credentials = await buildScriptCredentialBindingsWithFailures({
    agentId: endpoint.agentId,
  });
  const output = await runScript({
    source: script.source,
    args: args ?? null,
    fsMode: "none",
    agentId: endpoint.agentId,
    // timeoutMs only raises the wall-clock limit (network-bound scripts can use
    // the full window); the CPU ulimit (`ulimit -t`) is intentionally left at
    // the runtime default rather than scaled with the caller-controlled
    // timeout, so an external caller can't use a long X-Swarm-Timeout-Ms to
    // burn proportionally more CPU per request.
    timeoutMs,
    egressSecrets: credentials.egressSecrets,
    failedBindings: credentials.failedBindings,
    apiConnections: getScriptApiConnectionDescriptors({ agentId: endpoint.agentId }),
    mcpConnections: getScriptMcpConnectionDescriptors({ agentId: endpoint.agentId }),
  });

  const ok = output.exitCode === 0 && !output.error && !output.runtimeError;
  const error = ok ? null : buildExecutionError(output);

  // Usage + observability — best-effort, must never fail the response.
  try {
    recordScriptApiUsage(endpointId);
  } catch {
    // ignore
  }
  try {
    recordInlineScriptRun({
      id: crypto.randomUUID(),
      agentId: endpoint.agentId,
      source: script.source,
      args: scrubObject(args ?? null),
      scriptName: script.name,
      status: ok ? "completed" : "failed",
      output: scrubObject(output.result),
      error: ok ? undefined : scrubSecrets(error?.message ?? "Script failed"),
      startedAt,
      finishedAt: new Date().toISOString(),
      apiEndpointId: endpointId,
    });
  } catch {
    // ignore — the run already executed; persistence is observability only.
  }

  // Never expose stdout/stderr to external callers.
  json(
    res,
    scrubObject({ ok, result: ok ? output.result : null, error, durationMs: output.durationMs }),
  );
  return true;
}
