import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getWorkerInstallationToken } from "../github/app";
import { resolveRequestPrincipal } from "./request-principal";
import { route } from "./route-def";
import { jsonError } from "./utils";

const installationTokenRoute = route({
  method: "post",
  path: "/api/github/installation-token",
  pattern: ["api", "github", "installation-token"],
  summary: "Mint a GitHub App installation token for worker git and gh",
  description:
    "Internal worker endpoint. Returns a short-lived installation token for the installation in `GITHUB_APP_INSTALLATION_ID`, minted with the API server's GitHub App credentials. The caller cannot choose the installation. Only a registered agent may call it; user and guest tokens are refused. 404 when the App or the installation id is not configured, so workers fall back to `GITHUB_TOKEN`.",
  tags: ["GitHub"],
  body: z.object({}).optional(),
  responses: {
    200: {
      description: "Installation token and its expiry (ISO 8601)",
      schema: z.object({ token: z.string(), expiresAt: z.string() }),
    },
    403: { description: "Caller is not a registered agent" },
    404: { description: "GitHub App worker auth is not configured" },
    502: { description: "GitHub refused or failed to mint the token" },
  },
  auth: { apiKey: true, agentId: true },
  rbac: {
    ungated:
      "the handler admits only registered agent principals and mints for one fixed installation",
  },
});

export async function handleGitHubToken(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  myAgentId: string | undefined,
): Promise<boolean> {
  if (!installationTokenRoute.match(req.method, pathSegments)) return false;
  const parsed = await installationTokenRoute.parse(req, res, pathSegments, new URLSearchParams());
  if (!parsed) return true;
  const principal = await resolveRequestPrincipal(req, myAgentId, {
    precedence: "agent-first",
    requireRegisteredAgent: true,
  });
  if (principal?.kind !== "agent" || !principal.agentId) {
    jsonError(res, "Only a registered agent may mint a GitHub installation token", 403);
    return true;
  }
  const result = await getWorkerInstallationToken();
  if (result.status === "unconfigured") {
    jsonError(res, "GitHub App worker auth is not configured", 404);
    return true;
  }
  if (result.status === "error") {
    jsonError(res, "GitHub did not mint an installation token", 502);
    return true;
  }
  res.setHeader("Cache-Control", "no-store");
  installationTokenRoute.respond(res, 200, { token: result.token, expiresAt: result.expiresAt });
  return true;
}
