import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { placeholderForConfigKey } from "../scripts-runtime/credential-broker";
import { NativeScriptExecutor } from "../scripts-runtime/executors/native";
import { QuickJSScriptExecutor } from "../scripts-runtime/executors/quickjs";
import {
  DEFAULT_SCRIPT_RESOURCES,
  type ExecutorInput,
  type ScriptAgentFsDescriptor,
  type ScriptExecutor,
  type SwarmConfigPayload,
} from "../scripts-runtime/executors/types";
import { AGENT_FS_API_KEY_CONFIG } from "../scripts-runtime/script-fs";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";

// A minimal agent-fs: the ops and raw-file routes that AgentFsFileSystem calls.
const AGENT_FS_KEY = "real-agent-fs-key-for-tests";
const ORG = "org-1";
const DRIVE = "drive-1";
const files = new Map<string, Uint8Array>();
const seenAuth = new Set<string>();
let server: ReturnType<typeof Bun.serve>;

function notFound(path: string) {
  return Response.json({ error: "NOT_FOUND", message: `not found: ${path}` }, { status: 404 });
}

function children(dir: string) {
  const prefix = dir === "/" ? "/" : `${dir}/`;
  const entries = new Map<string, { name: string; type: "file" | "directory"; size?: number }>();
  for (const [path, bytes] of files) {
    if (!path.startsWith(prefix)) continue;
    const [name, ...rest] = path.slice(prefix.length).split("/");
    if (!name) continue;
    entries.set(
      name,
      rest.length > 0 ? { name, type: "directory" } : { name, type: "file", size: bytes.length },
    );
  }
  return [...entries.values()];
}

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization") ?? "";
      seenAuth.add(auth);
      if (auth !== `Bearer ${AGENT_FS_KEY}`) {
        return Response.json({ error: "UNAUTHORIZED", message: "bad key" }, { status: 401 });
      }
      if (req.method === "POST" && url.pathname === `/orgs/${ORG}/ops`) {
        const body = (await req.json()) as Record<string, string>;
        if (body.driveId !== DRIVE) return Response.json({ error: "BAD_DRIVE" }, { status: 400 });
        const path = body.path ?? "";
        switch (body.op) {
          case "stat": {
            const bytes = files.get(path);
            if (!bytes) return notFound(path);
            return Response.json({ size: bytes.length, modifiedAt: "2026-10-16T00:00:00.000Z" });
          }
          case "ls":
            return Response.json({ entries: children(path) });
          case "rm":
            return files.delete(path) ? Response.json({ ok: true }) : notFound(path);
          case "cp":
          case "mv": {
            const bytes = files.get(body.from ?? "");
            if (!bytes) return notFound(body.from ?? "");
            files.set(body.to ?? "", bytes);
            if (body.op === "mv") files.delete(body.from ?? "");
            return Response.json({ ok: true });
          }
          default:
            return Response.json({ error: "UNKNOWN_OP" }, { status: 400 });
        }
      }
      const raw = url.pathname.match(new RegExp(`^/orgs/${ORG}/drives/${DRIVE}/files/(.+)/raw$`));
      if (raw?.[1]) {
        const path = `/${raw[1].split("/").map(decodeURIComponent).join("/")}`;
        if (req.method === "PUT") {
          files.set(path, new Uint8Array(await req.arrayBuffer()));
          return Response.json({ version: 1, path });
        }
        const bytes = files.get(path);
        return bytes ? new Response(bytes) : notFound(path);
      }
      return new Response("no route", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  files.clear();
  seenAuth.clear();
  files.set("/notes/seed.md", new TextEncoder().encode("hello from the drive\nsecond line\n"));
});

function agentFs(): ScriptAgentFsDescriptor {
  return { apiUrl: `http://127.0.0.1:${server.port}`, orgId: ORG, driveId: DRIVE };
}

function payload(withAgentFs: boolean): SwarmConfigPayload {
  const placeholder = placeholderForConfigKey(AGENT_FS_API_KEY_CONFIG);
  return {
    system: {
      apiKey: { value: "swarm-key", isSecret: true },
      agentId: { value: "agent-1", isSecret: false },
      mcpBaseUrl: { value: "http://localhost:3013", isSecret: false },
    },
    user: {},
    egressSecrets: [
      {
        configKey: AGENT_FS_API_KEY_CONFIG,
        allowedHosts: ["127.0.0.1"],
        headerTemplate: `Authorization: Bearer ${placeholder}`,
        scope: "global",
        scopeId: null,
        active: true,
        authKind: "config",
        placeholder,
        value: AGENT_FS_KEY,
      },
    ],
    ...(withAgentFs ? { agentFs: agentFs() } : {}),
  };
}

function input(source: string, withAgentFs = true): ExecutorInput {
  return {
    source,
    args: null,
    configPayload: payload(withAgentFs),
    resources: { ...DEFAULT_SCRIPT_RESOURCES, memoryMb: 2048, wallClockMs: 20_000 },
    fsMode: "none",
    network: "open",
  };
}

const ROUND_TRIP = `
export default async (_args, ctx) => {
  await ctx.fs.mkdir("/afs/reports", { recursive: true });
  await ctx.fs.writeFile("/afs/reports/today.md", "hello report\\nline two\\nhello again\\n");
  await ctx.fs.appendFile("reports/today.md", "appended\\n");
  await ctx.fs.writeFile("/tmp/scratch.txt", "only in memory\\n");
  const grep = await ctx.sh("grep -rn hello . | sort");
  const count = await ctx.sh("wc -l < today.md", { cwd: "/afs/reports" });
  const glob = await ctx.sh("ls notes/*.md");
  const pipe = await ctx.sh("cat /tmp/scratch.txt | tr a-z A-Z");
  const jq = await ctx.sh("jq -r .name", { stdin: '{"name":"swarm"}' });
  const fail = await ctx.sh("cat /afs/missing.txt");
  await ctx.sh("echo from-bash > /afs/reports/bash.txt");
  return {
    grep: grep.stdout,
    count: count.stdout.trim(),
    glob: glob.stdout.trim(),
    pipe: pipe.stdout.trim(),
    jq: jq.stdout.trim(),
    failExit: fail.exitCode,
    readBack: await ctx.fs.readFile("/afs/reports/bash.txt"),
    listing: await ctx.fs.readdir("/afs/reports"),
    stat: await ctx.fs.stat("/afs/reports/today.md"),
    scratchOnDrive: await ctx.fs.exists("/afs/tmp/scratch.txt"),
  };
};
`;

function suite(name: string, makeExecutor: () => ScriptExecutor, spawns: boolean) {
  const run = test.skipIf(spawns && SKIP_SANDBOX_SPAWN_TESTS);

  describe(`${name} executor: ctx.fs and ctx.sh`, () => {
    run(
      "reads and writes agent-fs and runs bash over it",
      async () => {
        const output = await makeExecutor().run(input(ROUND_TRIP));
        expect(output.stderr).toBe("");
        expect(output.error).toBeUndefined();
        const result = output.result as Record<string, unknown>;
        // just-bash drops GNU grep's "./" prefix for `grep -r <pat> .`.
        expect(result.grep).toBe(
          "notes/seed.md:1:hello from the drive\nreports/today.md:1:hello report\nreports/today.md:3:hello again\n",
        );
        expect(result.count).toBe("4");
        expect(result.glob).toBe("notes/seed.md");
        expect(result.pipe).toBe("ONLY IN MEMORY");
        expect(result.jq).toBe("swarm");
        expect(result.failExit).toBe(1);
        expect(result.readBack).toBe("from-bash\n");
        expect(result.listing).toEqual(["bash.txt", "today.md"]);
        expect(result.stat).toEqual({
          isFile: true,
          isDirectory: false,
          size: 43,
          mtime: "2026-10-16T00:00:00.000Z",
        });
        expect(result.scratchOnDrive).toBe(false);

        // Writes landed on the drive; scratch stayed in memory.
        expect(new TextDecoder().decode(files.get("/reports/today.md"))).toBe(
          "hello report\nline two\nhello again\nappended\n",
        );
        expect([...files.keys()].some((path) => path.includes("scratch"))).toBe(false);
        // Only the real key reached agent-fs, and the script never saw it.
        expect([...seenAuth]).toEqual([`Bearer ${AGENT_FS_KEY}`]);
        expect(JSON.stringify(output)).not.toContain(AGENT_FS_KEY);
      },
      { timeout: 30_000 },
    );

    run(
      "without agent-fs, scratch works and /afs fails with the reason",
      async () => {
        const output = await makeExecutor().run(
          input(
            `export default async (_args, ctx) => {
              await ctx.fs.writeFile("/work/a.txt", "b\\na\\n");
              const sorted = await ctx.sh("sort /work/a.txt");
              let error = "";
              try { await ctx.fs.readFile("/afs/x.md"); } catch (e) { error = e.message; }
              return { sorted: sorted.stdout, error, exists: await ctx.fs.exists("/afs/x.md") };
            };`,
            false,
          ),
        );
        expect(output.error).toBeUndefined();
        const result = output.result as Record<string, unknown>;
        expect(result.sorted).toBe("a\nb\n");
        expect(result.error).toContain("agent-fs is not configured");
        expect(result.exists).toBe(false);
        expect(seenAuth.size).toBe(0);
      },
      { timeout: 30_000 },
    );
  });
}

suite("native", () => new NativeScriptExecutor(), true);
suite("quickjs", () => new QuickJSScriptExecutor(), false);
