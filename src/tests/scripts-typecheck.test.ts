import { describe, expect, test } from "bun:test";
import { typecheckScript } from "../be/scripts/typecheck";

describe("typecheckScript", () => {
  test("accepts ES2022 globals: JSON, Math, Date, Number, String, Error, isFinite, encodeURIComponent, parseInt, parseFloat", () => {
    const source = `
      export default async () => {
        const a = JSON.stringify({});
        const b = Math.floor(3.7);
        const c = new Date().toISOString();
        const d = Number("3");
        const e = String(1);
        if (!isFinite(d)) throw new Error("not finite");
        const f = encodeURIComponent("x");
        const g = parseInt("3", 10) + parseFloat("1.5");
        return { a, b, c, d, e, f, g };
      };
    `;
    expect(typecheckScript(source).ok).toBe(true);
  });

  test("accepts Promise<T> return annotations on async functions and Promise.all", () => {
    const source = `
      async function helper(): Promise<number[]> {
        return await Promise.all([Promise.resolve(1), Promise.resolve(2)]);
      }
      export default async (): Promise<number> => {
        const arr: number[] = await helper();
        return arr[0] + arr[1];
      };
    `;
    expect(typecheckScript(source).ok).toBe(true);
  });

  test("accepts Array<T> annotations and array-producing methods (split, match, map, reduce)", () => {
    const source = `
      export default async (): Promise<{ tokens: string[]; matches: string[] | null; doubled: number[]; sum: number }> => {
        const s: string = "a=1&b=2";
        const tokens: string[] = s.split("&");
        const matches: string[] | null = s.match(/[a-z]/g);
        const xs: Array<number> = [1, 2, 3];
        const doubled: number[] = xs.map((x: number) => x * 2);
        const sum: number = xs.reduce((acc: number, x: number) => acc + x, 0);
        return { tokens, matches, doubled, sum };
      };
    `;
    expect(typecheckScript(source).ok).toBe(true);
  });

  test("accepts throw new Error and structured object errors", () => {
    const source = `
      export default async () => {
        try {
          throw new Error("first");
        } catch (e) {
          if (e instanceof Error) throw new Error(e.message + " again");
          throw { code: "ERR", message: "fallback" };
        }
      };
    `;
    expect(typecheckScript(source).ok).toBe(true);
  });

  test("accepts the global fetch + Request/Response/Headers/URLSearchParams shapes", () => {
    const source = `
      export default async (args: { url: string }): Promise<{ ok: boolean; status: number; body: string; qs: string }> => {
        const req = new Request(args.url, { method: "GET", headers: { Accept: "application/json" } });
        const res: Response = await fetch(req);
        const body: string = await res.text();
        const params: URLSearchParams = new URLSearchParams({ a: "1", b: "2" });
        return { ok: res.ok, status: res.status, body, qs: params.toString() };
      };
    `;
    expect(typecheckScript(source).ok).toBe(true);
  });

  test("accepts URL construction + console + setTimeout + crypto.randomUUID", () => {
    const source = `
      export default async () => {
        const u: URL = new URL("https://example.com/path?x=1");
        console.log("hostname", u.hostname);
        const id: string = crypto.randomUUID();
        await new Promise<void>((r: () => void) => setTimeout(r, 1));
        return { id, host: u.hostname };
      };
    `;
    expect(typecheckScript(source).ok).toBe(true);
  });

  test("accepts Bun's process.env + Buffer + TextEncoder/TextDecoder + AbortController", () => {
    const source = `
      export default async () => {
        const path = process.env.PATH ?? "/usr/bin";
        const buf = Buffer.from("hello");
        const enc = new TextEncoder().encode("hello");
        const dec = new TextDecoder().decode(enc);
        const ctrl = new AbortController();
        ctrl.abort();
        return { path, bytes: buf.length, dec, aborted: ctrl.signal.aborted };
      };
    `;
    expect(typecheckScript(source).ok).toBe(true);
  });

  test("rejects actual type errors and returns structured diagnostics with location, code, severity", () => {
    const result = typecheckScript(`
      export default async () => {
        const x: number = "not a number";
        return x;
      };
    `);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.structured.length).toBeGreaterThan(0);
    const d = result.structured[0];
    expect(d.severity).toBe("error");
    expect(d.code).toBe(2322);
    expect(d.file).toContain("user-script.ts");
    expect(d.line).toBeGreaterThan(0);
    expect(d.column).toBeGreaterThan(0);
    expect(d.message).toContain("string");
    expect(d.message).toContain("number");
  });

  test("returns exactly one formatted entry per compiler diagnostic", () => {
    const result = typecheckScript(`
      export default async () => {
        const count: number = "one";
        const enabled: boolean = 1;
        return { count, enabled };
      };
    `);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.structured).toHaveLength(2);
    expect(result.diagnostics).toHaveLength(result.structured.length);
    expect(result.diagnostics[0]).toContain("Type 'string' is not assignable to type 'number'");
    expect(result.diagnostics[1]).toContain("Type 'number' is not assignable to type 'boolean'");
  });

  test("captures the offending identifier on TS2304 (Cannot find name)", () => {
    const result = typecheckScript(`
      export default async () => {
        return noSuchGlobal;
      };
    `);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const cantFind = result.structured.find((d) => d.code === 2304 || d.code === 2552);
    expect(cantFind).toBeDefined();
    expect(cantFind?.identifier).toBe("noSuchGlobal");
  });

  test("surfaces 'Did you mean…' suggestions when TS provides them", () => {
    const result = typecheckScript(`
      export default async () => Mat.floor(3.7);
    `);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const hint = result.structured.find((d) => d.code === 2552);
    expect(hint).toBeDefined();
    expect(hint?.identifier).toBe("Mat");
    expect(hint?.suggestion).toBe("Math");
  });

  test("still rejects unknown ctx.swarm tools (SDK surface enforcement still works)", () => {
    const result = typecheckScript(`
      import type { ScriptContext } from "swarm-sdk";
      export default async (_args: unknown, ctx: ScriptContext) => ctx.swarm.no_such_tool({});
    `);
    expect(result.ok).toBe(false);
  });

  test("types KV SDK envelopes and entry values without changing their runtime shapes", () => {
    const source = `
      import type { ScriptContext } from "swarm-sdk";

      export default async (_args: unknown, ctx: ScriptContext) => {
        const get = await ctx.swarm.kv_get<{ ok: boolean }>({ key: "get" });
        if (get.success) {
          const ok: boolean = get.data.value.ok;
        } else {
          const error: string = get.data.error;
        }

        const nullable = await ctx.swarm.kv_getOrNull<{ count: number }>({ key: "nullable" });
        const nullableCount: number | undefined = nullable?.value.count;

        const json = await ctx.swarm.kv_set({ key: "json", value: { count: 1 }, expiresInSec: 60 });
        if (json.success) {
          const count: number = json.data.value.count;
        }

        const string = await ctx.swarm.kv_set({ key: "string", value: "value", valueType: "string" });
        if (string.success) {
          const value: string = string.data.value;
        }

        const integer = await ctx.swarm.kv_set({ key: "integer", value: "42", valueType: "integer" });
        if (integer.success) {
          const value: number = integer.data.value;
        }

        const incremented = await ctx.swarm.kv_incr({ key: "counter" });
        if (incremented.success) {
          const value: number = incremented.data.value;
        }

        const list = await ctx.swarm.kv_list<{ label: string }>({ prefix: "item:", offset: 10 });
        if (list.success) {
          const label: string | undefined = list.data.entries[0]?.value.label;
          const total: number = list.data.total;
          const namespace: string = list.data.namespace;
        }

        const deleted = await ctx.swarm.kv_delete({ key: "delete" });
        const legacyDeleted = await ctx.swarm.kv_del({ key: "legacy-delete" });
        if (deleted.success && legacyDeleted.success) {
          const canonicalStatus: 204 = deleted.status;
          const legacyStatus: 204 = legacyDeleted.status;
        }

        return { nullableCount };
      };
    `;
    expect(typecheckScript(source).ok).toBe(true);
  });

  test("does NOT include lib.dom.d.ts wholesale — DOM-only globals stay rejected", () => {
    // window/document/localStorage are intentionally NOT exposed by the runtime
    // and must NOT typecheck. This prevents authors from writing browser code
    // that breaks at runtime.
    const cases = [
      `export default async () => window.location.href;`,
      `export default async () => document.title;`,
      `export default async () => localStorage.getItem("x");`,
    ];
    for (const source of cases) {
      const r = typecheckScript(source);
      expect(r.ok).toBe(false);
    }
  });
});
