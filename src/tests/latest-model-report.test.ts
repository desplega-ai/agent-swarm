import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildLatestModelReport,
  taskSelectedModelForReport,
} from "../commands/provider-credentials";

const CONFIG = "openrouter/deepseek/deepseek-v4-pro";
const RESOLVED = "openrouter/deepseek/deepseek-v4.1-flash";

/** The three reports the runner sends for one task, built the way runner.ts builds them. */
function reportsFor(claim: { resolvedModel?: string; modelSource?: string; localModel?: string }) {
  const taskModel = taskSelectedModelForReport(claim);
  const common = { taskModel, configModel: CONFIG, harnessProvider: "pi" as const };
  const used = claim.resolvedModel ?? claim.localModel ?? CONFIG;
  return [
    buildLatestModelReport({ ...common, model: used }),
    buildLatestModelReport({ ...common, model: used }),
    buildLatestModelReport({ ...common, model: used }),
  ].map((r) => r?.source);
}

describe("latest model report source across initial, result and final reports", () => {
  test.each([
    "tier-default",
    "tier-config",
    "worker-env",
    "profile:task",
    "profile:tier-alias",
  ])("claim source %s stays task-selected in every report", (modelSource) => {
    expect(reportsFor({ resolvedModel: RESOLVED, modelSource })).toEqual(["task", "task", "task"]);
  });

  test("a task pin stays task-selected", () => {
    expect(reportsFor({ resolvedModel: RESOLVED, modelSource: "model" })).toEqual([
      "task",
      "task",
      "task",
    ]);
  });

  test("no server resolution: the local tier/pin selection stays task-selected", () => {
    expect(reportsFor({ localModel: RESOLVED })).toEqual(["task", "task", "task"]);
  });

  test("the agent default profile is not task-selected", () => {
    expect(reportsFor({ resolvedModel: RESOLVED, modelSource: "profile:agent-default" })).toEqual([
      "custom",
      "custom",
      "custom",
    ]);
    expect(reportsFor({ resolvedModel: CONFIG, modelSource: "profile:agent-default" })).toEqual([
      "agent_config",
      "agent_config",
      "agent_config",
    ]);
  });

  test("the pre-fix final report (raw pin only) loses task origin for a tier run", () => {
    const old = buildLatestModelReport({
      model: RESOLVED,
      taskModel: undefined,
      configModel: CONFIG,
      harnessProvider: "pi",
    });
    expect(old?.source).toBe("custom");
  });

  test("the runner builds the initial, result and final reports from the same task-selected model", () => {
    const src = readFileSync(join(import.meta.dir, "../commands/runner.ts"), "utf8");
    expect(src.match(/taskModel: reportTaskModel,/g)?.length).toBe(3);
    expect(src).not.toContain("taskModel: opts.model,");
  });
});
