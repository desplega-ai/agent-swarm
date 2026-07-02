import { describe, expect, test } from "bun:test";
import { extractScriptSignature } from "../scripts-runtime/extract-signature";

describe("extractScriptSignature", () => {
  test("extracts arrow function destructured args and return type", () => {
    const sig = extractScriptSignature(`
      /** Adds one */
      export default async ({ x }: { x: number }): Promise<{ y: number }> => ({ y: x + 1 });
    `);
    expect(sig.argsType).toBe("{ x: number }");
    expect(sig.resultType).toBe("{ y: number }");
    expect(sig.description).toBe("Adds one");
  });

  test("extracts generic async function declarations", () => {
    const sig = extractScriptSignature(`
      /** Generic mapper */
      export default async function <T extends { id: string }>(
        args: T
      ): Promise<{
        id: string;
        ok: boolean;
      }> {
        return { id: args.id, ok: true };
      }
    `);
    expect(sig.argsType).toBe("T");
    expect(sig.resultType).toContain("ok: boolean");
    expect(sig.description).toBe("Generic mapper");
  });

  test("falls back when no default export exists", () => {
    expect(extractScriptSignature("export const x = 1")).toEqual({
      argsType: "unknown",
      resultType: "unknown",
      description: "",
    });
  });

  test("falls back on syntax error", () => {
    expect(extractScriptSignature("export default async (")).toEqual({
      argsType: "unknown",
      resultType: "unknown",
      description: "",
    });
  });
});
