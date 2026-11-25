import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { resolveHttpAuditUserId } from "../be/audit-user";
import { userHoldsExplicitVerb } from "../be/rbac-roles";
import {
  MAX_RUNNER_CREDENTIAL_TTL_MS,
  mintScriptRunnerCredential,
  revokeScriptRunnerCredential,
} from "../be/script-runners/credentials";
import { listScriptRunnerSessions } from "../be/script-runners/sessions";
import { getStorage } from "../be/storage";
import { can } from "../rbac";
import { syncLaneMetrics } from "../scripts-runtime/dispatch/dispatcher";
import { agentFirstPrincipal } from "./request-principal";
import { route } from "./route-def";
import { jsonError } from "./utils";

const sessions = route({
  method: "get",
  path: "/api/script-runners",
  pattern: ["api", "script-runners"],
  tags: ["Script runners"],
  summary: "List live script-runner sessions",
  rbac: { permission: "script_runner.read" },
  responses: {
    200: {
      description: "Live sessions",
      schema: z.object({
        lanes: z.object({
          sync: z.object({
            queued: z.number(),
            oldestWaitMs: z.number(),
            inFlight: z.number(),
            slots: z.number().nullable(),
          }),
        }),
        sessions: z.array(
          z.object({
            instanceId: z.string(),
            slots: z.number(),
            jobsInFlight: z.number(),
            jobsCompleted: z.number(),
          }),
        ),
      }),
    },
    403: { description: "Forbidden" },
  },
});

const credentialSchema = z.object({
  id: z.string(),
  name: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
const path = "/api/script-runners/credentials";
const pattern = ["api", "script-runners", "credentials"];
const list = route({
  method: "get",
  path,
  pattern,
  tags: ["Script runners"],
  summary: "List script-runner credentials without token material",
  rbac: { permission: "script_runner.write" },
  responses: {
    200: {
      description: "Credentials",
      schema: z.object({ credentials: z.array(credentialSchema) }),
    },
    403: { description: "Forbidden" },
  },
});
const mint = route({
  method: "post",
  path,
  pattern,
  tags: ["Script runners"],
  summary: "Mint a script-runner credential",
  rbac: { permission: "script_runner.write" },
  body: z.object({
    name: z.string().trim().min(1).max(200),
    expiresAt: z.iso
      .datetime()
      .refine((value) => Date.parse(value) > Date.now(), "Expiry must be in the future")
      .refine(
        (value) => Date.parse(value) <= Date.now() + MAX_RUNNER_CREDENTIAL_TTL_MS,
        "Expiry must be within 90 days",
      )
      .optional(),
  }),
  responses: {
    201: {
      description: "Token returned once",
      schema: z.object({ credential: credentialSchema, token: z.string() }),
    },
    400: { description: "Invalid request" },
    403: { description: "Forbidden" },
    409: { description: "script_runners_need_postgres" },
  },
});
const revoke = route({
  method: "delete",
  path: `${path}/{id}`,
  pattern: [...pattern, null],
  tags: ["Script runners"],
  summary: "Revoke a script-runner credential",
  rbac: { permission: "script_runner.write" },
  params: z.object({ id: z.string().min(1) }),
  responses: {
    200: { description: "Revoked", schema: z.object({ revoked: z.boolean() }) },
    403: { description: "Forbidden" },
    404: { description: "Credential not found" },
  },
});

export async function handleScriptRunners(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: URLSearchParams,
  agentId: string | undefined,
): Promise<boolean> {
  if (![sessions, list, mint, revoke].some((def) => def.match(req.method, segments))) return false;
  const principal = await agentFirstPrincipal(req, agentId);
  if (!principal || (principal.kind !== "operator" && principal.kind !== "user")) {
    jsonError(res, "Script-runner credentials require an operator or user", 403);
    return true;
  }
  const verb = sessions.match(req.method, segments) ? "script_runner.read" : "script_runner.write";
  if (principal.kind === "user" && !(await userHoldsExplicitVerb(principal.userId, verb))) {
    jsonError(res, `An operator must grant ${verb} to this user`, 403);
    return true;
  }
  const decision = can({ principal, verb, source: "http" });
  if (!decision.allow) {
    jsonError(res, decision.reason, 403);
    return true;
  }
  if (sessions.match(req.method, segments)) {
    if (!(await sessions.parse(req, res, segments, query))) return true;
    sessions.respond(res, 200, {
      sessions: listScriptRunnerSessions(),
      lanes: { sync: syncLaneMetrics() },
    });
  } else if (list.match(req.method, segments)) {
    if (!(await list.parse(req, res, segments, query))) return true;
    list.respond(res, 200, { credentials: await getStorage().repos.scriptRunners.list() });
  } else if (mint.match(req.method, segments)) {
    const parsed = await mint.parse(req, res, segments, query);
    if (!parsed) return true;
    if (!getStorage().capabilities.scriptRunners) {
      jsonError(res, "script_runners_need_postgres", 409);
      return true;
    }
    res.setHeader("Cache-Control", "no-store");
    const result = await mintScriptRunnerCredential(
      parsed.body.name,
      parsed.body.expiresAt,
      principal.kind === "user" ? principal.userId : null,
    );
    if (result.error === "issuer") jsonError(res, "Runner credential issuer is inactive", 403);
    else if (result.error === "expiry") jsonError(res, "Invalid runner credential expiry", 400);
    else mint.respond(res, 201, result);
  } else {
    const parsed = await revoke.parse(req, res, segments, query);
    if (!parsed) return true;
    if (
      !(await revokeScriptRunnerCredential(
        parsed.params.id,
        await resolveHttpAuditUserId(req, agentId),
      ))
    ) {
      jsonError(res, "Credential not found", 404);
      return true;
    }
    revoke.respond(res, 200, { revoked: true });
  }
  return true;
}
