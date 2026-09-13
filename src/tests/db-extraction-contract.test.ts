import { expect, test } from "bun:test";
import * as db from "../be/db";
import * as agents from "../be/db/agents";
import * as context from "../be/db/context-versions";
import * as taskRead from "../be/db/tasks/read";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

test("facade exposes repository bindings without internal exports", () => {
  for (const [name, value] of Object.entries({ ...agents, ...context, ...taskRead })) {
    if (
      [
        "rowToAgent",
        "configureAgentDependencies",
        "rowToAgentTask",
        "rowToAgentTaskSummary",
        "configureTaskReadDependencies",
      ].includes(name)
    ) {
      expect(name in db).toBe(false);
    } else {
      expect((db as Record<string, unknown>)[name]).toBe(value);
    }
  }
});

test(
  "fresh facade initialization does not access the database",
  async () => {
    const runtimePath = JSON.stringify(new URL("../be/db/runtime.ts", import.meta.url).pathname);
    const facadePath = JSON.stringify(new URL("../be/db.ts", import.meta.url).pathname);
    expectChildOk(
      await runChild([process.execPath, "-"], {
        stdin: `
      import { spyOn } from "bun:test";
      const runtime = await import(${runtimePath});
      const access = spyOn(runtime, "getDbClient");
      await import(${facadePath});
      if (access.mock.calls.length) throw new Error("Facade initialization accessed DB client");
    `,
      }),
      "facade initialization",
    );
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);
