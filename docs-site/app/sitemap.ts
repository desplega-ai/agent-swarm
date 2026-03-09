import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = "https://docs.agent-swarm.dev";

  const docPages = [
    "/docs",
    "/docs/getting-started",
    "/docs/architecture/overview",
    "/docs/architecture/agents",
    "/docs/architecture/memory",
    "/docs/architecture/hooks",
    "/docs/concepts/task-lifecycle",
    "/docs/concepts/epics",
    "/docs/concepts/services",
    "/docs/concepts/scheduling",
    "/docs/concepts/workflows",
    "/docs/guides/deployment",
    "/docs/guides/slack-integration",
    "/docs/guides/github-integration",
    "/docs/guides/agentmail-integration",
    "/docs/guides/sentry-integration",
    "/docs/guides/x402-payments",
    "/docs/reference/mcp-tools",
    "/docs/reference/environment-variables",
    "/docs/reference/cli",
  ];

  return docPages.map((path) => ({
    url: `${baseUrl}${path}`,
    lastModified: new Date(),
    changeFrequency: "weekly" as const,
    priority: path === "/docs" ? 1 : 0.8,
  }));
}
