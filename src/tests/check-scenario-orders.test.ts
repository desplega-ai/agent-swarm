import { describe, expect, test } from "bun:test";
import { addedOrders, collisions } from "../../scripts/check-scenario-orders";

const fileDiff = (file: string, body: string) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,3 +1,3 @@\n${body}\n`;

describe("scenario order check", () => {
  test("reads added top-level orders per scenario file", () => {
    const diff =
      fileDiff("scripts/e2e/scenarios/a.ts", '+  name: "a",\n-  order: 10,\n+  order: 556,') +
      fileDiff("scripts/e2e/scenarios/b.ts", "+  order: 9_445,\n+    order: 3,\n   order: 7,") +
      fileDiff("scripts/e2e/scenarios/c.ts", "+  order: 643.5,");
    expect(addedOrders(diff)).toEqual([
      { file: "a.ts", order: 556 },
      { file: "b.ts", order: 9445 },
      { file: "c.ts", order: 643.5 },
    ]);
  });

  test("ignores helpers, other directories and deleted files", () => {
    const diff =
      fileDiff("scripts/e2e/scenarios/registry.ts", "+  order: 1,") +
      fileDiff("scripts/e2e/other.ts", "+  order: 2,") +
      "--- a/scripts/e2e/scenarios/gone.ts\n+++ /dev/null\n+  order: 3,\n";
    expect(addedOrders(diff)).toEqual([]);
  });

  test("the same order from another file collides, from the same file does not", () => {
    const ours = [
      { file: "knowledge-apps-template-refs.ts", order: 556 },
      { file: "x.ts", order: 12 },
    ];
    expect(
      collisions(ours, [
        { file: "knowledge-apps-app-context.ts", order: 556 },
        { file: "x.ts", order: 12 },
      ]),
    ).toEqual([
      {
        order: 556,
        ours: "knowledge-apps-template-refs.ts",
        theirs: "knowledge-apps-app-context.ts",
      },
    ]);
  });
});
