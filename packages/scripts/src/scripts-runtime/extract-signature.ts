import ts from "typescript";

export type ScriptSignature = {
  argsType: string;
  resultType: string;
  description: string;
};

const FALLBACK_SIGNATURE: ScriptSignature = {
  argsType: "unknown",
  resultType: "unknown",
  description: "",
};

function getJsDocDescription(node: ts.Node, sourceFile: ts.SourceFile): string {
  const comments = ts.getJSDocCommentsAndTags(node);
  const comment = comments.find(ts.isJSDoc);
  if (!comment?.comment) return "";
  if (typeof comment.comment === "string") return comment.comment;
  return comment.comment.map((part) => part.getText(sourceFile)).join("");
}

function unwrapPromise(typeText: string): string {
  const trimmed = typeText.trim();
  if (trimmed.startsWith("Promise<") && trimmed.endsWith(">")) {
    return trimmed.slice("Promise<".length, -1).trim();
  }
  return trimmed;
}

function fromFunctionLike(
  node: ts.FunctionLikeDeclarationBase,
  sourceFile: ts.SourceFile,
): ScriptSignature {
  const [firstParam] = node.parameters;
  return {
    argsType: firstParam?.type?.getText(sourceFile) ?? "unknown",
    resultType: unwrapPromise(node.type?.getText(sourceFile) ?? "unknown"),
    description: getJsDocDescription(node, sourceFile),
  };
}

function isExportDefault(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  );
}

export function extractScriptSignature(source: string): ScriptSignature {
  try {
    const sourceFile = ts.createSourceFile(
      "user-script.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const parseDiagnostics = (
      sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
    ).parseDiagnostics;
    if (parseDiagnostics && parseDiagnostics.length > 0) return FALLBACK_SIGNATURE;

    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && isExportDefault(statement)) {
        return fromFunctionLike(statement, sourceFile);
      }

      if (ts.isExportAssignment(statement)) {
        const expression = statement.expression;
        if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
          return fromFunctionLike(expression, sourceFile);
        }
      }
    }
  } catch {
    return FALLBACK_SIGNATURE;
  }

  return FALLBACK_SIGNATURE;
}
