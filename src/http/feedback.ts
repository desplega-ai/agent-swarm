import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import pkg from "../../package.json";
import { getSwarmConfigs, upsertSwarmConfig } from "../be/db";
import { getRequestAuth } from "../utils/request-auth-context";
import { route } from "./route-def";
import { jsonError } from "./utils";

const DEFAULT_FEEDBACK_ENDPOINT = "https://proxy.desplega.sh/v1/feedback";
const FEEDBACK_TIMEOUT_MS = 5_000;

const createFeedbackRoute = route({
  method: "post",
  path: "/api/feedback",
  pattern: ["api", "feedback"],
  summary: "Forward an explicit feedback submission to the feedback proxy",
  tags: ["Feedback"],
  body: z.object({
    submission_id: z.string().trim().min(1).max(128),
    name: z.string().trim().max(200).optional(),
    email: z.string().trim().email().max(320).optional(),
    newsletter_consent: z.boolean(),
    nps: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
    message: z.string().trim().max(10_000).optional(),
    submitted_at: z.string().datetime({ offset: true }),
  }),
  responses: {
    202: {
      description: "Feedback accepted by the configured proxy",
      unstructured: "Response body is forwarded verbatim from the configured feedback proxy",
    },
    400: { description: "Validation error from this server or the feedback proxy" },
    401: { description: "Unauthorized" },
    413: { description: "Feedback body is too large" },
    429: { description: "Feedback proxy rate limit exceeded" },
    500: { description: "Feedback proxy request failed" },
    503: { description: "Feedback storage is not configured on the proxy" },
  },
  auth: { apiKey: true },
  rbac: {
    ungated:
      "any authenticated caller may submit feedback; server-side request auth supplies its attribution",
  },
});

async function readGlobalConfig(key: string): Promise<string | null> {
  const rows = await getSwarmConfigs({ scope: "global", key });
  return rows[0]?.value || null;
}

async function getInstallationIdentity(): Promise<{
  installId: string;
  installedAt: string | null;
}> {
  const [existingId, installedAt] = await Promise.all([
    readGlobalConfig("telemetry_installation_id"),
    readGlobalConfig("telemetry_installed_at"),
  ]);
  if (existingId) return { installId: existingId, installedAt };

  const installId = `install_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await upsertSwarmConfig({ scope: "global", key: "telemetry_installation_id", value: installId });
  return { installId, installedAt };
}

export async function handleFeedback(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  if (!createFeedbackRoute.match(req.method, pathSegments)) return false;
  const parsed = await createFeedbackRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? FEEDBACK_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const auth = getRequestAuth(req);
    if (!auth) {
      jsonError(res, "Unauthorized", 401);
      return true;
    }
    const identity = await getInstallationIdentity();
    const endpoint = process.env.FEEDBACK_ENDPOINT?.trim() || DEFAULT_FEEDBACK_ENDPOINT;
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...parsed.body,
        name: parsed.body.name || null,
        email: parsed.body.email || null,
        nps: parsed.body.nps ?? null,
        message: parsed.body.message || null,
        user_id: auth.kind === "user" ? auth.userId : auth.fingerprint,
        install_id: identity.installId,
        swarm_version: pkg.version,
        org_name: process.env.SWARM_ORG_NAME?.trim() || null,
        installed_at: identity.installedAt,
      }),
      signal: controller.signal,
    });

    const responseBody = await response.text();
    const retryAfter = response.headers.get("Retry-After");
    if (retryAfter) res.setHeader("Retry-After", retryAfter);
    const contentType = response.headers.get("Content-Type");
    if (contentType) res.setHeader("Content-Type", contentType);
    res.writeHead(response.status);
    res.end(responseBody);
  } catch (error) {
    console.warn(
      `[feedback] Proxy request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    jsonError(res, "Failed to submit feedback", 500);
  } finally {
    clearTimeout(timeout);
  }
  return true;
}
