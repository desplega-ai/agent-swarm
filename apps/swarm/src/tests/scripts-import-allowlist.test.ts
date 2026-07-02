import { describe, expect, test } from "bun:test";
import { validateScriptImports } from "../scripts-runtime/import-allowlist";

describe("script import allowlist", () => {
  test("allows relative imports and runtime barrels", () => {
    const result = validateScriptImports(`
      import helper from './helper';
      import '../other';
      import { SwarmSdk } from 'swarm-sdk';
      import { table } from 'stdlib';
      export default () => helper;
    `);
    expect(result.ok).toBe(true);
  });

  test("rejects forbidden static imports", () => {
    const result = validateScriptImports("import fs from 'node:fs'; export default () => fs");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic).toContain("node:fs");
  });

  test("rejects child_process imports", () => {
    const result = validateScriptImports("import cp from 'child_process'; export default () => cp");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic).toContain("child_process");
  });

  test("rejects bun:sqlite imports", () => {
    const result = validateScriptImports(
      "import sqlite from 'bun:sqlite'; export default () => sqlite",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic).toContain("bun:sqlite");
  });

  test("rejects literal dynamic imports", () => {
    const result = validateScriptImports("export default async () => import('fs')");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic).toContain("fs");
  });

  test("rejects Function constructor dynamic import bypasses", () => {
    const result = validateScriptImports(
      `export default async () => new Function("return import('node:fs')")()`,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic).toContain("Function constructor");
  });

  test("rejects eval dynamic import bypasses", () => {
    const result = validateScriptImports(`export default async () => eval("import('node:fs')")`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic).toContain("eval");
  });
});
