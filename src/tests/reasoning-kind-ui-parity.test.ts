// The UI parser must tag exactly the Claude rows the server stores as
// reasoningKind = 'update': store real lines with createSessionLogs, read them
// back, parse them, and compare row by row.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { normalizeSessionLogs } from "../../apps/ui/src/logs-parser";
import type { SessionLogRecord } from "../../apps/ui/src/logs-parser/types";
import { closeDb, createSessionLogs, getDbClient, getSessionLogsBySession, initDb } from "../be/db";

const TEST_DB_PATH = "./test-reasoning-kind-ui-parity.sqlite";

beforeAll(async () => {
  await initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) await unlink(TEST_DB_PATH + suffix).catch(() => {});
});

const assistant = (messageId: string, block: unknown) =>
  JSON.stringify({
    type: "assistant",
    message: { id: messageId, role: "assistant", content: [block] },
  });
const think = (text: string, messageId = "msg_1") =>
  assistant(messageId, { type: "thinking", thinking: text });
const toolUse = (messageId = "msg_1") =>
  assistant(messageId, { type: "tool_use", id: "tu_1", name: "Read", input: {} });
const text = (value: string, messageId = "msg_1") =>
  assistant(messageId, { type: "text", text: value });
const toolProgress = JSON.stringify({
  type: "tool_progress",
  tool_use_id: "background-tool",
  tool_name: "Bash",
  elapsed_time_seconds: 3,
});
const systemInit = JSON.stringify({ type: "system", subtype: "init", session_id: "s" });

async function store(posts: string[][]): Promise<SessionLogRecord[]> {
  const sessionId = crypto.randomUUID();
  for (const lines of posts)
    await createSessionLogs({ sessionId, iteration: 1, cli: "claude", lines });
  return (await getSessionLogsBySession(sessionId, 1)) as SessionLogRecord[];
}

async function storedKinds(logs: SessionLogRecord[]): Promise<Record<string, string>> {
  const rows = await getDbClient().query<{ id: string; reasoningKind: string }>(
    "SELECT id, reasoningKind FROM session_logs WHERE sessionId = ? AND reasoningKind IS NOT NULL",
    [logs[0]?.sessionId],
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.reasoningKind]));
}

function uiKinds(logs: SessionLogRecord[]): Record<string, string> {
  const kinds: Record<string, string> = {};
  for (const item of normalizeSessionLogs(logs).items) {
    if (item.kind === "reasoning") kinds[item.recId] = "reasoning";
    else if (item.kind === "text" && item.progress) kinds[item.recId] = "update";
  }
  return kinds;
}

async function expectParity(posts: string[][], expectedUpdates: number) {
  const logs = await store(posts);
  const stored = await storedKinds(logs);
  expect(uiKinds(logs)).toEqual(stored);
  expect(Object.values(stored).filter((k) => k === "update")).toHaveLength(expectedUpdates);
  return { logs, stored };
}

describe("Claude update tagging: UI parser matches stored reasoningKind", () => {
  test("thinking, thinking, tool_use: the last thinking is an update", async () => {
    await expectParity([[think("plan"), think("Reading config."), toolUse()]], 1);
  });

  test("three thinking lines: only the last is an update", async () => {
    await expectParity([[think("a"), think("b"), think("Reading."), toolUse()]], 1);
  });

  test("a run split over two POSTs still yields the update", async () => {
    await expectParity([[think("plan"), think("Reading config.")], [toolUse()]], 1);
  });

  const interruptions: Array<[string, string]> = [
    ["an unrelated tool_progress line", toolProgress],
    ["a thinking line of another message", think("other call", "msg_2")],
    ["a text line of the same message", text("Done.")],
    ["a system lifecycle line", systemInit],
    ["an unparsable line", "stderr: not json"],
  ];
  for (const [name, line] of interruptions) {
    test(`${name} between the thinking run and the tool_use ends the run`, async () => {
      await expectParity([[think("plan"), think("Reading config."), line, toolUse()]], 0);
    });
  }

  test("a tool_use of another message does not tag this message's thinking", async () => {
    await expectParity([[think("plan"), think("Reading config."), toolUse("msg_2")]], 0);
  });

  test("a missing lineNumber in the UI input ends the run, as the stored row does", async () => {
    const { logs, stored } = await expectParity(
      [[think("plan"), think("Reading config."), toolProgress, toolUse()]],
      0,
    );
    // The reader dropped the tool_progress row: the gap still separates the run.
    const withGap = logs.filter((row) => row.lineNumber !== 2);
    expect(withGap).toHaveLength(3);
    expect(uiKinds(withGap)).toEqual(stored);
  });
});
