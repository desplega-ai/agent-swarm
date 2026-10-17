import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { deleteSwarmConfig, upsertSwarmConfig } from "../be/db";
import { buildScriptCredentialBindingsWithFailures } from "../be/script-credential-broker";
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
import {
  SCRIPT_FS_MAX_METADATA_BYTES,
  SCRIPT_FS_MAX_NAME_LENGTH,
} from "../scripts-runtime/scratch-fs";
import {
  AGENT_FS_API_KEY_CONFIG,
  createScriptFs,
  SCRIPT_FS_MAX_BYTES,
} from "../scripts-runtime/script-fs";
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
        if (!bytes) return notFound(path);
        // Files under /streamed/ go out chunked, with no Content-Length.
        return new Response(path.startsWith("/streamed/") ? new Blob([bytes]).stream() : bytes);
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
              let normalized = "";
              try { await ctx.fs.writeFile("/tmp/../afs/canonical.md", "bypass"); } catch (e) { normalized = e.message; }
              const shell = await ctx.sh("mkdir -p /afs; echo persisted > /afs/report.md; cat /afs/report.md");
              const alias = await ctx.sh("ln -s /afs /tmp/link; echo alias > /tmp/link/alias.md");
              await ctx.fs.writeFile("/tmp/tree/afs/report.md", "scratch");
              let copied = "";
              try { await ctx.fs.cp("/tmp/tree", "/", { recursive: true }); } catch (e) { copied = e.message; }
              return {
                sorted: sorted.stdout,
                error,
                normalized,
                shell,
                alias,
                copied,
                root: (await ctx.sh("ls /")).stdout,
                exists: await ctx.fs.exists("/afs/x.md"),
                normalizedExists: await ctx.fs.exists("/tmp/../afs/canonical.md"),
              };
            };`,
            false,
          ),
        );
        expect(output.error).toBeUndefined();
        const result = output.result as Record<string, unknown>;
        expect(result.sorted).toBe("a\nb\n");
        expect(result.error).toContain("agent-fs is not configured");
        expect(result.normalized).toContain("agent-fs is not configured");
        // A shell write to /afs fails instead of landing in scratch.
        const shell = result.shell as { stdout: string; stderr: string; exitCode: number };
        expect(shell.exitCode).not.toBe(0);
        expect(shell.stdout).not.toContain("persisted");
        // A symlink alias and a recursive copy into / cannot reach /afs either.
        const alias = result.alias as { stderr: string; exitCode: number };
        expect(alias.exitCode).not.toBe(0);
        expect(alias.stderr).toContain("agent-fs is not configured");
        expect(result.copied).toContain("agent-fs is not configured");
        expect(result.root).not.toContain("afs");
        expect(result.exists).toBe(false);
        expect(result.normalizedExists).toBe(false);
        expect(seenAuth.size).toBe(0);
      },
      { timeout: 30_000 },
    );

    run(
      "a mounted file over SCRIPT_FS_MAX_BYTES fails before it is buffered",
      async () => {
        const big = new Uint8Array(SCRIPT_FS_MAX_BYTES + 1);
        files.set("/big.bin", big);
        files.set("/streamed/big.bin", big);
        const output = await makeExecutor().run(
          input(`export default async (_args, ctx) => {
            const reads = [];
            for (const path of ["/afs/big.bin", "/afs/streamed/big.bin"]) {
              try { await ctx.fs.readFile(path); reads.push("read"); } catch (e) { reads.push(e.message); }
            }
            let append = "";
            try { await ctx.fs.appendFile("/afs/streamed/big.bin", "x"); } catch (e) { append = e.message; }
            const wc = await ctx.sh("wc -c /afs/streamed/big.bin");
            return { reads, append, wc, small: await ctx.fs.readFile("/afs/notes/seed.md") };
          };`),
        );
        expect(output.error).toBeUndefined();
        const result = output.result as Record<string, unknown>;
        for (const message of result.reads as string[]) expect(message).toContain("EFBIG");
        expect(result.append).toContain("EFBIG");
        const wc = result.wc as { stdout: string; stderr: string; exitCode: number };
        // just-bash's wc reports any read error as "No such file or directory".
        expect(wc.exitCode).not.toBe(0);
        expect(wc.stdout).not.toContain(String(SCRIPT_FS_MAX_BYTES + 1));
        // Small files still read, and the failed append wrote nothing.
        expect(result.small).toBe("hello from the drive\nsecond line\n");
        expect(files.get("/streamed/big.bin")?.length).toBe(SCRIPT_FS_MAX_BYTES + 1);
      },
      { timeout: 30_000 },
    );
  });
}

suite("native", () => new NativeScriptExecutor(), true);
suite("quickjs", () => new QuickJSScriptExecutor(), false);

// Under quickjs, ctx.fs and ctx.sh run in the API process, outside the QuickJS heap limit.
test("scratch files and one ctx.sh command stay under SCRIPT_FS_MAX_BYTES", async () => {
  const { fs, sh } = createScriptFs(undefined);
  await expect(fs.writeFile("/tmp/big", "a".repeat(SCRIPT_FS_MAX_BYTES + 1))).rejects.toThrow(
    "ENOSPC",
  );
  await fs.writeFile("/tmp/half", "a".repeat(SCRIPT_FS_MAX_BYTES / 2 + 1));
  const over = await sh("cat /tmp/half /tmp/half | wc -c");
  expect(over.exitCode).not.toBe(0);
  expect(over.stderr).toContain("output size limit exceeded");
  // The session still works after a command hits the cap.
  expect((await sh("echo ok")).stdout).toBe("ok\n");
});

// InMemoryFs charges only file bodies, so names and empty entries need their own budget.
test("scratch names and empty entries stay under SCRIPT_FS_MAX_METADATA_BYTES", async () => {
  const { fs, sh } = createScriptFs(undefined);
  const longName = "x".repeat(SCRIPT_FS_MAX_NAME_LENGTH + 1);
  await expect(fs.writeFile(`/tmp/0${"x".repeat(1024 * 1024)}`, "")).rejects.toThrow(
    "ENAMETOOLONG",
  );
  expect((await sh(`touch /tmp/${longName}`)).exitCode).not.toBe(0);
  // A path within PATH_MAX but deep enough that its parents alone pass the budget.
  const deep = await sh(`mkdir -p /tmp/${"a/".repeat(2000)}`);
  expect(deep.exitCode).not.toBe(0);
  expect(deep.stderr).toContain("ENOSPC");

  const name = "y".repeat(200);
  let created = 0;
  let error = "";
  try {
    for (;;) {
      await fs.writeFile(`/tmp/${created}${name}`, "");
      created++;
    }
  } catch (e) {
    error = (e as Error).message;
  }
  expect(error).toContain("ENOSPC");
  // Each entry costs more than its name, so the budget fills well before 8 MiB of names.
  expect(created).toBeGreaterThan(1000);
  expect(created * name.length).toBeLessThan(SCRIPT_FS_MAX_METADATA_BYTES / 2);
  const touch = await sh("touch /tmp/one-more");
  expect(touch.exitCode).not.toBe(0);
  expect(touch.stderr).toContain("ENOSPC");
  // Deleting entries gives the budget back.
  await fs.rm("/tmp", { recursive: true });
  await fs.writeFile("/tmp/after", "ok");
  expect(await fs.readFile("/tmp/after")).toBe("ok");
});

// MountableFs sends only literal /afs paths to the drive. Scratch must not reach /afs any other way.
test("scratch symlinks, cp and mv cannot reach a reserved /afs", async () => {
  const { fs, sh } = createScriptFs(undefined);
  const notConfigured = "agent-fs is not configured";
  for (const command of [
    "ln -s /afs /tmp/link && echo x > /tmp/link/alias.md",
    "ln -s /afs/report.md /tmp/alias && echo x > /tmp/alias",
    "mkdir -p /tmp/d && ln -s ../../afs /tmp/d/up && echo x > /tmp/d/up/r.md",
    "ln -s / /tmp/root && echo x > /tmp/root/afs/r.md",
    "ln -s /tmp/hop2 /tmp/hop1 && ln -s /afs /tmp/hop2 && echo x > /tmp/hop1/r.md",
  ]) {
    const result = await sh(command);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(notConfigured);
  }
  // just-bash's mkdir and cat report every error as "No such file or directory".
  expect((await sh("mkdir -p /tmp/root/afs")).exitCode).not.toBe(0);
  await expect(fs.readFile("/tmp/hop1/r.md")).rejects.toThrow(notConfigured);
  await expect(fs.readFile("/tmp/alias")).rejects.toThrow(notConfigured);
  await fs.writeFile("/tmp/tree/afs/report.md", "scratch");
  await expect(fs.cp("/tmp/tree", "/", { recursive: true })).rejects.toThrow(notConfigured);
  await expect(fs.mv("/tmp/tree", "/")).rejects.toThrow(notConfigured);
  await expect(fs.cp("/tmp/tree/afs/report.md", "/tmp/root/afs/r.md")).rejects.toThrow(
    notConfigured,
  );
  // Nothing landed, the source is untouched, and the links themselves can go.
  expect(await fs.readdir("/")).not.toContain("afs");
  expect(await fs.readFile("/tmp/tree/afs/report.md")).toBe("scratch");
  await fs.rm("/tmp/link");
  expect(await fs.exists("/tmp/link")).toBe(false);
  // Ordinary symlinks inside scratch still work.
  expect((await sh("ln -s /tmp/tree /tmp/t && cat /tmp/t/afs/report.md")).stdout).toBe("scratch");
});

test("a write racing a cp or mv into / cannot slip past the preflight", async () => {
  // Each offset lets the write start at a different point of the cp / mv checks.
  for (const operation of ["cp", "mv"] as const) {
    for (let hops = 0; hops < 20; hops++) {
      const { fs } = createScriptFs(undefined);
      for (let f = 0; f < 30; f++) await fs.writeFile(`/tmp/tree/f${f}.txt`, "a");
      const [, write] = await Promise.allSettled([
        operation === "cp" ? fs.cp("/tmp/tree", "/", { recursive: true }) : fs.mv("/tmp/tree", "/"),
        (async () => {
          for (let i = 0; i < hops; i++) await null;
          await fs.writeFile("/tmp/tree/afs/r.md", "leak");
        })(),
      ]);
      expect(await fs.readdir("/")).not.toContain("afs");
      // A write that succeeded must stay readable where it was written.
      if (write.status === "fulfilled")
        expect(await fs.readFile("/tmp/tree/afs/r.md")).toBe("leak");
    }
  }
});

test("with a drive, a scratch symlink into /afs fails with EXDEV", async () => {
  const { sh } = createScriptFs(agentFs());
  // The base fails before any request, so the drive's auth does not matter here.
  const result = await sh("ln -s /afs/notes /tmp/notes && echo x > /tmp/notes/new.md");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("EXDEV");
  expect(seenAuth.size).toBe(0);
});

test("removed symlinks give their target bytes back", async () => {
  const { fs, sh } = createScriptFs(undefined);
  const target = "x".repeat(4096);
  // Each cycle charges about 8 KiB of target, so 1100 cycles pass the budget unless removal
  // credits it. ctx.fs.rm, because just-bash's rm follows a dangling link and fails.
  for (let i = 0; i < 1100; i++) {
    const link = await sh(`ln -s ${target} /tmp/link`);
    expect(link.stderr).toBe("");
    await fs.rm("/tmp/link", { force: true });
  }
  expect((await sh(`ln -s ${target} /tmp/link`)).exitCode).toBe(0);
});

describe("agent-fs credential resolution (real resolver)", () => {
  const COORDS = {
    AGENT_FS_API_URL: "https://fs.example.test",
    AGENT_FS_DEFAULT_ORG_ID: "org-shared",
    AGENT_FS_DEFAULT_DRIVE_ID: "drive-shared",
  };
  const ENV_KEYS = [...Object.keys(COORDS), AGENT_FS_API_KEY_CONFIG];
  const savedEnv = new Map<string, string | undefined>();
  const createdConfigIds: string[] = [];

  async function seed(
    scope: "global" | "agent" | "repo",
    scopeId: string | null,
    key: string,
    value: string,
  ) {
    const row = await upsertSwarmConfig({ scope, scopeId, key, value, isSecret: true });
    createdConfigIds.push(row.id);
  }

  async function resolve(agentId: string, repoId?: string) {
    const out = await buildScriptCredentialBindingsWithFailures({ agentId, repoId });
    const entries = out.egressSecrets.filter((entry) =>
      entry.allowedHosts.includes("fs.example.test"),
    );
    return { agentFs: out.agentFs, values: entries.map((entry) => entry.value) };
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    Object.assign(process.env, COORDS);
    delete process.env[AGENT_FS_API_KEY_CONFIG];
  });

  afterEach(async () => {
    for (const id of createdConfigIds.splice(0)) await deleteSwarmConfig(id);
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("mounts with the invoking agent's own key", async () => {
    const agentId = crypto.randomUUID();
    await seed("agent", agentId, AGENT_FS_API_KEY_CONFIG, "own-agent-key");
    const out = await buildScriptCredentialBindingsWithFailures({ agentId });
    expect(out.agentFs).toEqual({
      apiUrl: "https://fs.example.test",
      orgId: "org-shared",
      driveId: "drive-shared",
    });
    // First, so it claims the placeholder before any operator binding.
    expect(out.egressSecrets[0]).toMatchObject({
      configKey: AGENT_FS_API_KEY_CONFIG,
      allowedHosts: ["fs.example.test"],
      scope: "agent",
      scopeId: agentId,
      value: "own-agent-key",
    });
  });

  test("an own key wins over a repo override", async () => {
    const agentId = crypto.randomUUID();
    const repoId = crypto.randomUUID();
    await seed("agent", agentId, AGENT_FS_API_KEY_CONFIG, "own-agent-key");
    await seed("repo", repoId, AGENT_FS_API_KEY_CONFIG, "repo-key");
    const { agentFs, values } = await resolve(agentId, repoId);
    expect(agentFs).toBeDefined();
    expect(values[0]).toBe("own-agent-key");
  });

  test("no own key: global, repo, env, another agent's and the API key never mount", async () => {
    const agentId = crypto.randomUUID();
    const repoId = crypto.randomUUID();
    await seed("global", null, AGENT_FS_API_KEY_CONFIG, "global-shared-key");
    await seed("repo", repoId, AGENT_FS_API_KEY_CONFIG, "repo-key");
    await seed("agent", crypto.randomUUID(), AGENT_FS_API_KEY_CONFIG, "other-agent-key");
    await seed("global", null, "API_AGENT_FS_API_KEY", "api-bootstrap-key");
    process.env[AGENT_FS_API_KEY_CONFIG] = "api-env-key";
    for (const result of [await resolve(agentId), await resolve(agentId, repoId)]) {
      expect(result.agentFs).toBeUndefined();
      expect(result.values).toEqual([]);
    }
  });
});

// Mirrors the Dockerfile bundle step: just-bash stays out of the harness bundle
// and resolves from scripts-runtime/node_modules on the first ctx.fs / ctx.sh call.
test.skipIf(SKIP_SANDBOX_SPAWN_TESTS)(
  "compiled-binary mode: harness stays small and loads just-bash lazily",
  async () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/script-fs-bundle-${crypto.randomUUID()}`;
    const runtimeSrc = fileURLToPath(new URL("../scripts-runtime", import.meta.url));
    const modules = fileURLToPath(new URL("../../node_modules", import.meta.url));
    const adapterDir = `${dir}/node_modules/@desplega.ai/agent-fs-just-bash`;
    const packageJson = JSON.stringify({ type: "module", main: "index.js" });
    try {
      await Bun.$`bun build ${runtimeSrc}/eval-harness.ts --target bun --no-splitting --external just-bash --external @desplega.ai/agent-fs-just-bash --outfile ${dir}/eval-harness.bundle.js`.quiet();
      await Bun.$`bun build ${runtimeSrc}/stdlib/index.ts --target bun --no-splitting --outfile ${dir}/stdlib.bundle.js`.quiet();
      await Bun.$`bun build ${runtimeSrc}/swarm-sdk.ts --target bun --no-splitting --outfile ${dir}/swarm-sdk.bundle.js`.quiet();
      await Bun.$`bun build ${modules}/just-bash/dist/bundle/index.js --target bun --no-splitting --outfile ${dir}/node_modules/just-bash/index.js`.quiet();
      await Bun.$`bun build ${modules}/@desplega.ai/agent-fs-just-bash/dist/index.js --target bun --no-splitting --outfile ${adapterDir}/index.js`.quiet();
      await Bun.write(`${dir}/node_modules/just-bash/package.json`, packageJson);
      await Bun.write(`${adapterDir}/package.json`, packageJson);

      expect(Bun.file(`${dir}/eval-harness.bundle.js`).size).toBeLessThan(1024 * 1024);

      process.env.SCRIPT_RUNTIME_DIR = dir;
      const output = await new NativeScriptExecutor().run(input(ROUND_TRIP));
      expect(output.error).toBeUndefined();
      expect((output.result as Record<string, unknown>).readBack).toBe("from-bash\n");
    } finally {
      delete process.env.SCRIPT_RUNTIME_DIR;
      await Bun.$`rm -rf ${dir}`;
    }
  },
  { timeout: 60_000 },
);
