import ts from "typescript";

/**
 * Flags script source that would fail, or silently differ, under the quickjs
 * executor. It is advisory: callers attach the findings as warnings and never
 * reject on them.
 */
export type QuickJSCompatRule =
  | "bunGlobal"
  | "process"
  | "fsStdlib"
  | "require"
  | "workspaceRw"
  | "unsupportedGlobal"
  | "cryptoSubtle"
  | "responseBody"
  | "localeFormat"
  | "hostCredential";

export type QuickJSCompatFinding = {
  rule: QuickJSCompatRule;
  message: string;
  /** 1-based line in the script source, when the finding has one. */
  line?: number;
};

export type QuickJSCompatReport = {
  compatible: boolean;
  findings: QuickJSCompatFinding[];
};

// Globals that Bun provides and the quickjs sandbox does not (measured against
// the QuickJS build plus quickjs-prelude.ts and quickjs-web-shims.ts).
const UNSUPPORTED_GLOBALS = new Set([
  "AbortController",
  "AbortSignal",
  "Blob",
  "Buffer",
  "Event",
  "EventTarget",
  "File",
  "FormData",
  "Intl",
  "ReadableStream",
  "Request",
  "TransformStream",
  "WebSocket",
  "WritableStream",
  "atob",
  "btoa",
  "clearImmediate",
  "navigator",
  "performance",
  "queueMicrotask",
  "setImmediate",
  "structuredClone",
]);
const RESPONSE_BODY_METHODS = new Set(["arrayBuffer", "blob", "formData", "bytes"]);
const LOCALE_METHODS = new Set(["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]);
const FS_STDLIB = new Set(["glob", "grep"]);
// ctx.swarm.config values that quickjs keeps host-side (see quickjs-runner.ts).
const HOST_ONLY_CONFIG = new Set(["apiKey", "runtimeInstanceId"]);
const MAX_FINDINGS = 20;

function collectDeclaredNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const addBinding = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) {
      names.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) addBinding(element.name);
    }
  };
  const visit = (node: ts.Node) => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
      node.name
    ) {
      addBinding(node.name);
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassExpression(node) ||
        ts.isImportSpecifier(node) ||
        ts.isNamespaceImport(node) ||
        ts.isImportClause(node)) &&
      node.name
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

/** True when `node` is read as a value, not as a property name or declaration. */
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if ("name" in parent && (parent as { name?: ts.Node }).name === node) return false;
  if (ts.isTypeOfExpression(parent)) return false;
  return true;
}

function isTypeOnly(node: ts.Node): boolean {
  return (
    ts.isTypeNode(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    (ts.isImportDeclaration(node) && Boolean(node.importClause?.isTypeOnly))
  );
}

function stdlibImportNames(node: ts.ImportDeclaration): string[] {
  if (!ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== "stdlib")
    return [];
  const bindings = node.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return [];
  return bindings.elements
    .map((element) => (element.propertyName ?? element.name).text)
    .filter((name) => FS_STDLIB.has(name));
}

/** Strips parentheses, `as`, `!` and `satisfies`: `(globalThis as any)` is `globalThis`. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isGlobalThis(node: ts.Expression): boolean {
  const inner = unwrap(node);
  return ts.isIdentifier(inner) && inner.text === "globalThis";
}

/** `globalThis.X` or `X` (free), as the global's name; otherwise null. */
function globalName(node: ts.Expression, declared: Set<string>): string | null {
  const inner = unwrap(node);
  if (ts.isIdentifier(inner)) return declared.has(inner.text) ? null : inner.text;
  if (ts.isPropertyAccessExpression(inner) && isGlobalThis(inner.expression)) {
    return inner.name.text;
  }
  return null;
}

export function checkQuickJSCompat(
  source: string,
  options: { fsMode?: string } = {},
): QuickJSCompatReport {
  const findings: QuickJSCompatFinding[] = [];
  const seen = new Set<string>();
  const sourceFile = ts.createSourceFile("user-script.ts", source, ts.ScriptTarget.Latest, true);
  const declared = collectDeclaredNames(sourceFile);
  const add = (rule: QuickJSCompatRule, message: string, node?: ts.Node) => {
    if (seen.has(`${rule}:${message}`)) return;
    seen.add(`${rule}:${message}`);
    const line = node
      ? sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      : undefined;
    findings.push(line === undefined ? { rule, message } : { rule, message, line });
  };

  if (options.fsMode === "workspace-rw") {
    add("workspaceRw", "fsMode workspace-rw is not available under quickjs");
  }

  const reportGlobal = (name: string, node: ts.Node) => {
    if (name === "Bun") add("bunGlobal", "Bun.* is not available under quickjs", node);
    else if (name === "process") add("process", "process is not available under quickjs", node);
    else if (UNSUPPORTED_GLOBALS.has(name)) {
      add("unsupportedGlobal", `${name} is not available under quickjs`, node);
    }
  };

  const visit = (node: ts.Node) => {
    if (isTypeOnly(node)) return;

    if (ts.isIdentifier(node) && !declared.has(node.text) && isValueReference(node)) {
      reportGlobal(node.text, node);
    }

    if (ts.isPropertyAccessExpression(node)) {
      const member = node.name.text;
      const owner = globalName(node.expression, declared);
      if (isGlobalThis(node.expression) && !ts.isTypeOfExpression(node.parent)) {
        reportGlobal(member, node);
      }
      const parent = unwrap(node.expression);
      if (
        HOST_ONLY_CONFIG.has(member) &&
        ts.isPropertyAccessExpression(parent) &&
        parent.name.text === "config"
      ) {
        add(
          "hostCredential",
          `ctx.swarm.config.${member} is host-only under quickjs; ctx.swarm calls use it for you`,
          node,
        );
      }
      if (member === "subtle" && owner === "crypto") {
        add("cryptoSubtle", "crypto.subtle is not available under quickjs", node);
      }
      if (
        FS_STDLIB.has(member) &&
        ts.isPropertyAccessExpression(unwrap(node.expression)) &&
        (unwrap(node.expression) as ts.PropertyAccessExpression).name.text === "stdlib"
      ) {
        add("fsStdlib", `ctx.stdlib.${member} needs filesystem access, which quickjs lacks`, node);
      }
    }

    if (ts.isImportDeclaration(node)) {
      for (const name of stdlibImportNames(node)) {
        add("fsStdlib", `stdlib ${name} needs filesystem access, which quickjs lacks`, node);
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isPropertyAccessExpression(node.initializer) &&
      node.initializer.name.text === "stdlib"
    ) {
      for (const element of node.name.elements) {
        const name = (element.propertyName ?? element.name).getText(sourceFile);
        if (FS_STDLIB.has(name)) {
          add("fsStdlib", `ctx.stdlib.${name} needs filesystem access, which quickjs lacks`, node);
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "require" && !declared.has("require")) {
        add("require", "require() is not supported; use an import", node);
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if (RESPONSE_BODY_METHODS.has(method) && node.arguments.length === 0) {
          add(
            "responseBody",
            `.${method}() on a fetch Response is not available under quickjs (text() and json() are)`,
            node,
          );
        }
        if (LOCALE_METHODS.has(method) && node.arguments.length > 0) {
          add(
            "localeFormat",
            `${method}(locale, options) ignores its arguments under quickjs (no Intl)`,
            node,
          );
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { compatible: findings.length === 0, findings: findings.slice(0, MAX_FINDINGS) };
}

/** One human-readable line per finding, for `warnings` arrays. */
export function quickJSCompatWarnings(report: QuickJSCompatReport, label?: string): string[] {
  const prefix = label ? `${label}: ` : "";
  return report.findings.map(
    (finding) =>
      `${prefix}quickjs compat (${finding.rule}${finding.line ? `, line ${finding.line}` : ""}): ${finding.message}`,
  );
}
