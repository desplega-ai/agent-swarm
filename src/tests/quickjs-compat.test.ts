import { describe, expect, test } from "bun:test";
import {
  checkQuickJSCompat,
  type QuickJSCompatRule,
  quickJSCompatWarnings,
} from "../scripts-runtime/quickjs-compat";

const wrap = (body: string) => `export default async (args, ctx) => {\n${body}\n};`;

// One positive (flagged) and one negative (clean, but close) fixture per rule.
const FIXTURES: Array<{ rule: QuickJSCompatRule; flagged: string; clean: string }> = [
  {
    rule: "bunGlobal",
    flagged: wrap("return Bun.hash('x');"),
    clean: wrap("const Bun = { hash: (s) => s }; return typeof globalThis.Bun;"),
  },
  {
    rule: "process",
    flagged: wrap("return process.env.HOME;"),
    clean: wrap("const config = { process: 1 }; return config.process + args.process;"),
  },
  {
    rule: "fsStdlib",
    flagged: wrap("return ctx.stdlib.glob('*.ts');"),
    clean: wrap("return ctx.stdlib.fetchJson('https://example.com');"),
  },
  {
    rule: "require",
    flagged: wrap("const fs = require('fs'); return fs;"),
    clean: wrap("const require = (name) => name; return require('fs');"),
  },
  {
    rule: "unsupportedGlobal",
    flagged: wrap("return Buffer.from('aGk=', 'base64').toString();"),
    clean: wrap("const bytes: Buffer | null = null; return { Buffer: bytes };"),
  },
  {
    rule: "cryptoSubtle",
    flagged: wrap("return crypto.subtle.digest('SHA-256', new Uint8Array());"),
    clean: wrap("return crypto.randomUUID();"),
  },
  {
    rule: "responseBody",
    flagged: wrap("const res = await fetch('https://example.com'); return res.arrayBuffer();"),
    clean: wrap("const res = await fetch('https://example.com'); return res.text();"),
  },
  {
    rule: "localeFormat",
    flagged: wrap("return new Date().toLocaleString('en-GB', { timeZone: 'Europe/Madrid' });"),
    clean: wrap("return new Date().toISOString();"),
  },
  {
    rule: "hostCredential",
    flagged: wrap("return ctx.stdlib.Redacted.value(ctx.swarm.config.apiKey);"),
    clean: wrap("return ctx.stdlib.Redacted.value(ctx.swarm.config.agentId);"),
  },
];

describe("checkQuickJSCompat", () => {
  for (const { rule, flagged, clean } of FIXTURES) {
    test(`${rule}: flags the positive fixture`, () => {
      const report = checkQuickJSCompat(flagged);
      expect(report.compatible).toBe(false);
      expect(report.findings.map((finding) => finding.rule)).toContain(rule);
    });

    test(`${rule}: passes the negative fixture`, () => {
      expect(checkQuickJSCompat(clean)).toEqual({ compatible: true, findings: [] });
    });
  }

  test("workspaceRw: flags the fsMode, not the source", () => {
    const source = wrap("return 'workspace-rw';");
    expect(checkQuickJSCompat(source, { fsMode: "workspace-rw" }).findings).toEqual([
      { rule: "workspaceRw", message: "fsMode workspace-rw is not available under quickjs" },
    ]);
    expect(checkQuickJSCompat(source, { fsMode: "none" }).compatible).toBe(true);
  });

  test("fsStdlib also catches stdlib imports and destructuring", () => {
    const imported = `import { glob } from "stdlib";\n${wrap("return glob('*');")}`;
    const destructured = wrap("const { grep } = ctx.stdlib; return grep('x', '.');");
    expect(checkQuickJSCompat(imported).findings[0]?.rule).toBe("fsStdlib");
    expect(checkQuickJSCompat(destructured).findings[0]?.rule).toBe("fsStdlib");
  });

  test("globals read off globalThis count, typeof feature checks do not", () => {
    expect(checkQuickJSCompat(wrap("return globalThis.process.env;")).findings[0]?.rule).toBe(
      "process",
    );
    expect(
      checkQuickJSCompat(wrap("return (globalThis as any).Bun.version;")).findings[0]?.rule,
    ).toBe("bunGlobal");
    expect(checkQuickJSCompat(wrap("return typeof process === 'undefined';")).compatible).toBe(
      true,
    );
  });

  test("the shimmed web globals are compatible", () => {
    const source = wrap(`const url = new URL("/x?a=1", "https://example.com");
url.searchParams.set("b", "2");
const bytes = new TextEncoder().encode(url.href);
const id = setInterval(() => {}, 10);
clearInterval(id);
await fetch(url, { method: "POST", body: bytes });
return [new TextDecoder().decode(bytes), crypto.randomUUID(), crypto.getRandomValues(new Uint8Array(4))];`);
    expect(checkQuickJSCompat(source)).toEqual({ compatible: true, findings: [] });
  });

  test("reports each rule and name once, with its first line", () => {
    const report = checkQuickJSCompat(wrap("Bun.sleep(1);\nBun.sleep(2);\nreturn process.pid;"));
    expect(report.findings).toEqual([
      { rule: "bunGlobal", message: "Bun.* is not available under quickjs", line: 2 },
      { rule: "process", message: "process is not available under quickjs", line: 4 },
    ]);
    expect(quickJSCompatWarnings(report, "actions.sync")).toEqual([
      "actions.sync: quickjs compat (bunGlobal, line 2): Bun.* is not available under quickjs",
      "actions.sync: quickjs compat (process, line 4): process is not available under quickjs",
    ]);
  });
});
