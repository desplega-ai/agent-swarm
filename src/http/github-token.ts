import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getWorkerInstallationToken } from "../github/app";
import { getRequestAuth } from "../utils/request-auth-context";
import { resolveRequestPrincipal } from "./request-principal";
import { route } from "./route-def";
import { jsonError } from "./utils";

const installationTokenRoute = route({
  method: "post",
  path: "/api/github/installation-token",
  pattern: ["api", "github", "installation-token"],
  summary: "Mint a GitHub App installation token for worker git and gh",
  description:
    "Internal worker endpoint. Returns a short-lived installation token for worker `git` and `gh`. With a `repo` (`owner/name`), the API resolves that repository's App installation with the App JWT and mints for it; the repository must be registered in `swarm_repos`. Without a `repo`, the installation in `GITHUB_APP_INSTALLATION_ID` is the fallback, so single-installation deployments are unchanged. Only a registered agent (swarm API key plus X-Agent-ID, or an agent or runtime token) may call it; user, guest and ACP task tokens are refused. 404 when the App is not configured, so workers fall back to `GITHUB_TOKEN`.",
  tags: ["GitHub"],
  body: z
    .object({
      repo: z
        .string()
        .max(200)
        .regex(
          /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
          "repo must be `owner/name` (letters, digits, dot, dash, underscore)",
        )
        .optional(),
    })
    .optional(),
  responses: {
    200: {
      description: "Installation token and its expiry (ISO 8601)",
      schema: z.object({ token: z.string(), expiresAt: z.string() }),
    },
    403: {
      description: "Caller is not a registered agent, or the repo is not registered in the swarm",
    },
    404: { description: "GitHub App worker auth is not configured" },
    502: {
      description:
        "GitHub refused or failed to mint the token, or the repo has no App installation",
    },
  },
  auth: { apiKey: true, agentId: true },
  rbac: {
    ungated:
      "the handler admits only registered agent principals and mints only for the fixed installation or a registered repo's installation",
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
  // Task tokens are ACP harness credentials (they read no secrets either): refuse them.
  const auth = getRequestAuth(req);
  const taskToken = auth?.kind === "agent" && auth.tokenKind === "task";
  if (principal?.kind !== "agent" || !principal.agentId || taskToken) {
    jsonError(res, "Only a registered agent may mint a GitHub installation token", 403);
    return true;
  }
  const result = await getWorkerInstallationToken(parsed.body?.repo);
  if (result.status === "unconfigured") {
    jsonError(res, "GitHub App worker auth is not configured", 404);
    return true;
  }
  if (result.status === "forbidden") {
    jsonError(res, "The repo is not registered in the swarm", 403);
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
