import { describe, expect, test } from "bun:test";
import os from "node:os";
import { z } from "zod";
import * as zm from "zod/mini";
import { NativeScriptExecutor } from "../scripts-runtime/executors/native";
import { DEFAULT_SCRIPT_RESOURCES, type ExecutorInput } from "../scripts-runtime/executors/types";
import {
  HOST_VALIDATED_ARGS,
  isHostValidationEquivalent,
} from "../scripts-runtime/host-validated-args";

process.env.TMPDIR ??= os.tmpdir().replaceAll("\\", "/");

function makeInput(
  source: string,
  args: unknown,
  opts: { hostValidatedArgs?: boolean } = {},
): ExecutorInput {
  return {
    source,
    args,
    ...(opts.hostValidatedArgs !== undefined ? { hostValidatedArgs: opts.hostValidatedArgs } : {}),
    fsMode: "none",
    network: "open",
    resources: DEFAULT_SCRIPT_RESOURCES,
    configPayload: {
      system: {
        apiKey: { value: "test-key", isSecret: true },
        agentId: { value: "00000000-0000-0000-0000-000000000001", isSecret: false },
        mcpBaseUrl: { value: "http://127.0.0.1:19999", isSecret: false },
      },
      user: {},
    },
  };
}

describe("isHostValidationEquivalent", () => {
  test("accepts pure structural zod and zod/mini schemas with matching values", () => {
    const schema = z.object({
      name: z.string(),
      count: z.number(),
      active: z.boolean(),
      tags: z.array(z.string()),
      mode: z.enum(["fast", "slow"]),
      version: z.literal(1),
      note: z.string().optional(),
      parent: z.string().nullable(),
    });

    expect(
      isHostValidationEquivalent(schema, {
        name: "demo",
        count: 3,
        active: true,
        tags: ["a", "b"],
        mode: "fast",
        version: 1,
        parent: null,
      }),
    ).toBe(true);

    const miniSchema = zm.object({
      id: zm.string(),
      limit: zm.optional(zm.number()),
    });
    expect(isHostValidationEquivalent(miniSchema, { id: "abc" })).toBe(true);
    expect(isHostValidationEquivalent(miniSchema, { id: "abc", limit: 10 })).toBe(true);
  });

  test("rejects schemas with defaults, transforms, refinements, coercions, checks, or unknown keys", () => {
    expect(isHostValidationEquivalent(z.object({ x: z.string().default("hi") }), {})).toBe(false);
    expect(
      isHostValidationEquivalent(z.object({ x: z.string().default("hi").optional() }), {}),
    ).toBe(false);
    expect(
      isHostValidationEquivalent(z.object({ x: z.string().transform((s) => s.trim()) }), {
        x: "  hi  ",
      }),
    ).toBe(false);
    expect(
      isHostValidationEquivalent(z.object({ x: z.string().refine((s) => s.length > 0) }), {
        x: "hi",
      }),
    ).toBe(false);
    expect(isHostValidationEquivalent(z.object({ x: z.coerce.number() }), { x: 42 })).toBe(false);
    expect(isHostValidationEquivalent(z.object({ x: z.string().min(1) }), { x: "hi" })).toBe(false);
    expect(isHostValidationEquivalent(z.object({ x: z.string().email() }), { x: "a@b.co" })).toBe(
      false,
    );
    expect(isHostValidationEquivalent(z.object({ x: z.number().int() }), { x: 5 })).toBe(false);
    // Extra unknown keys require .parse() so z.object strips them (or z.strictObject rejects them)
    expect(isHostValidationEquivalent(z.object({ x: z.string() }), { x: "hi", extra: 1 })).toBe(
      false,
    );
    // Reverse numeric enum keys (e.g. { 0: "Read", Read: 0 }) must not pass as valid values
    const numericEnumSchema = z.enum({ 0: "Read", Read: 0 }).nullable();
    expect(isHostValidationEquivalent(numericEnumSchema, 0)).toBe(true);
    expect(isHostValidationEquivalent(numericEnumSchema, null)).toBe(true);
    expect(isHostValidationEquivalent(numericEnumSchema, "Read")).toBe(false);
    // Inherited Object.prototype properties (constructor, toString) on `{}` must fall back to .parse()
    expect(
      isHostValidationEquivalent(z.object({ constructor: z.string().nullable().optional() }), {}),
    ).toBe(false);
    expect(
      isHostValidationEquivalent(z.object({ toString: z.string().nullable().optional() }), {}),
    ).toBe(false);
  });
});

describe("NativeScriptExecutor hostValidatedArgs (#2010)", () => {
  const executor = new NativeScriptExecutor();

  const countedStructuralScript = `
import { z } from "zod";
export const argsSchema = z.object({
  value: z.number(),
  label: z.string().optional(),
});
let parseCalls = 0;
const origParse = argsSchema.parse.bind(argsSchema);
argsSchema.parse = ((v: unknown) => {
  parseCalls++;
  return origParse(v);
}) as typeof argsSchema.parse;

export default async function (args: z.infer<typeof argsSchema>) {
  return { doubled: args.value * 2, label: args.label ?? null, parseCalls };
}
`;

  test("skips duplicate argsSchema.parse when hostValidatedArgs is true and schema is structural", async () => {
    const out = await executor.run(
      makeInput(countedStructuralScript, { value: 21, label: "ok" }, { hostValidatedArgs: true }),
    );
    expect(out.exitCode).toBe(0);
    expect(out.error).toBeUndefined();
    expect(out.result).toEqual({ doubled: 42, label: "ok", parseCalls: 0 });
  });

  test("still runs argsSchema.parse when hostValidatedArgs is omitted or false", async () => {
    const out = await executor.run(makeInput(countedStructuralScript, { value: 21 }));
    expect(out.exitCode).toBe(0);
    expect(out.result).toEqual({ doubled: 42, label: null, parseCalls: 1 });
  });

  test("still runs argsSchema.parse when args contain extra keys that Zod strips", async () => {
    const out = await executor.run(
      makeInput(
        countedStructuralScript,
        { value: 21, extra: "stripped-by-zod" },
        { hostValidatedArgs: true },
      ),
    );
    expect(out.exitCode).toBe(0);
    expect(out.result).toEqual({ doubled: 42, label: null, parseCalls: 1 });
  });

  test("still runs argsSchema.parse when schema uses defaults, transforms, or refinements", async () => {
    const scriptWithDefaultsAndTransforms = `
import { z } from "zod";
export const argsSchema = z.object({
  value: z.number().default(10),
  tag: z.string().transform((s) => s.toUpperCase()),
});
let parseCalls = 0;
const origParse = argsSchema.parse.bind(argsSchema);
argsSchema.parse = ((v: unknown) => {
  parseCalls++;
  return origParse(v);
}) as typeof argsSchema.parse;

export default async function (args: z.infer<typeof argsSchema>) {
  return { value: args.value, tag: args.tag, parseCalls };
}
`;
    const out = await executor.run(
      makeInput(scriptWithDefaultsAndTransforms, { tag: "hello" }, { hostValidatedArgs: true }),
    );
    expect(out.exitCode).toBe(0);
    expect(out.result).toEqual({ value: 10, tag: "HELLO", parseCalls: 1 });
  });

  test("caller-supplied args payload cannot spoof the trusted host validation marker", async () => {
    expect(Symbol.keyFor(HOST_VALIDATED_ARGS)).toBeUndefined();
    expect(Symbol.for("swarm.hostValidatedArgs")).not.toBe(HOST_VALIDATED_ARGS);
    const out = await executor.run(
      makeInput(countedStructuralScript, {
        value: 7,
        hostValidatedArgs: true,
        SWARM_SCRIPT_HOST_VALIDATED_ARGS: "1",
      }),
    );
    expect(out.exitCode).toBe(0);
    expect(out.result).toEqual({ doubled: 14, label: null, parseCalls: 1 });
  });
});
