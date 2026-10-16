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
  | "hostCredential"
  | "privateHost";

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

const SCRIPT_FILE = "user-script.ts";

/** The initializer of the `const` binding a name reads; null for anything else. */
type ConstInitializer = (node: ts.Identifier) => ts.Expression | null;
// Follows at most this many consts, as in `const API = "..."; const url = `${API}/x``.
const MAX_CONST_DEPTH = 4;

/** True inside a `declare` statement, namespace or global block. */
function isAmbient(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (
      ts.canHaveModifiers(current) &&
      ts.getModifiers(current)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Parses and binds the script with the TypeScript checker (no lib, no imports),
 * so a name resolves by lexical scope: a `Buffer` parameter in one function does
 * not hide a global `Buffer` read in another. A name declared only with
 * `declare` (ambient) still counts as a global, because nothing defines it at run time.
 */
function createScope(source: string): {
  sourceFile: ts.SourceFile;
  isLocal: (node: ts.Identifier) => boolean;
  constInitializer: ConstInitializer;
} {
  const sourceFile = ts.createSourceFile(SCRIPT_FILE, source, ts.ScriptTarget.Latest, true);
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === SCRIPT_FILE ? sourceFile : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === SCRIPT_FILE,
    readFile: () => undefined,
  };
  const program = ts.createProgram({
    rootNames: [SCRIPT_FILE],
    options: { noLib: true, noResolve: true, types: [], target: ts.ScriptTarget.Latest },
    host,
  });
  const checker = program.getTypeChecker();
  const isLocal = (node: ts.Identifier) => {
    const symbol =
      ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
    return Boolean(
      symbol?.declarations?.some(
        (declaration) => declaration.getSourceFile() === sourceFile && !isAmbient(declaration),
      ),
    );
  };
  const constInitializer: ConstInitializer = (node) => {
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
      return null;
    }
    return ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const
      ? declaration.initializer
      : null;
  };
  return { sourceFile, isLocal, constInitializer };
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
function globalName(node: ts.Expression, isLocal: (node: ts.Identifier) => boolean): string | null {
  const inner = unwrap(node);
  if (ts.isIdentifier(inner)) return isLocal(inner) ? null : inner.text;
  if (ts.isPropertyAccessExpression(inner) && isGlobalThis(inner.expression)) {
    return inner.name.text;
  }
  return null;
}

function isPrivateIPv4([a = 0, b = 0, c = 0]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

// `text` is a WHATWG-serialized IPv6 address without brackets: hex groups, at most one "::".
function isPrivateIPv6(text: string): boolean {
  const [head = "", tail = ""] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = text.includes("::") && tail ? tail.split(":") : [];
  const fill = text.includes("::") ? 8 - left.length - right.length : 0;
  const g = [...left, ...Array<string>(fill).fill("0"), ...right].map((part) => parseInt(part, 16));
  const g0 = g[0] ?? 0;
  if (g.slice(0, 6).every((part) => part === 0)) return true; // ::/96: ::, ::1
  if (g.slice(0, 5).every((part) => part === 0) && g[5] === 0xffff) {
    const [g6 = 0, g7 = 0] = g.slice(6);
    return isPrivateIPv4([g6 >> 8, g6 & 255, g7 >> 8]); // IPv4-mapped
  }
  return (
    (g0 & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (g0 & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (g0 & 0xffc0) === 0xfec0 || // fec0::/10 site-local
    (g0 & 0xff00) === 0xff00 // ff00::/8 multicast
  );
}

/**
 * How the default egress policy sees a parsed URL hostname, statically:
 * "private" for loopback names and private, link-local or reserved IP literals,
 * "single-label" for a name with no dot (usually an internal service name that
 * resolves to a private address). Null for anything else, including public names
 * that resolve privately: only the runtime check sees DNS.
 */
function staticHostClass(hostname: string): "private" | "single-label" | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return "private";
  if (host.startsWith("[")) return isPrivateIPv6(host.slice(1, -1)) ? "private" : null;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) return isPrivateIPv4(v4.slice(1).map(Number)) ? "private" : null;
  return host !== "" && !host.includes(".") ? "single-label" : null;
}

/** The fetch-like call this callee names: fetch, globalThis.fetch, ctx.stdlib.fetch or fetchJson. */
function fetchCallName(callee: ts.Expression): string | null {
  const inner = unwrap(callee);
  if (ts.isIdentifier(inner)) {
    return inner.text === "fetch" || inner.text === "fetchJson" ? inner.text : null;
  }
  if (!ts.isPropertyAccessExpression(inner)) return null;
  const method = inner.name.text;
  if (method !== "fetch" && method !== "fetchJson") return null;
  const owner = unwrap(inner.expression);
  if (method === "fetch" && isGlobalThis(owner)) return "fetch";
  const ownerName = ts.isIdentifier(owner)
    ? owner.text
    : ts.isPropertyAccessExpression(owner)
      ? owner.name.text
      : null;
  return ownerName === "stdlib" ? `ctx.stdlib.${method}` : null;
}

/**
 * The fixed start of a URL argument: a literal, a const holding one, or a
 * template or `+` concatenation that starts with them, through up to
 * MAX_CONST_DEPTH consts. `cut` is true when the
 * text stops at a dynamic part that could still extend the host, as in
 * `http://intra${suffix}`; a dynamic part right after a const value cannot.
 */
function staticPrefix(
  node: ts.Expression,
  resolve: ConstInitializer,
  depth = 0,
): { text: string; cut: boolean } | null {
  const inner = unwrap(node);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
    return { text: inner.text, cut: false };
  }
  if (ts.isIdentifier(inner)) {
    const initializer = depth < MAX_CONST_DEPTH ? resolve(inner) : null;
    return initializer ? staticPrefix(initializer, resolve, depth + 1) : null;
  }
  if (ts.isTemplateExpression(inner)) {
    let text = inner.head.text;
    let boundary = false;
    for (const span of inner.templateSpans) {
      const part = staticPrefix(span.expression, resolve, depth);
      if (part === null) return { text, cut: !boundary || text === "" };
      if (part.cut) return { text: text + part.text, cut: true };
      text += part.text + span.literal.text;
      boundary = span.literal.text === "";
    }
    return { text, cut: false };
  }
  if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticPrefix(inner.left, resolve, depth);
    if (left === null || left.cut) return left;
    const right = staticPrefix(inner.right, resolve, depth);
    if (right === null) return { text: left.text, cut: !ts.isIdentifier(unwrap(inner.left)) };
    return { text: left.text + right.text, cut: right.cut };
  }
  return null;
}

/** The URL argument's host when the source fixes it, parsed with the host URL parser. */
function literalUrl(arg: ts.Expression | undefined, resolve: ConstInitializer): URL | null {
  if (!arg) return null;
  const prefix = staticPrefix(arg, resolve);
  if (!prefix) return null;
  // A cut prefix fixes the host only once the authority has ended.
  if (prefix.cut && !/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*[/?#]/i.test(prefix.text)) return null;
  try {
    return new URL(prefix.text);
  } catch {
    return null;
  }
}

export function checkQuickJSCompat(
  source: string,
  options: { fsMode?: string } = {},
): QuickJSCompatReport {
  const findings: QuickJSCompatFinding[] = [];
  const seen = new Set<string>();
  const { sourceFile, isLocal, constInitializer } = createScope(source);
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

    if (
      ts.isIdentifier(node) &&
      (node.text === "Bun" || node.text === "process" || UNSUPPORTED_GLOBALS.has(node.text)) &&
      isValueReference(node) &&
      !isLocal(node)
    ) {
      reportGlobal(node.text, node);
    }

    if (ts.isPropertyAccessExpression(node)) {
      const member = node.name.text;
      const owner = globalName(node.expression, isLocal);
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
      const fetchName = fetchCallName(callee);
      const url = fetchName ? literalUrl(node.arguments[0], constInitializer) : null;
      const hostClass =
        url && (url.protocol === "http:" || url.protocol === "https:")
          ? staticHostClass(url.hostname)
          : null;
      if (url && hostClass) {
        add(
          "privateHost",
          `${fetchName} to ${url.host} (${hostClass} host) depends on the egress policy: quickjs refuses private hosts unless the operator allows them`,
          node,
        );
      }
      if (ts.isIdentifier(callee) && callee.text === "require" && !isLocal(callee)) {
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
