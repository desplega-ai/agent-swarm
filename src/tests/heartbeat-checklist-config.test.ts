import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { startHeartbeatChecklist, stopHeartbeatChecklist } from "../heartbeat/heartbeat";

// startHeartbeatChecklist reads HEARTBEAT_CHECKLIST_DISABLE and
// HEARTBEAT_CHECKLIST_INTERVAL_MS at call time. These cases pin how each raw
// env string is interpreted, observed through the startup log line.
const ENV_KEYS = ["HEARTBEAT_CHECKLIST_DISABLE", "HEARTBEAT_CHECKLIST_INTERVAL_MS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function startWithEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>): string[] {
  for (const key of ENV_KEYS) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  const spy = spyOn(console, "log").mockImplementation(() => {});
  try {
    startHeartbeatChecklist();
    return spy.mock.calls.map((args) => String(args[0]));
  } finally {
    spy.mockRestore();
  }
}

const DISABLED = "[Heartbeat] Checklist disabled via HEARTBEAT_CHECKLIST_DISABLE";
const TICK_OFF =
  "[Heartbeat] Recurring checklist off (HEARTBEAT_CHECKLIST_INTERVAL_MS=0); boot triage still scheduled";
const starting = (ms: number) => `[Heartbeat] Checklist starting with ${ms}ms interval`;

describe("startHeartbeatChecklist env parsing", () => {
  afterEach(() => {
    stopHeartbeatChecklist();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test.each([
    ["unset", undefined],
    ["empty", ""],
    ["false", "false"],
    ["0", "0"],
    ["FALSE", "FALSE"],
    ["typo falls back to on", "treu"],
  ])("HEARTBEAT_CHECKLIST_DISABLE %s keeps the checklist on", (_label, value) => {
    expect(startWithEnv({ HEARTBEAT_CHECKLIST_DISABLE: value })).toEqual([starting(1_800_000)]);
  });

  test.each([
    ["true"],
    ["1"],
    ["TRUE"],
  ])("HEARTBEAT_CHECKLIST_DISABLE %s turns the checklist off", (value) => {
    expect(startWithEnv({ HEARTBEAT_CHECKLIST_DISABLE: value })).toEqual([DISABLED]);
  });

  test.each([
    ["0", [TICK_OFF]],
    ["-5", [TICK_OFF]],
    ["60000", [starting(60_000)]],
    ["abc", [starting(1_800_000)]],
    ["", [starting(1_800_000)]],
  ])("HEARTBEAT_CHECKLIST_INTERVAL_MS=%p", (value, expected) => {
    expect(startWithEnv({ HEARTBEAT_CHECKLIST_INTERVAL_MS: value })).toEqual(expected);
  });

  test("interval 0: a second start does not schedule boot triage again", () => {
    expect(startWithEnv({ HEARTBEAT_CHECKLIST_INTERVAL_MS: "0" })).toEqual([TICK_OFF]);
    expect(startWithEnv({ HEARTBEAT_CHECKLIST_INTERVAL_MS: "0" })).toEqual([]);
  });
});
