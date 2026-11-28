import { describe, expect, test } from "bun:test";
import type { SessionLogRow } from "../swarm/client.ts";
import type { SwarmTask } from "../types.ts";
import { collectSpawnedLogs, parseSpawnedLogs, serializeSpawnedLogs } from "./spawned-logs.ts";

const task = (id: string, origin: "run" | "seed" = "run"): SwarmTask => ({
  id,
  title: "",
  description: "",
  status: "completed",
  origin,
});
const row = (taskId: string, content = "x"): SessionLogRow => ({
  id: crypto.randomUUID(),
  taskId,
  sessionId: "s",
  iteration: 0,
  cli: "claude",
  lineNumber: 0,
  content,
  createdAt: "",
});

describe("spawned session logs", () => {
  test("fetches run tasks outside the upfront set and records failed fetches", async () => {
    const logs = await collectSpawnedLogs(
      [task("up"), task("child"), task("wake"), task("broken"), task("old", "seed")],
      new Set(["up"]),
      async (id) => {
        if (id === "broken") throw new Error("503");
        return id === "child" ? [row("child")] : [];
      },
    );
    expect(logs).toEqual({
      taskIds: ["child", "wake"],
      failedTaskIds: ["broken"],
      truncated: false,
      rows: [expect.objectContaining({ taskId: "child" })],
    });
  });

  test("round-trips through the artifact, drops rows over the cap, rejects other shapes", () => {
    const logs = { taskIds: ["a"], failedTaskIds: [], truncated: false, rows: [row("a")] };
    expect(parseSpawnedLogs(serializeSpawnedLogs(logs, (s) => s))).toEqual(logs);
    const big = { ...logs, rows: [row("a", "y".repeat(2_000_001))] };
    expect(parseSpawnedLogs(serializeSpawnedLogs(big, (s) => s))).toEqual({
      ...logs,
      truncated: true,
      rows: [],
    });
    expect(parseSpawnedLogs("{")).toBeNull();
    expect(parseSpawnedLogs('{"rows":[]}')).toBeNull();
  });
});
