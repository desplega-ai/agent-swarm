import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { fetchInstalledMcpServers } from "./mcp-server-fetcher.ts";

const originalFetch = global.fetch;

function mockFetchWithServers(servers: unknown[]) {
  global.fetch = mock(
    async () => new Response(JSON.stringify({ servers }), { status: 200 }),
  ) as unknown as typeof fetch;
}

describe("fetchInstalledMcpServers", () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("stdio transport", () => {
    const stdioServer = {
      name: "gitlab",
      transport: "stdio",
      isActive: true,
      isEnabled: true,
      command: "npx",
      args: JSON.stringify(["-y", "@zereight/mcp-gitlab"]),
      resolvedEnv: { GITLAB_TOKEN: "secret" },
    };

    beforeEach(() => {
      mockFetchWithServers([stdioServer]);
    });

    it("uses command/args/env shape for the claude format", async () => {
      const result = await fetchInstalledMcpServers("https://api", "key", "agent", "claude");
      expect(result).toEqual({
        gitlab: {
          command: "npx",
          args: ["-y", "@zereight/mcp-gitlab"],
          env: { GITLAB_TOKEN: "secret" },
        },
      });
    });

    it("uses the local/command-array/environment shape for the opencode format", async () => {
      const result = await fetchInstalledMcpServers("https://api", "key", "agent", "opencode");
      expect(result).toEqual({
        gitlab: {
          type: "local",
          command: ["npx", "-y", "@zereight/mcp-gitlab"],
          environment: { GITLAB_TOKEN: "secret" },
        },
      });
    });
  });

  describe("http/sse transport", () => {
    const httpServer = {
      name: "docs",
      transport: "http",
      isActive: true,
      isEnabled: true,
      url: "https://example.com/mcp",
      resolvedHeaders: { Authorization: "Bearer token" },
    };

    it("keeps the transport-specific type for the claude format", async () => {
      mockFetchWithServers([httpServer]);
      const result = await fetchInstalledMcpServers("https://api", "key", "agent", "claude");
      expect(result).toEqual({
        docs: {
          type: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer token" },
        },
      });
    });

    it("uses the remote type for the opencode format", async () => {
      mockFetchWithServers([httpServer]);
      const result = await fetchInstalledMcpServers("https://api", "key", "agent", "opencode");
      expect(result).toEqual({
        docs: {
          type: "remote",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer token" },
        },
      });
    });
  });
});
