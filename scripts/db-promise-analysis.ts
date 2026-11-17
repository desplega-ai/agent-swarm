// Transaction promise ownership for the supported subset in runbooks/async-db-promises.md.
import ts from "typescript";

type Fn = ts.FunctionLikeDeclaration & { body: ts.ConciseBody };
export type DbPromiseFinding = { node: ts.Node; reason: string };

export function checkTransactionPromises(program: ts.Program): DbPromiseFinding[] {
  const checker = program.getTypeChecker();
  const functions = new Set<Fn>();
  const calls = new Map<Fn, ts.CallExpression[]>();
  const owners = new Map<ts.Node, Fn>();
  const erasedOwners = new Set<Fn>();
  const executorOwners = new Set<Fn>();
  const roots = new Set<Fn>();
  const findings: DbPromiseFinding[] = [];
  const reported = new Set<ts.Node>();
  const flag = (node: ts.Node, reason: string) => {
    if (!reported.has(node)) findings.push({ node, reason });
    reported.add(node);
  };
  const isFn = (node: ts.Node): node is Fn =>
    ts.isFunctionLike(node) && "body" in node && !!node.body;
  const unwrap = (expr: ts.Expression): ts.Expression => {
    while (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isAwaitExpression(expr) ||
      ts.isNonNullExpression(expr) ||
      ts.isTypeAssertionExpression(expr) ||
      ts.isSatisfiesExpression(expr)
    )
      expr = expr.expression;
    return expr;
  };
  const hasDbType = (expr: ts.Node) => {
    const type = checker.getTypeAtLocation(expr);
    return [type, ...(type.isUnionOrIntersection() ? type.types : [])].some((t) =>
      ["DbClient", "DbExecutor"].includes(t.getSymbol()?.name ?? ""),
    );
  };
  const bindings = new Map<ts.Symbol, Set<Fn>>();
  const configuredProperties: { symbol: ts.Symbol; implementation: ts.Expression }[] = [];
  const resolved = new Map<ts.Expression, Fn[]>();
  let stable = false;
  const resolving = new Set<ts.Expression>();
  const resolve = (expr: ts.Expression, seen = new Set<ts.Symbol>()): Fn[] => {
    const cached = stable ? resolved.get(expr) : undefined;
    if (cached) return cached;
    if (resolving.has(expr)) return [];
    resolving.add(expr);
    try {
      const result = resolveInner(expr, seen);
      if (stable) resolved.set(expr, result);
      return result;
    } finally {
      resolving.delete(expr);
    }
  };
  const resolveInner = (expr: ts.Expression, seen = new Set<ts.Symbol>()): Fn[] => {
    expr = unwrap(expr);
    if (isFn(expr)) return [expr];
    if (ts.isConditionalExpression(expr))
      return [...resolve(expr.whenTrue, new Set(seen)), ...resolve(expr.whenFalse, new Set(seen))];
    if (ts.isBinaryExpression(expr)) {
      if (
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(expr.operatorToken.kind)
      )
        return [...resolve(expr.left, new Set(seen)), ...resolve(expr.right, new Set(seen))];
      if (expr.operatorToken.kind === ts.SyntaxKind.CommaToken) return resolve(expr.right, seen);
    }
    if (ts.isCallExpression(expr)) {
      return resolve(expr.expression, seen).flatMap((fn) => {
        const returned: Fn[] = [];
        const visit = (node: ts.Node) => {
          if (ts.isReturnStatement(node) && node.expression)
            returned.push(...resolve(node.expression, new Set(seen)));
          else if (!isFn(node)) ts.forEachChild(node, visit);
        };
        if (ts.isBlock(fn.body)) ts.forEachChild(fn.body, visit);
        else returned.push(...resolve(fn.body, new Set(seen)));
        return returned;
      });
    }
    let symbol = ts.isShorthandPropertyAssignment(expr.parent)
      ? checker.getShorthandAssignmentValueSymbol(expr.parent)
      : checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expr) ? expr.name : expr);
    if (!symbol) return [];
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    if (seen.has(symbol)) return [];
    seen.add(symbol);
    return [
      ...(bindings.get(symbol) ?? []),
      ...(symbol.declarations ?? []).flatMap((decl): Fn[] => {
        if (isFn(decl)) return [decl];
        if (ts.isVariableDeclaration(decl) && decl.initializer)
          return resolve(decl.initializer, seen);
        return [];
      }),
    ];
  };
  const method = (call: ts.CallExpression) =>
    ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : "";
  const dbCall = (call: ts.CallExpression) => {
    const decl = checker.getResolvedSignature(call)?.getDeclaration();
    return (
      !!decl &&
      decl.getSourceFile().fileName.endsWith("/src/be/db-client.ts") &&
      ["query", "get", "run", "runTimed", "transaction"].includes(decl.name?.getText() ?? "")
    );
  };
  const isTransaction = (call: ts.CallExpression) =>
    dbCall(call) &&
    checker.getResolvedSignature(call)?.getDeclaration()?.name?.getText() === "transaction";
  const isHook = (call: ts.CallExpression) => {
    const decl = checker.getResolvedSignature(call)?.getDeclaration();
    return (
      decl?.getSourceFile().fileName.endsWith("/src/be/db-client.ts") &&
      ["afterCommit", "afterRollback"].includes(method(call))
    );
  };
  for (const sf of program.getSourceFiles()) {
    if (
      sf.isDeclarationFile ||
      !sf.fileName.includes("/src/") ||
      sf.fileName.includes("/src/tests/")
    )
      continue;
    const visit = (node: ts.Node, owner?: Fn) => {
      if (ts.isObjectLiteralExpression(node)) {
        const contract = checker.getContextualType(node);
        for (const property of node.properties) {
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
            continue;
          if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) continue;
          const symbol = contract?.getProperty(property.name.text);
          if (symbol)
            configuredProperties.push({
              symbol,
              implementation: ts.isPropertyAssignment(property)
                ? property.initializer
                : property.name,
            });
        }
      }
      if (isFn(node)) {
        owner = node;
        functions.add(node);
        calls.set(node, []);
      }
      if (owner) {
        owners.set(node, owner);
        if (
          ts.isIdentifier(node) &&
          checker.getTypeAtLocation(node).getSymbol()?.name === "DbExecutor"
        )
          executorOwners.add(owner);
        if (
          ts.isVariableDeclaration(node) &&
          node.initializer &&
          hasDbType(node.initializer) &&
          checker.getTypeAtLocation(node.name).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
        )
          erasedOwners.add(owner);
        if (ts.isAsExpression(node) && hasDbType(node.expression) && !hasDbType(node))
          erasedOwners.add(owner);
      }
      if (ts.isCallExpression(node)) {
        if (owner) calls.get(owner)!.push(node);
        if (isTransaction(node)) for (const fn of resolve(node.arguments[0]!)) roots.add(fn);
      }
      ts.forEachChild(node, (child) => visit(child, owner));
    };
    visit(sf);
  }
  // Resolve callback parameters from their source call sites, including local helper wrappers.
  let bound = true;
  while (bound) {
    bound = false;
    // Configured callbacks share their contextual property symbol with dependency calls.
    for (const { symbol, implementation } of configuredProperties) {
      const values = bindings.get(symbol) ?? new Set<Fn>();
      for (const fn of resolve(implementation))
        if (!values.has(fn)) {
          values.add(fn);
          bound = true;
        }
      bindings.set(symbol, values);
    }
    for (const ownCalls of calls.values())
      for (const call of ownCalls) {
        for (const target of resolve(call.expression)) {
          for (const [index, param] of target.parameters.entries()) {
            const arg = call.arguments[index];
            const symbol = checker.getSymbolAtLocation(param.name);
            if (!arg || !symbol) continue;
            const values = bindings.get(symbol) ?? new Set<Fn>();
            for (const fn of resolve(arg))
              if (!values.has(fn)) {
                values.add(fn);
                bound = true;
              }
            bindings.set(symbol, values);
          }
        }
      }
  }
  stable = true;
  for (const ownCalls of calls.values())
    for (const call of ownCalls)
      if (isTransaction(call)) {
        const callbacks = resolve(call.arguments[0]!);
        if (!callbacks.length) flag(call, "Use a source-resolved transaction callback.");
        for (const callback of callbacks) roots.add(callback);
      }
  const targets = (call: ts.CallExpression): Fn[] =>
    [
      // The DB seam owns its queue. Analyze callers and callbacks, not its implementation.
      ...(dbCall(call) ? [] : [...resolve(call.expression), ...resolve(call)]),
      ...(isHook(call) ? [] : call.arguments.flatMap((arg) => resolve(arg))),
    ].filter((fn) => functions.has(fn));
  const edges = new Map<Fn, Fn[]>();
  const bearing = new Set<Fn>();
  for (const fn of functions) {
    const ownCalls = calls.get(fn)!;
    edges.set(fn, ownCalls.flatMap(targets));
    if (executorOwners.has(fn) || erasedOwners.has(fn) || ownCalls.some(dbCall)) bearing.add(fn);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of functions)
      if (!bearing.has(fn) && edges.get(fn)!.some((target) => bearing.has(target))) {
        bearing.add(fn);
        changed = true;
      }
  }
  const active = new Set<Fn>();
  const activate = (fn: Fn) => {
    if (active.has(fn)) return;
    active.add(fn);
    for (const target of edges.get(fn) ?? []) if (bearing.has(target)) activate(target);
  };
  for (const root of roots) activate(root);
  const builtin = (call: ts.CallExpression) =>
    checker
      .getResolvedSignature(call)
      ?.getDeclaration()
      ?.getSourceFile()
      .fileName.includes("/typescript/lib/lib.") === true;
  const promiseJoin = (call: ts.CallExpression) =>
    builtin(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.expression.getText() === "Promise" &&
    ["all", "allSettled"].includes(method(call));
  const chain = (call: ts.CallExpression) =>
    builtin(call) && ["then", "catch", "finally"].includes(method(call));
  const arrayMap = (call: ts.CallExpression) => builtin(call) && method(call) === "map";

  // Stored work must have an unconditional join in the same block, before any control transfer.
  const consumed = (
    node: ts.Node,
    seen = new Set<ts.Node>(),
    collection = ts.isArrayLiteralExpression(node) || (ts.isCallExpression(node) && arrayMap(node)),
  ): boolean => {
    if (seen.has(node)) return false;
    seen = new Set(seen).add(node);
    const parent = node.parent;
    if (ts.isAwaitExpression(parent) || ts.isReturnStatement(parent)) return !collection;
    if (isFn(parent) && parent.body === node) return !collection;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent)
    )
      return consumed(parent, seen, collection);
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === node &&
      ts.isCallExpression(parent.parent) &&
      chain(parent.parent)
    )
      return consumed(parent.parent, seen, collection);
    if (
      ts.isBinaryExpression(parent) &&
      parent.right === node &&
      parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken
    )
      return consumed(parent, seen, collection);
    if (ts.isArrayLiteralExpression(parent)) return consumed(parent, seen, true);
    if (ts.isConditionalExpression(parent) && parent.condition !== node)
      return consumed(parent, seen, collection);
    if (ts.isCallExpression(parent) && promiseJoin(parent)) return consumed(parent, seen, false);
    if (ts.isCallExpression(parent) && arrayMap(parent)) return consumed(parent, seen, true);
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === node &&
      ts.isIdentifier(parent.name) &&
      ts.isVariableDeclarationList(parent.parent) &&
      parent.parent.flags & ts.NodeFlags.Const
    ) {
      const statement = parent.parent.parent;
      if (!ts.isVariableStatement(statement) || !ts.isBlock(statement.parent)) return false;
      const symbol = checker.getSymbolAtLocation(parent.name);
      const block = statement.parent;
      const remaining = block.statements.slice(block.statements.indexOf(statement) + 1);
      for (const next of remaining) {
        // Only straight-line declarations and expression statements can precede the join.
        if (
          !ts.isExpressionStatement(next) &&
          !ts.isVariableStatement(next) &&
          !ts.isReturnStatement(next)
        )
          return false;
        let joined = false;
        let escaped = false;
        const unconditional = (reference: ts.Node): boolean => {
          for (let child = reference; child !== next; child = child.parent) {
            const parent: ts.Node = child.parent;
            if (parent === next) return true;
            if (ts.isOptionalChain(parent)) return false;
            if (ts.isConditionalExpression(parent)) {
              if (child !== parent.condition) return false;
              continue;
            }
            if (ts.isBinaryExpression(parent)) {
              if (
                child === parent.left &&
                (ts.isArrayLiteralExpression(child) || ts.isObjectLiteralExpression(child))
              )
                return false;
              if (
                child === parent.right &&
                [
                  ts.SyntaxKind.AmpersandAmpersandToken,
                  ts.SyntaxKind.BarBarToken,
                  ts.SyntaxKind.QuestionQuestionToken,
                  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
                  ts.SyntaxKind.BarBarEqualsToken,
                  ts.SyntaxKind.QuestionQuestionEqualsToken,
                ].includes(parent.operatorToken.kind)
              )
                return false;
              continue;
            }
            // Only known eager forms can prove a join. Binding defaults are conditional.
            if (
              ts.isAwaitExpression(parent) ||
              ts.isParenthesizedExpression(parent) ||
              ts.isAsExpression(parent) ||
              ts.isNonNullExpression(parent) ||
              ts.isTypeAssertionExpression(parent) ||
              ts.isSatisfiesExpression(parent) ||
              ts.isCallExpression(parent) ||
              ts.isPropertyAccessExpression(parent) ||
              ts.isElementAccessExpression(parent) ||
              ts.isArrayLiteralExpression(parent) ||
              ts.isSpreadElement(parent) ||
              ts.isPrefixUnaryExpression(parent) ||
              ts.isVoidExpression(parent) ||
              ts.isTypeOfExpression(parent) ||
              ts.isVariableDeclarationList(parent) ||
              (ts.isVariableDeclaration(parent) && parent.initializer === child)
            )
              continue;
            return false;
          }
          return true;
        };
        const visit = (child: ts.Node) => {
          if (isFn(child)) return;
          if (ts.isIdentifier(child) && checker.getSymbolAtLocation(child) === symbol) {
            if (unconditional(child) && consumed(child, seen, collection)) joined = true;
            else escaped = true;
          }
          ts.forEachChild(child, visit);
        };
        visit(next);
        if (escaped) return false;
        if (joined) return true;
        if (ts.isReturnStatement(next)) return false;
      }
    }
    return false;
  };
  for (const fn of active) {
    for (const call of calls.get(fn) ?? []) {
      if (isHook(call)) {
        const visited = new Set<Fn>();
        const checkHook = (callback: Fn) => {
          if (visited.has(callback)) return;
          visited.add(callback);
          const visit = (node: ts.Node) => {
            if (
              ts.isIdentifier(node) &&
              !ts.isTypeNode(node.parent) &&
              checker.getTypeAtLocation(node).getSymbol()?.name === "DbExecutor"
            ) {
              const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
              if (
                declaration &&
                owners.get(declaration) !== owners.get(node) &&
                active.has(owners.get(declaration)!)
              )
                flag(call, "Transaction hooks must not capture bound executors.");
            }
            ts.forEachChild(node, visit);
          };
          visit(callback);
          for (const dependency of edges.get(callback) ?? [])
            if (bearing.has(dependency)) checkHook(dependency);
        };
        for (const arg of call.arguments) for (const callback of resolve(arg)) checkHook(callback);
        continue;
      }
      const dependencies = targets(call);
      const returnType = checker.getTypeAtLocation(call);
      // A synchronous factory can return a lazy callable without starting asynchronous work.
      // Its body and DB-bearing callbacks still receive the same checks.
      const lazyFactory = returnType.getCallSignatures().length > 0 && resolve(call).length > 0;
      const relevant =
        dbCall(call) ||
        (!lazyFactory && !hasDbType(call) && dependencies.some((target) => bearing.has(target)));
      const callbackWork = call.arguments.some((arg) =>
        resolve(arg).some((target) => bearing.has(target)),
      );
      if (
        callbackWork &&
        !isTransaction(call) &&
        !chain(call) &&
        !arrayMap(call) &&
        !resolve(call.expression).some((target) => functions.has(target))
      )
        flag(call, "The DB callback escapes to an unresolved function.");
      if (relevant && !consumed(call))
        flag(call, "Await, return, or join transaction work. Detached work is unsupported.");
      for (const [index, arg] of call.arguments.entries()) {
        if (hasDbType(arg))
          for (const target of resolve(call.expression)) {
            const parameter = target.parameters[index];
            if (
              parameter &&
              checker.getTypeAtLocation(parameter).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
            )
              flag(call, "Preserve the DB type in helper parameters.");
          }
        if (
          hasDbType(arg) &&
          !dbCall(call) &&
          !resolve(call.expression).some((target) => functions.has(target)) &&
          // This boot-configured dependency is auditAssetKeysAsync. Its body is checked separately.
          !(
            call.getSourceFile().fileName.endsWith("/src/be/db/session-moves.ts") &&
            call.expression.getText() === "auditAssetKeys"
          )
        )
          flag(call, "The transaction executor escapes to an unresolved function.");
      }
    }
    if (
      roots.has(fn) &&
      fn.parameters[0] &&
      checker.getTypeAtLocation(fn.parameters[0]).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
    )
      flag(fn.parameters[0], "Preserve the transaction callback's executor type.");
    const visit = (node: ts.Node) => {
      const returned = ts.isReturnStatement(node)
        ? node.expression
        : fn.body === node
          ? node
          : undefined;
      if (
        roots.has(fn) &&
        returned &&
        ts.isExpression(returned) &&
        (hasDbType(returned) || resolve(returned).some((target) => bearing.has(target)))
      )
        flag(returned, "Do not return transaction executors or DB helpers from their scope.");
      if (
        ts.isPropertyAccessExpression(node) &&
        hasDbType(node.expression) &&
        ["query", "get", "run", "runTimed", "transaction"].includes(node.name.text) &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node)
      )
        flag(node, "Call DB methods through their executor or client receiver.");
      if (ts.isParameter(node) && !ts.isIdentifier(node.name) && hasDbType(node.name))
        flag(node, "Do not destructure DB executors or clients.");
      if (
        ts.isVariableDeclaration(node) &&
        !ts.isIdentifier(node.name) &&
        node.initializer &&
        hasDbType(node.initializer)
      )
        flag(node, "Do not destructure DB executors or clients.");
      if (ts.isAsExpression(node) && hasDbType(node.expression) && !hasDbType(node))
        flag(node, "Do not erase DB executor or client types.");
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        hasDbType(node.initializer) &&
        checker.getTypeAtLocation(node.name).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
      )
        flag(node, "Do not erase DB executor or client types.");
      if (node !== fn && isFn(node)) {
        if (
          bearing.has(node) &&
          (ts.isNewExpression(node.parent) ||
            ts.isPropertyAssignment(node.parent) ||
            ts.isObjectLiteralExpression(node.parent) ||
            ts.isClassDeclaration(node.parent) ||
            ts.isClassExpression(node.parent) ||
            ts.isBinaryExpression(node.parent) ||
            (roots.has(fn) && ts.isReturnStatement(node.parent)))
        )
          flag(node, "The DB callback escapes through an unsupported source form.");
        return;
      }
      if (ts.isIdentifier(node) && resolve(node).some((target) => bearing.has(target))) {
        const parent = node.parent;
        const declaration = ("name" in parent && parent.name === node) || ts.isTypeNode(parent);
        const inspection =
          (ts.isPrefixUnaryExpression(parent) &&
            parent.operator === ts.SyntaxKind.ExclamationToken) ||
          (ts.isBinaryExpression(parent) &&
            [
              ts.SyntaxKind.AmpersandAmpersandToken,
              ts.SyntaxKind.BarBarToken,
              ts.SyntaxKind.QuestionQuestionToken,
            ].includes(parent.operatorToken.kind));
        const reference =
          inspection ||
          ts.isCallExpression(parent) ||
          ts.isVariableDeclaration(parent) ||
          ts.isReturnStatement(parent) ||
          (ts.isPropertyAccessExpression(parent) && parent.name === node);
        if ((roots.has(fn) && ts.isReturnStatement(parent)) || (!declaration && !reference))
          flag(node, "The DB helper escapes through an unsupported reference.");
      }
      // Callback escapes through properties, assignments, or opaque consumers are unsupported.
      if (
        ts.isIdentifier(node) &&
        !ts.isTypeNode(node.parent) &&
        owners.get(node) === fn &&
        hasDbType(node)
      ) {
        const parent = node.parent;
        if (ts.isParameter(parent) || ts.isVariableDeclaration(parent)) return;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return;
        if (ts.isCallExpression(parent)) return;
        flag(
          node,
          "Use transaction executors only as method receivers or resolved helper arguments.",
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(fn);
  }
  return findings;
}
