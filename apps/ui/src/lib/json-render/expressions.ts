/**
 * Expression bindings: `{ "$add": [a, b] }`, `{ "$join": [list, ""] }`, ...
 *
 * Every operator takes an array of operands. An operand is a literal or any
 * binding (`$state`, `$item`, `$index`, `$chain`, another expression). The
 * renderer resolves them as json-render directives (`expressionDirectives`,
 * passed to `JSONUIProvider`); chain runners resolve them again in
 * `resolveScopedValue`, because a `$chain` / `$row` / `$form` operand only has
 * a value when the chain runs. An expression whose operands still hold such a
 * sentinel at render time is kept as an expression (operands resolved so far)
 * for the chain runner to finish.
 *
 * The operator list is mirrored by `EXPRESSION_OPS` in `src/apps/page-validator.ts`.
 */

import { defineDirective, resolvePropValue } from "@json-render/core";
import { z } from "zod";

function toNumber(value: unknown): number | undefined {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

/** Folds numeric operands; any non-number operand yields `undefined`. */
function numeric(
  operands: unknown[],
  fold: (numbers: number[]) => number,
  arity?: number,
): number | undefined {
  if (operands.length === 0 || (arity !== undefined && operands.length !== arity)) return undefined;
  const numbers = operands.map(toNumber);
  if (numbers.some((number) => number === undefined)) return undefined;
  const result = fold(numbers as number[]);
  return Number.isFinite(result) ? result : undefined;
}

const OPS = {
  $add: (operands) => numeric(operands, (n) => n.reduce((sum, value) => sum + value, 0)),
  $sub: (operands) => numeric(operands, ([a, b]) => a! - b!, 2),
  $mul: (operands) => numeric(operands, (n) => n.reduce((product, value) => product * value, 1)),
  $div: (operands) => numeric(operands, ([a, b]) => a! / b!, 2),
  $min: (operands) => numeric(operands, (n) => Math.min(...n)),
  $max: (operands) => numeric(operands, (n) => Math.max(...n)),
  $split: ([text, separator = "", limit]) =>
    typeof text === "string" && typeof separator === "string"
      ? text.split(separator, toNumber(limit))
      : undefined,
  $join: ([list, separator = ""]) =>
    Array.isArray(list) && typeof separator === "string"
      ? list.map((entry) => (entry == null ? "" : String(entry))).join(separator)
      : undefined,
  $length: ([value]) =>
    value == null
      ? 0
      : typeof value === "string" || Array.isArray(value)
        ? value.length
        : undefined,
} satisfies Record<string, (operands: unknown[]) => unknown>;

export type ExpressionOp = keyof typeof OPS;
export const EXPRESSION_OPS = Object.keys(OPS) as ExpressionOp[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The operator of a `{ "$op": [...] }` expression, or null. */
export function expressionOp(value: unknown): ExpressionOp | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || !Object.hasOwn(OPS, keys[0]!)) return null;
  return Array.isArray(value[keys[0]!]) ? (keys[0] as ExpressionOp) : null;
}

/** Sentinels only a chain runner can resolve (`action-params.ts`). */
const CHAIN_SENTINELS = ["$chain", "$row", "$rowIndex", "$form", "$value"];

function hasChainSentinel(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasChainSentinel);
  if (!isRecord(value)) return false;
  if (CHAIN_SENTINELS.some((key) => Object.hasOwn(value, key))) return true;
  return Object.values(value).some(hasChainSentinel);
}

/**
 * Applies `op` to already-resolved operands. Operands that still carry a chain
 * sentinel keep the expression for the chain runner.
 */
export function evaluateExpression(op: ExpressionOp, operands: unknown[]): unknown {
  if (operands.some(hasChainSentinel)) return { [op]: operands };
  return OPS[op](operands);
}

/** json-render directives for every operator, for `JSONUIProvider directives`. */
export const expressionDirectives = EXPRESSION_OPS.map((op) =>
  defineDirective({
    name: op,
    schema: z.object({ [op]: z.array(z.unknown()) }),
    resolve: (value, ctx) => {
      const operands = (value as Record<string, unknown>)[op];
      if (!Array.isArray(operands)) return undefined;
      return evaluateExpression(
        op,
        operands.map((operand) => resolvePropValue(operand, ctx)),
      );
    },
  }),
);
