import ts from "typescript";

const SCRIPT_ALLOWED_BARE_IMPORTS = ["swarm-sdk", "stdlib", "zod"] as const;
const FORBIDDEN_HINTS = new Set(["node:", "bun:", "fs", "child_process", "crypto", "bun:sqlite"]);

export type ImportAllowlistOptions = {
  allowedBare: readonly string[];
  allowRelative: boolean;
  // Extensions need strict dynamic imports because they run in-process without a sandbox.
  strictDynamic?: boolean;
};

export type ImportAllowlistResult =
  | { ok: true }
  | { ok: false; diagnostic: string; imports: string[] };

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function isAllowed(specifier: string, options: ImportAllowlistOptions): boolean {
  return (
    (options.allowRelative && isRelative(specifier)) || options.allowedBare.includes(specifier)
  );
}

type CollectedImports = {
  imports: string[];
  unsupportedSyntax: "import()" | "require()" | "import-equals" | null;
};

function collectImportSpecifiers(source: string, strictDynamic = false): CollectedImports {
  const sourceFile = ts.createSourceFile(
    "user-script.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imports: string[] = [];
  let unsupportedSyntax: CollectedImports["unsupportedSyntax"] = null;

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier))
        imports.push(moduleSpecifier.text);
    }

    if (
      strictDynamic &&
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = node.moduleReference.expression;
      if (specifier && ts.isStringLiteralLike(specifier)) imports.push(specifier.text);
      else unsupportedSyntax ??= "import-equals";
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg && (ts.isStringLiteral(arg) || (strictDynamic && ts.isStringLiteralLike(arg))))
        imports.push(arg.text);
      else if (strictDynamic) unsupportedSyntax ??= "import()";
    }

    if (
      strictDynamic &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteralLike(arg)) imports.push(arg.text);
      else unsupportedSyntax ??= "require()";
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { imports, unsupportedSyntax };
}

function findForbiddenDynamicCode(source: string, subject: string): string | null {
  const sourceFile = ts.createSourceFile(
    "user-script.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let diagnostic: string | null = null;

  const visit = (node: ts.Node) => {
    if (diagnostic) return;

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.Identifier &&
      node.expression.getText(sourceFile) === "eval"
    ) {
      diagnostic = `eval is not allowed in ${subject}`;
      return;
    }

    if (
      ts.isNewExpression(node) &&
      node.expression.kind === ts.SyntaxKind.Identifier &&
      node.expression.getText(sourceFile) === "Function"
    ) {
      diagnostic = `Function constructor is not allowed in ${subject}`;
      return;
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.Identifier &&
      node.expression.getText(sourceFile) === "Function"
    ) {
      diagnostic = `Function constructor is not allowed in ${subject}`;
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return diagnostic;
}

export function checkImportAllowlist(
  source: string,
  options: ImportAllowlistOptions,
): ImportAllowlistResult {
  const isExtension = options.allowedBare.includes("swarm-extension");
  const subject = isExtension ? "swarm extensions" : "swarm scripts";
  const dynamicDiagnostic = findForbiddenDynamicCode(source, subject);
  if (dynamicDiagnostic) return { ok: false, diagnostic: dynamicDiagnostic, imports: [] };

  const collected = collectImportSpecifiers(source, options.strictDynamic);
  if (collected.unsupportedSyntax) {
    return {
      ok: false,
      diagnostic: `Computed ${collected.unsupportedSyntax} is not allowed in ${subject}. Use a string literal from the import allowlist.`,
      imports: collected.imports,
    };
  }
  const imports = collected.imports;
  const rejected = imports.filter((specifier) => !isAllowed(specifier, options));
  if (rejected.length === 0) return { ok: true };

  const hint = rejected.find(
    (specifier) => FORBIDDEN_HINTS.has(specifier) || specifier.startsWith("node:"),
  );
  const reason = hint
    ? `Import '${hint}' is not allowed in ${subject}`
    : `Import '${rejected[0]}' is not on the ${subject} allowlist`;
  const listed = options.allowedBare.map((specifier) => `"${specifier}"`).join(", ");
  const allowlistRemedy = options.allowRelative
    ? `Allowed imports are ${listed}, and relative paths ("./" or "../").`
    : `Allowed imports are ${listed}. Relative imports are not allowed.`;
  const remedy =
    hint === "crypto" || hint === "node:crypto"
      ? "The global crypto object already provides randomUUID, getRandomValues, and subtle.digest; delete the import and use crypto directly."
      : allowlistRemedy;
  return { ok: false, diagnostic: `${reason}. ${remedy}`, imports: rejected };
}

export function validateScriptImports(source: string): ImportAllowlistResult {
  return checkImportAllowlist(source, {
    allowedBare: SCRIPT_ALLOWED_BARE_IMPORTS,
    allowRelative: true,
  });
}
