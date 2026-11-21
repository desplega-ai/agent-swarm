import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  checkNativeTools,
  codexCollaborationTools,
  dockerfileDeniedTools,
} from "../../scripts/check-harness-native-tools";

const CODEX_LIVE = [
  "followup_task",
  "interrupt_agent",
  "list_agents",
  "send_message",
  "spawn_agent",
  "wait_agent",
];

describe("harness native tool check", () => {
  test("all mapped names present passes", () => {
    expect(checkNativeTools("codex", CODEX_LIVE)).toEqual({
      ok: true,
      harness: "codex",
      missing: [],
      extra: [],
    });
  });

  test("a renamed codex tool fails and names it", () => {
    const live = CODEX_LIVE.map((name) => (name === "spawn_agent" ? "spawn_subagent" : name));
    const result = checkNativeTools("codex", live);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["spawn_agent"]);
    expect(result.extra).toEqual(["spawn_subagent"]);
  });

  test("a claude spawn tool denied or renamed fails; the Task alias is not required", () => {
    const result = checkNativeTools("claude", ["Task", "ListAgents", "SendMessage", "TaskStop"]);
    expect(result).toMatchObject({ ok: false, missing: ["Agent"] });
  });

  test("reads the collaboration namespace from a prompt-input dump", () => {
    const dump = [
      { type: "message" },
      {
        type: "additional_tools",
        tools: [
          { type: "namespace", name: "functions", tools: [{ name: "exec" }, { name: "wait" }] },
          { type: "namespace", name: "collaboration", tools: [{ name: "spawn_agent" }] },
        ],
      },
    ];
    expect(codexCollaborationTools(dump)).toEqual(["spawn_agent"]);
    expect(codexCollaborationTools({})).toEqual([]);
  });

  test("reads the Dockerfile.worker deny list", async () => {
    const denied = dockerfileDeniedTools(
      await Bun.file(join(import.meta.dir, "..", "..", "Dockerfile.worker")).text(),
    );
    expect(denied).toContain("Workflow");
    expect(denied).not.toContain("Agent");
  });
});
