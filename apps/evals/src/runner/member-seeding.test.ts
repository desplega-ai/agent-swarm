import { describe, expect, test } from "bun:test";
import {
  applyMemberProfiles,
  runWorkerExec,
  type SeedMember,
  type WorkerExecOutput,
} from "./member-seeding.ts";

const MEMBERS: SeedMember[] = [
  { index: 0, role: "worker", agentId: "a0", sandboxId: "sb0", profile: { role: "ops" } },
  { index: 1, role: "worker", agentId: "a1", sandboxId: "sb1" },
  { index: 2, role: "lead", agentId: "lead", sandboxId: "sb2" },
];

describe("applyMemberProfiles", () => {
  test("writes only the members that declare a profile", async () => {
    const calls: [string, unknown][] = [];
    const written = await applyMemberProfiles(MEMBERS, async (id, p) => {
      calls.push([id, p]);
    });
    expect(written).toEqual([0]);
    expect(calls).toEqual([["a0", { role: "ops" }]]);
  });

  test("a failed write fails the seed, naming the member", async () => {
    await expect(
      applyMemberProfiles(MEMBERS, async () => {
        throw new Error("PUT -> 500");
      }),
    ).rejects.toThrow("profile for worker 0 failed: PUT -> 500");
  });
});

describe("runWorkerExec", () => {
  test("runs each entry in its own worker's sandbox, in order, recording outputs", async () => {
    const ran: string[] = [];
    const outputs: WorkerExecOutput[] = [];
    await runWorkerExec({
      entries: [
        { worker: 1, commands: ["one", "two"] },
        { worker: 0, commands: ["three"] },
      ],
      members: MEMBERS,
      exec: async (sb, cmd) => {
        ran.push(`${sb}:${cmd}`);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      outputs,
    });
    expect(ran).toEqual(["sb1:one", "sb1:two", "sb0:three"]);
    expect(outputs.map((o) => [o.worker, o.cmd, o.exitCode])).toEqual([
      [1, "one", 0],
      [1, "two", 0],
      [0, "three", 0],
    ]);
  });

  test("a non-zero exit stops the seed, and the failing output is still recorded", async () => {
    const outputs: WorkerExecOutput[] = [];
    await expect(
      runWorkerExec({
        entries: [{ worker: 1, commands: ["bad", "never"] }],
        members: MEMBERS,
        exec: async () => ({ exitCode: 2, stdout: "", stderr: "boom" }),
        outputs,
      }),
    ).rejects.toThrow("seed.workerExec command failed on worker 1 (2)");
    expect(outputs.map((o) => o.cmd)).toEqual(["bad"]);
  });

  test("the lead is never a workerExec target", async () => {
    await expect(
      runWorkerExec({
        entries: [{ worker: 2, commands: ["x"] }],
        members: MEMBERS,
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        outputs: [],
      }),
    ).rejects.toThrow("targets worker 2, not booted");
  });
});
