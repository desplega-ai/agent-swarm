import ts from "typescript";
import { DURABLE_OBJECT_RESERVED_METHODS } from "./durable-object-base";

type MethodSignature = {
  argsType: string;
  resultType: string;
  description: string;
};

export type ScriptSignature = MethodSignature & {
  kind?: "durable";
  methods?: Record<string, MethodSignature>;
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

    const durableNames = new Set<string>();
    for (const statement of sourceFile.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "swarm-sdk"
      ) {
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const binding of bindings.elements) {
            if ((binding.propertyName ?? binding.name).text === "DurableObject") {
              durableNames.add(binding.name.text);
            }
          }
        }
      }
    }

    for (const statement of sourceFile.statements) {
      if (
        ts.isClassDeclaration(statement) &&
        isExportDefault(statement) &&
        statement.heritageClauses?.some(
          (clause) =>
            clause.token === ts.SyntaxKind.ExtendsKeyword &&
            clause.types.some(
              (type) => ts.isIdentifier(type.expression) && durableNames.has(type.expression.text),
            ),
        )
      ) {
        const methods: Record<string, MethodSignature> = Object.create(null);
        for (const member of statement.members) {
          if (
            !ts.isMethodDeclaration(member) ||
            member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ||
            !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
          ) {
            continue;
          }
          const name = member.name.text;
          if (name.startsWith("_") || DURABLE_OBJECT_RESERVED_METHODS.has(name)) continue;
          methods[name] = fromFunctionLike(member, sourceFile);
        }
        return {
          kind: "durable",
          methods,
          argsType: "unknown",
          resultType: "unknown",
          description: getJsDocDescription(statement, sourceFile),
        };
      }
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
