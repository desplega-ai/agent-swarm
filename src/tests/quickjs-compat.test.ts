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
  {
    rule: "privateHost",
    flagged: wrap("return ctx.stdlib.fetchJson('http://intranet:8080/status');"),
    clean: wrap("return ctx.stdlib.fetchJson('https://api.example.com/status');"),
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

  test("bindings resolve by lexical scope", () => {
    // A local Buffer parameter in one function does not hide a global Buffer in another.
    const shadowed = `function decode(Buffer: { from(x: string): string }) { return Buffer.from("x"); }
export default async () => [decode({ from: (x) => x }), Buffer.from("aGk=", "base64").toString()];`;
    expect(checkQuickJSCompat(shadowed).findings).toEqual([
      { rule: "unsupportedGlobal", message: "Buffer is not available under quickjs", line: 2 },
    ]);
    // Block scope too, and a shorthand property reads the binding it names.
    const block = wrap("{ const process = 1; } return { process };");
    expect(checkQuickJSCompat(block).findings[0]?.rule).toBe("process");
    // Every use resolves locally: clean.
    const local = `function decode(Buffer: { from(x: string): string }) { return Buffer.from("x"); }
export default async () => { const process = { env: {} }; return [decode({ from: (x) => x }), process.env]; };`;
    expect(checkQuickJSCompat(local)).toEqual({ compatible: true, findings: [] });
    // A declare-only binding defines nothing at run time, so the global still counts.
    const ambient = `declare const Buffer: any;\n${wrap("return Buffer.from('x');")}`;
    expect(checkQuickJSCompat(ambient).findings[0]?.rule).toBe("unsupportedGlobal");
  });

  test("atob and btoa are shimmed; AbortSignal stays reported", () => {
    expect(checkQuickJSCompat(wrap("return atob(btoa('hi'));"))).toEqual({
      compatible: true,
      findings: [],
    });
    expect(
      checkQuickJSCompat(
        wrap("return fetch('https://example.com', { signal: AbortSignal.timeout(5) });"),
      ).findings[0]?.message,
    ).toBe("AbortSignal is not available under quickjs");
  });

  test("privateHost: literal fetch URLs to single-label or private hosts", () => {
    const hosts = (body: string) =>
      checkQuickJSCompat(wrap(body)).findings.filter((finding) => finding.rule === "privateHost");
    const flagged = [
      "fetch('http://api:3013/health')",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: script source under test
      "fetch(`http://localhost:8080/${args.path}`)",
      "globalThis.fetch('http://10.0.0.5/x')",
      "ctx.stdlib.fetch('http://192.168.1.10/')",
      "ctx.stdlib.fetchJson('http://[::1]:9000/')",
      "ctx.stdlib.fetchJson('http://0x7f.1/')",
      "fetch('http://[fd00::1]/')",
      "fetch('http://[::ffff:10.1.2.3]/')",
      "fetch('https://svc.localhost/')",
      "const { fetchJson } = ctx.stdlib; await fetchJson('http://intranet/')",
    ];
    for (const call of flagged) expect(hosts(`return ${call};`)).toHaveLength(1);
    const clean = [
      "fetch('https://example.com/x')",
      "fetch('https://8.8.8.8/')",
      "fetch('http://[2001:db8::1]/')",
      "fetch(args.url)",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: script source under test
      "fetch(`http://${args.host}/x`)",
      "fetch('relative/path')",
      "ctx.api.github.fetch('http://intranet/')",
      "console.log('http://intranet/')",
    ];
    for (const call of clean) expect(hosts(`return ${call};`)).toEqual([]);
    // A const that holds the base URL fixes the host too; a let or a cut-off name does not.
    const constBase = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: script source under test
      "const API = 'http://api:3013'; return fetch(`${API}/health`);",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: script source under test
      "const API = 'http://api:3013'; return fetch(`${API}${args.path}`);",
      "const API = 'http://api:3013'; return ctx.stdlib.fetch(API + '/x');",
      "const API = `http://10.1.2.3`; return fetch(API);",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: script source under test
      "const API = 'http://api:3013'; const rows = `${API}/rows/${args.id}`; return fetch(`${rows}?limit=5`);",
    ];
    for (const body of constBase) expect(hosts(body)).toHaveLength(1);
    const dynamicBase = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: script source under test
      "let API = 'http://api:3013'; API = args.base; return fetch(`${API}/x`);",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: script source under test
      "return fetch(`http://intra${args.suffix}/x`);",
      "return fetch('http://intra' + args.suffix);",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: script source under test
      "const API = 'https://api.example.com'; return fetch(`${API}/x`);",
    ];
    for (const body of dynamicBase) expect(hosts(body)).toEqual([]);
    expect(hosts("return fetch('http://api:3013/health');")[0]?.message).toBe(
      "fetch to api:3013 (single-label host) depends on the egress policy: quickjs refuses private hosts unless the operator allows them",
    );
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
