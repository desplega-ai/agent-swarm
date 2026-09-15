import { describe, expect, test } from "bun:test";
import ts from "typescript";

const TASK_CREATORS = new Set([
  "createTaskExtended",
  "createTaskWithSiblingAwareness",
  "createSlackTaskWithFiles",
]);

type Violation = { file: string; line: number; creator: string };

async function creatorsWithoutRoutingMetadata(): Promise<Violation[]> {
  const violations: Violation[] = [];
  const glob = new Bun.Glob("src/**/*.ts");

  for await (const file of glob.scan({ cwd: ".", onlyFiles: true })) {
    if (file.includes("/tests/") || file.endsWith(".test.ts")) continue;
    const source = await Bun.file(file).text();
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const creator = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : "";
        const options = node.arguments[1];
        if (TASK_CREATORS.has(creator) && options && ts.isObjectLiteralExpression(options)) {
          const propertyNames = new Set(
            options.properties.flatMap((property) =>
              (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
              ts.isIdentifier(property.name)
                ? [property.name.text]
                : [],
            ),
          );
          if (
            ((propertyNames.has("agentId") || propertyNames.has("offeredTo")) &&
              !propertyNames.has("routingReason")) ||
            (propertyNames.has("routingReason") && !propertyNames.has("routingSource"))
          ) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            violations.push({ file, line: line + 1, creator });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return violations;
}

describe("routing reason production inventory", () => {
  test("every assigned/offer creator records its reason and provenance at the call site", async () => {
    expect(await creatorsWithoutRoutingMetadata()).toEqual([]);
  });
});
