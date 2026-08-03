import ts from "typescript";

export type LabelLintError = {
  label: string;
  lineNumber: number | null;
  detail: string;
};

export type LabelLintResult = { ok: true } | { ok: false; errors: LabelLintError[] };

const ITERATION_CALLBACK_METHODS = new Set([
  "map",
  "forEach",
  "reduce",
  "flatMap",
  "filter",
  "some",
  "every",
]);

function isCtxStepCall(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;

  const stepAccess = node.expression.expression;
  return (
    ts.isPropertyAccessExpression(stepAccess) &&
    ts.isIdentifier(stepAccess.expression) &&
    stepAccess.expression.text === "ctx" &&
    stepAccess.name.text === "step"
  );
}

function staticLabel(node: ts.Expression | undefined): { label: string; node: ts.Node } | null {
  if (!node || (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node))) {
    return null;
  }

  return { label: node.text, node };
}

function isIterationStatement(node: ts.Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

function isIterationCallback(node: ts.Node): boolean {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;

  let callback: ts.Expression = node;
  while (
    ts.isParenthesizedExpression(callback.parent) ||
    ts.isAsExpression(callback.parent) ||
    ts.isTypeAssertionExpression(callback.parent) ||
    ts.isSatisfiesExpression(callback.parent) ||
    ts.isNonNullExpression(callback.parent)
  ) {
    callback = callback.parent;
  }

  const call = callback.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== callback) return false;
  if (!ts.isPropertyAccessExpression(call.expression)) return false;

  return ITERATION_CALLBACK_METHODS.has(call.expression.name.text);
}

function isInsideIteration(node: ts.Node): boolean {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (isIterationStatement(ancestor) || isIterationCallback(ancestor)) return true;
  }

  return false;
}

export function lintWorkflowLabels(source: string): LabelLintResult {
  const errors: LabelLintError[] = [];
  const sourceFile = ts.createSourceFile(
    "workflow.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isCtxStepCall(node)) {
      const label = staticLabel(node.arguments[0]);
      if (label && isInsideIteration(node)) {
        const lineNumber =
          sourceFile.getLineAndCharacterOfPosition(label.node.getStart(sourceFile)).line + 1;

        errors.push({
          label: label.label,
          lineNumber,
          detail:
            `Static label "${label.label}" at line ${lineNumber} appears inside a loop. ` +
            "Labels must be unique per run; use a template literal with an actual interpolation that includes the loop variable.",
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
