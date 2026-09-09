import { describe, expect, test } from "bun:test";
import ts from "typescript";

type InventoryKind = "producer" | "consumer" | "reader" | "schema";

type InventoryEntry = {
  file: string;
  owner: string;
  syntax: string;
  count: number;
  kind: InventoryKind;
  dispatchProof?: { file: string; text: string };
};

/**
 * Review inventory for the complete production routingAffinity surface.
 *
 * This deliberately includes schema, read, and consumer sites as negative
 * controls: a new property occurrence cannot silently be mistaken for a new
 * producer. A real producer must also name the runtime regression that proves
 * its output reaches the intended assignee.
 */
const EXPECTED_INVENTORY: InventoryEntry[] = [
  {
    file: "src/be/db.ts",
    owner: "createTaskExtended",
    syntax: "Assignment",
    count: 2,
    kind: "producer",
    dispatchProof: {
      file: "src/tests/pool-affinity.test.ts",
      text: "a child cannot downgrade a lead-only parent's affinity or capabilities",
    },
  },
  {
    file: "src/be/db.ts",
    owner: "createTaskExtended",
    syntax: "PropertyAssignment",
    count: 1,
    kind: "consumer",
  },
  {
    file: "src/be/db.ts",
    owner: "rowToAgentTask",
    syntax: "ShorthandPropertyAssignment",
    count: 1,
    kind: "reader",
  },
  {
    file: "src/heartbeat/heartbeat.ts",
    owner: "runRebootSweep",
    syntax: "ShorthandPropertyAssignment",
    count: 1,
    kind: "producer",
    dispatchProof: {
      file: "src/tests/heartbeat.test.ts",
      text: "falls back to an affinity-stamped pool retry when the agent is at capacity",
    },
  },
  {
    file: "src/tasks/worker-follow-up.ts",
    owner: "createPoolStarvationDecisionTask",
    syntax: "PropertyAssignment",
    count: 1,
    kind: "producer",
    dispatchProof: {
      file: "src/tests/pool-affinity.test.ts",
      text: "escalation to Lead does not throw",
    },
  },
  {
    file: "src/tasks/worker-follow-up.ts",
    owner: "createRerouteDecisionTask",
    syntax: "PropertyAssignment",
    count: 1,
    kind: "producer",
    dispatchProof: {
      file: "src/tests/heartbeat-reroute-decision.test.ts",
      text: "uses its own Lead authorization instead of the original work requirements",
    },
  },
  {
    file: "src/tasks/worker-follow-up.ts",
    owner: "createResumeFollowUp",
    syntax: "ShorthandPropertyAssignment",
    count: 1,
    kind: "producer",
    dispatchProof: {
      file: "src/tests/heartbeat.test.ts",
      text: "privileged crash recovery preserves parent capabilities on an unassigned child",
    },
  },
  {
    file: "src/tools/get-task-details.ts",
    owner: "<module>",
    syntax: "PropertyAssignment",
    count: 1,
    kind: "schema",
  },
  {
    file: "src/tools/send-task.ts",
    owner: "sendTaskHandler",
    syntax: "PropertyAssignment",
    count: 3,
    kind: "producer",
    dispatchProof: {
      file: "src/tests/task-tools-ctx.test.ts",
      text: "send-task records capability-only pool requirements for Lead escalation",
    },
  },
  {
    file: "src/tools/task-action.ts",
    owner: "taskActionHandler",
    syntax: "PropertyAssignment",
    count: 1,
    kind: "producer",
    dispatchProof: {
      file: "src/tests/task-tools-ownership.test.ts",
      text: "task-action records capability-only pool requirements for Lead escalation",
    },
  },
  {
    file: "src/types.ts",
    owner: "<module>",
    syntax: "PropertyAssignment",
    count: 2,
    kind: "schema",
  },
];

function enclosingOwner(node: ts.Node, sourceFile: ts.SourceFile): string {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) && parent.name) return parent.name.text;
    if (ts.isMethodDeclaration(parent) && parent.name) return parent.name.getText(sourceFile);
    if (
      (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
      ts.isVariableDeclaration(parent.parent) &&
      ts.isIdentifier(parent.parent.name)
    ) {
      return parent.parent.name.text;
    }
  }
  return "<module>";
}

async function currentInventory(): Promise<Array<Omit<InventoryEntry, "kind" | "dispatchProof">>> {
  const counts = new Map<string, Omit<InventoryEntry, "kind" | "dispatchProof">>();
  const glob = new Bun.Glob("src/**/*.ts");

  for await (const file of glob.scan({ cwd: ".", onlyFiles: true })) {
    if (file.includes("/tests/") || file.endsWith(".test.ts")) continue;
    const sourceFile = ts.createSourceFile(
      file,
      await Bun.file(file).text(),
      ts.ScriptTarget.Latest,
      true,
    );

    const record = (node: ts.Node, syntax: string) => {
      const owner = enclosingOwner(node, sourceFile);
      const key = `${file}\0${owner}\0${syntax}`;
      const current = counts.get(key);
      counts.set(key, { file, owner, syntax, count: (current?.count ?? 0) + 1 });
    };

    const visit = (node: ts.Node) => {
      if (
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        node.name.getText(sourceFile) === "routingAffinity"
      ) {
        record(node, ts.SyntaxKind[node.kind]);
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        node.left.getText(sourceFile).endsWith(".routingAffinity")
      ) {
        record(node, "Assignment");
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return [...counts.values()].sort((a, b) =>
    `${a.file}:${a.owner}:${a.syntax}`.localeCompare(`${b.file}:${b.owner}:${b.syntax}`),
  );
}

describe("routingAffinity production inventory", () => {
  test("every production occurrence is classified", async () => {
    const expected = EXPECTED_INVENTORY.map(
      ({ kind: _kind, dispatchProof: _proof, ...entry }) => entry,
    ).sort((a, b) =>
      `${a.file}:${a.owner}:${a.syntax}`.localeCompare(`${b.file}:${b.owner}:${b.syntax}`),
    );
    expect(await currentInventory()).toEqual(expected);
  });

  test("every producer names an executable dispatch proof", async () => {
    for (const entry of EXPECTED_INVENTORY.filter((item) => item.kind === "producer")) {
      expect(
        entry.dispatchProof,
        `${entry.file}:${entry.owner} has no dispatch proof`,
      ).toBeDefined();
      const proof = entry.dispatchProof!;
      expect(
        await Bun.file(proof.file).text(),
        `${entry.file}:${entry.owner} points to a missing dispatch proof`,
      ).toContain(proof.text);
    }
  });
});
