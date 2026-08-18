import { describe, expect, test } from "bun:test";
import {
  contentSha256,
  fetchProfileSyncRejectionBanner,
  prependProfileSyncRejectionBanner,
  renderProfileSyncRejectionBanner,
  TOOLS_MD_PATH,
  WORKSPACE_CLAUDE_MD_PATH,
} from "../commands/profile-sync";
import type { SwarmEvent } from "../types";

const rejectionEvent: SwarmEvent = {
  id: "00000000-0000-4000-8000-000000000001",
  category: "system",
  event: "system.profile_sync_rejected",
  status: "error",
  source: "api",
  agentId: "agent-1",
  createdAt: "2026-08-18T15:55:00.000Z",
  data: {
    field: "toolsMd",
    diskSize: 84_574,
    dbSize: 83_679,
    budget: 20_000,
    delta: 895,
    dbHash: contentSha256("db tools"),
    changeSource: "session_sync",
  },
};

const reconciliationEvent: SwarmEvent = {
  ...rejectionEvent,
  id: "00000000-0000-4000-8000-000000000003",
  event: "system.profile_sync_reconciled",
  status: "ok",
  createdAt: "2026-08-18T16:00:00.000Z",
};

describe("profile sync rejection session warning", () => {
  test("carries field, disk size, DB size, budget, delta, and recovery path", async () => {
    const banner = await renderProfileSyncRejectionBanner(rejectionEvent);

    expect(banner).toContain("/workspace/TOOLS.md");
    expect(banner).toContain("Disk size: 84574");
    expect(banner).toContain("DB size: 83679");
    expect(banner).toContain("budget: 20000");
    expect(banner).toContain("delta: +895");
    expect(banner).toContain(".pre-boot-<timestamp>.bak");
    expect(banner.indexOf("live /workspace/TOOLS.md")).toBeLessThan(
      banner.indexOf("/workspace/TOOLS.md.pre-boot-<timestamp>.bak"),
    );
    expect(banner).toContain(rejectionEvent.id);
  });

  test("queries the latest persisted event for the current agent", async () => {
    const requests: Request[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const field = new URL(request.url).searchParams.get("dataField");
      const body = request.url.endsWith("/me")
        ? { toolsMd: "db tools" }
        : { events: field === "toolsMd" ? [rejectionEvent] : [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await prependProfileSyncRejectionBanner(
      "ORIGINAL TASK PROMPT",
      {
        apiUrl: "https://api.example.test",
        apiKey: "secret-key",
        agentId: "agent-1",
      },
      fetchImpl,
    );

    expect(requests[0]?.url).toContain("event=system.profile_sync_rejected");
    expect(requests[0]?.url).toContain("agentId=agent-1");
    expect(requests[0]?.url).toContain("limit=1");
    expect(requests[0]?.url).toContain("dataField=soulMd");
    expect(requests[0]?.headers.get("X-Agent-ID")).toBe("agent-1");
    expect(requests.at(-1)?.url).toBe("https://api.example.test/me");
    expect(result.injected).toBeTrue();
    expect(result.prompt).toContain("PERSISTED PROFILE SYNC REJECTION");
    expect(result.prompt).toEndWith("ORIGINAL TASK PROMPT");
  });

  test("stops warning after the stored field changes", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      const field = new URL(url).searchParams.get("dataField");
      const body = url.endsWith("/me")
        ? { toolsMd: "reconciled tools" }
        : { events: field === "toolsMd" ? [rejectionEvent] : [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const banner = await fetchProfileSyncRejectionBanner(
      {
        apiUrl: "https://api.example.test",
        apiKey: "secret-key",
        agentId: "agent-1",
      },
      fetchImpl,
    );

    expect(banner).toBe("");
  });

  test("stops warning after a successful no-op reconciliation", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const field = url.searchParams.get("dataField");
      const event = url.searchParams.get("event");
      const body = url.pathname.endsWith("/me")
        ? { toolsMd: "db tools" }
        : {
            events:
              field !== "toolsMd"
                ? []
                : event === "system.profile_sync_reconciled"
                  ? [reconciliationEvent]
                  : [rejectionEvent],
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const banner = await fetchProfileSyncRejectionBanner(
      {
        apiUrl: "https://api.example.test",
        apiKey: "secret-key",
        agentId: "agent-1",
      },
      fetchImpl,
    );

    expect(banner).toBe("");
  });

  test("keeps warning when the latest reconciliation predates the rejection", async () => {
    const olderReconciliation = {
      ...reconciliationEvent,
      createdAt: "2026-08-18T15:50:00.000Z",
    };
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const field = url.searchParams.get("dataField");
      const event = url.searchParams.get("event");
      const body = url.pathname.endsWith("/me")
        ? { toolsMd: "db tools" }
        : {
            events:
              field !== "toolsMd"
                ? []
                : event === "system.profile_sync_reconciled"
                  ? [olderReconciliation]
                  : [rejectionEvent],
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const banner = await fetchProfileSyncRejectionBanner(
      {
        apiUrl: "https://api.example.test",
        apiKey: "secret-key",
        agentId: "agent-1",
      },
      fetchImpl,
    );

    expect(banner).toContain("PERSISTED PROFILE SYNC REJECTION");
  });

  test("clears a warning only when boot restored the local file to the DB value", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const field = url.searchParams.get("dataField");
      const event = url.searchParams.get("event");
      const body = url.pathname.endsWith("/me")
        ? { toolsMd: "db tools" }
        : {
            events:
              field === "toolsMd" && event === "system.profile_sync_rejected"
                ? [rejectionEvent]
                : [],
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const config = {
      apiUrl: "https://api.example.test",
      apiKey: "secret-key",
      agentId: "agent-1",
      claudeMdPath: WORKSPACE_CLAUDE_MD_PATH,
    };

    const restored = await fetchProfileSyncRejectionBanner(config, fetchImpl, async (path) =>
      path === TOOLS_MD_PATH ? "db tools" : undefined,
    );
    const stillDiverged = await fetchProfileSyncRejectionBanner(config, fetchImpl, async (path) =>
      path === TOOLS_MD_PATH ? "rejected tools" : undefined,
    );

    expect(restored).toBe("");
    expect(stillDiverged).toContain("PERSISTED PROFILE SYNC REJECTION");
  });

  test("surfaces the latest unresolved rejection for every affected field", async () => {
    const claudeEvent: SwarmEvent = {
      ...rejectionEvent,
      id: "00000000-0000-4000-8000-000000000002",
      data: {
        ...rejectionEvent.data,
        field: "claudeMd",
        diskSize: 99_617,
        dbSize: 99_602,
        delta: 15,
        dbHash: contentSha256("db claude"),
      },
    };
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      const field = new URL(url).searchParams.get("dataField");
      const body = url.endsWith("/me")
        ? { toolsMd: "db tools", claudeMd: "db claude" }
        : {
            events:
              field === "claudeMd" ? [claudeEvent] : field === "toolsMd" ? [rejectionEvent] : [],
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const banner = await fetchProfileSyncRejectionBanner(
      {
        apiUrl: "https://api.example.test",
        apiKey: "secret-key",
        agentId: "agent-1",
      },
      fetchImpl,
    );

    expect(banner).toContain("/workspace/CLAUDE.md");
    expect(banner).toContain("~/.claude/CLAUDE.md");
    expect(banner).toContain("is not archived by that boot step");
    expect(banner).toContain("/workspace/TOOLS.md");
  });

  test("fails open when the audit event cannot be fetched", async () => {
    const banner = await fetchProfileSyncRejectionBanner(
      {
        apiUrl: "https://api.example.test",
        apiKey: "secret-key",
        agentId: "agent-1",
      },
      (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
    );

    expect(banner).toBe("");
  });
});
