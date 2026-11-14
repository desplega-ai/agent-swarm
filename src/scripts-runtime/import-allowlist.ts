import ts from "typescript";

const SCRIPT_ALLOWED_BARE_IMPORTS = ["swarm-sdk", "stdlib", "zod", "zod/mini"] as const;
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

function parseScriptSource(source: string): ts.SourceFile {
  return ts.createSourceFile(
    "user-script.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function collectImportSpecifiers(
  sourceFile: ts.SourceFile,
  strictDynamic = false,
): CollectedImports {
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

function findForbiddenDynamicCode(sourceFile: ts.SourceFile, subject: string): string | null {
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
  // One parse serves both walks: building the AST is most of the check's cost.
  const sourceFile = parseScriptSource(source);
  const dynamicDiagnostic = findForbiddenDynamicCode(sourceFile, subject);
  if (dynamicDiagnostic) return { ok: false, diagnostic: dynamicDiagnostic, imports: [] };

  const collected = collectImportSpecifiers(sourceFile, options.strictDynamic);
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

/**
 * Script-import verdicts by source sha256. The verdict is a pure function of
 * the source text (the options below are fixed), so an entry can never go
 * stale: an edited script has a new hash. Every script run checks its source,
 * and parsing a 10-40 KB script with the TypeScript compiler costs 5-20 ms of
 * a ~120 ms run, while saved scripts run the same source over and over.
 * sha256, not a fast non-cryptographic hash: this check gates the sandbox, so
 * a crafted source must not be able to collide with an approved one.
 */
const SCRIPT_IMPORT_VERDICT_CACHE_MAX = 512;
const scriptImportVerdicts = new Map<string, ImportAllowlistResult>();

function copyVerdict(result: ImportAllowlistResult): ImportAllowlistResult {
  return result.ok ? { ok: true } : { ...result, imports: [...result.imports] };
}

export function validateScriptImports(source: string): ImportAllowlistResult {
  const key = new Bun.CryptoHasher("sha256").update(source).digest("hex");
  const cached = scriptImportVerdicts.get(key);
  if (cached) {
    // Refresh recency: Map iteration order is insertion order, so the first
    // key is always the least recently used one.
    scriptImportVerdicts.delete(key);
    scriptImportVerdicts.set(key, cached);
    return copyVerdict(cached);
  }
  const result = checkImportAllowlist(source, {
    allowedBare: SCRIPT_ALLOWED_BARE_IMPORTS,
    allowRelative: true,
  });
  scriptImportVerdicts.set(key, copyVerdict(result));
  if (scriptImportVerdicts.size > SCRIPT_IMPORT_VERDICT_CACHE_MAX) {
    const oldest = scriptImportVerdicts.keys().next().value;
    if (oldest !== undefined) scriptImportVerdicts.delete(oldest);
  }
  return result;
}
