import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getDbClient,
  getScheduledTaskByName,
  initDb,
} from "../be/db";
import { registerCreateScheduleTool } from "../tools/schedules/create-schedule";

describe("create-schedule key inheritance", () => {
  beforeAll(() => initDb(":memory:"));
  afterAll(() => closeDb());

  test.each([
    { name: "source group", taskKey: "shared/research/", inherited: true },
    { name: "current task group", taskKey: "shared/research/", current: true, inherited: true },
    { name: "resource leaf", taskKey: "shared/task:abc/" },
    { name: "chat source group", taskKey: "shared/slack/c1/" },
    { name: "chat source thread", taskKey: "shared/slack/c1/thread:1/" },
    { name: "namespace root", taskKey: "shared/" },
    { name: "personal root", taskKey: "personal-root" },
    { name: "explicit override", taskKey: "shared/research/", key: "shared/override/" },
    { name: "another agent's task", taskKey: "shared/research/", spoof: true },
    { name: "own personal group", taskKey: "personal-own", inherited: true },
    { name: "another user's personal group", taskKey: "personal-other", denied: true },
    {
      name: "explicit personal mismatch",
      taskKey: "shared/research/",
      key: "personal-other",
      denied: true,
    },
  ])("$name", async (entry) => {
    const caller = await createAgent({ name: entry.name, status: "idle" });
    const requester = await createUser({ name: "Schedule requester" });
    const other = await createUser({ name: "Other schedule user" });
    const resolveKey = (key: string) =>
      key === "personal-own"
        ? `personal/${requester.id}/research/`
        : key === "personal-other"
          ? `personal/${other.id}/research/`
          : key === "personal-root"
            ? `personal/${requester.id}/`
            : key;
    const source = await createTaskExtended("Schedule source", {
      agentId: entry.spoof ? crypto.randomUUID() : caller.id,
      requestedByUserId: requester.id,
      key: resolveKey(entry.taskKey),
    });
    if (entry.current) {
      await getDbClient().run("UPDATE agent_tasks SET status = 'in_progress' WHERE id = ?", [
        source.id,
      ]);
    }
    const server = new McpServer({ name: "schedule-key-test", version: "1.0.0" });
    registerCreateScheduleTool(server);
    const tool = (
      server as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
          }
        >;
      }
    )._registeredTools["create-schedule"]!;
    const name = crypto.randomUUID();
    const result = await tool.handler(
      {
        name,
        taskTemplate: "Scheduled work",
        intervalMs: 3_600_000,
        ...(entry.key ? { key: resolveKey(entry.key) } : {}),
      },
      {
        requestInfo: {
          headers: {
            "x-agent-id": caller.id,
            ...(!entry.current ? { "x-source-task-id": source.id } : {}),
          },
        },
      },
    );
    const schedule = await getScheduledTaskByName(name);
    if (entry.denied) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.message).toContain("matching trusted user");
      expect(schedule).toBeNull();
    } else {
      expect(result.isError).not.toBe(true);
      expect(schedule?.key).toBe(
        entry.key
          ? resolveKey(entry.key)
          : entry.inherited
            ? source.key
            : `shared/schedule:${schedule?.id}/`,
      );
      expect(schedule?.createdBy).toBe(entry.spoof ? undefined : requester.id);
    }
  });
});
