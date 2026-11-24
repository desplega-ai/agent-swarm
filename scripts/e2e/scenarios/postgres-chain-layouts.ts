import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { createPostgresDatabase, dropPostgresDatabase } from "../db";
import { createApiClient, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { minimalEnv, repoRoot, startSut, stopSut, stopSutProcess } from "../sut";

const CHAIN = join(repoRoot, "src/be/migrations/postgres");

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

// Lays out the files the Dockerfile runtime stage copies from the build context
// (`COPY <src> <dest>` without `--from`) under `root`, with `/app` mapped to `root`,
// and returns `$MIGRATIONS_DIR` from its `ENV`. A COPY removed from the Dockerfile is
// missing here too, so the boot below fails as the image would.
function replicateDockerfileCopies(root: string): { migrationsDir: string } {
  const lines = readFileSync(join(repoRoot, "Dockerfile"), "utf8").split("\n");
  const lastFrom = lines.findLastIndex((line) => /^FROM\s/i.test(line));
  let workdir = "/";
  let migrationsDir: string | undefined;
  const toLocal = (dest: string) => {
    const abs = isAbsolute(dest) ? dest : join(workdir, dest);
    return join(root, relative("/app", abs));
  };
  for (const line of lines.slice(lastFrom + 1)) {
    const workdirMatch = /^WORKDIR\s+(\S+)/i.exec(line);
    if (workdirMatch) workdir = workdirMatch[1] as string;
    const envMatch = /^ENV\s+MIGRATIONS_DIR=(\S+)/i.exec(line);
    if (envMatch) migrationsDir = toLocal(envMatch[1] as string);
    const copy = /^COPY\s+(?!--)(.+)$/i.exec(line);
    if (!copy) continue;
    const args = (copy[1] as string).trim().split(/\s+/);
    const dest = args.pop() as string;
    const target = toLocal(dest);
    for (const src of args) {
      if (src.includes("*")) {
        mkdirSync(target, { recursive: true });
        for (const file of new Bun.Glob(src).scanSync({ cwd: repoRoot })) {
          cpSync(join(repoRoot, file), join(target, file.split("/").pop() as string));
        }
      } else if (dest.endsWith("/") && !src.endsWith("/")) {
        mkdirSync(target, { recursive: true });
        cpSync(join(repoRoot, src), join(target, src.split("/").pop() as string));
      } else {
        mkdirSync(dirname(target), { recursive: true });
        cpSync(join(repoRoot, src), target, { recursive: true });
      }
    }
  }
  expect(migrationsDir !== undefined, "the Dockerfile runtime stage sets no ENV MIGRATIONS_DIR");
  return { migrationsDir: migrationsDir as string };
}

// The entrypoints of the `bun build ... --compile` line in the Dockerfile, so this
// scenario compiles the binary the image ships.
function dockerfileCompileEntrypoints(): string[] {
  const text = readFileSync(join(repoRoot, "Dockerfile"), "utf8").replace(/\\\n/g, " ");
  const line = text.split("\n").find((l) => /^RUN\s+bun build\s.*--compile/.test(l));
  expect(line !== undefined, "the Dockerfile has no `RUN bun build ... --compile` line");
  const entrypoints = (line as string).split(/\s+/).filter((t) => /^\.\/src\/.+\.tsx?$/.test(t));
  expect(entrypoints.length > 0, "the Dockerfile compile line names no ./src entrypoint");
  return entrypoints;
}

async function run(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs?: number,
) {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

// The Postgres migration chain is found outside a source checkout:
// - the npm package: `dist/` chunks beside the shipped `src/`, `db-copy` run through the
//   Node bin from a directory outside the checkout;
// - the API image: a compiled binary (it reads `/$bunfs/`) with the
//   files the Dockerfile runtime stage COPYs laid out from the Dockerfile itself. It runs
//   `db-copy` without booting the API, then boots on DATABASE_URL.
export const postgresChainLayouts: Scenario = {
  name: "postgres-chain-layouts",
  order: 9_050,
  async run(ctx) {
    const work = mkdtempSync(join(tmpdir(), "e2e-chain-layouts-"));
    const databases: string[] = [];
    const source = await startSut(false, { SLACK_DISABLE: "true" }, {}, undefined, "sqlite");
    let api: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const created = await createApiClient(source.baseUrl, source.apiKey)("POST", "/api/tasks", {
        body: { task: `chain layout ${ctx.nonce}`, followUpConfig: { disabled: true } },
      });
      expectStatus(created, [201], "create a task on the source");
      await stopSutProcess(source);

      // npm package layout.
      const pkg = join(work, "pkg");
      const built = await run(
        [
          "bun",
          "build",
          "./src/cli.tsx",
          "--target=node",
          "--format=esm",
          "--splitting",
          `--outdir=${join(pkg, "dist")}`,
          "--entry-naming=cli.js",
        ],
        repoRoot,
        { ...minimalEnv() },
      );
      expect(built.exitCode === 0, `bun build of the CLI failed: ${built.stderr.slice(-1500)}`);
      cpSync(CHAIN, join(pkg, "src/be/migrations/postgres"), { recursive: true });
      const npmTarget = await createPostgresDatabase(`chain-npm-${ctx.nonce}`);
      databases.push(npmTarget);
      const runner = Bun.which("node") ? "node" : "bun";
      const copied = await run(
        [runner, join(pkg, "dist/cli.js"), "db-copy", "--from", source.dbPath, "--to", npmTarget],
        work,
        { ...minimalEnv(), HOME: work, DESPLEGA_TELEMETRY_ENV: "test" },
      );
      expect(
        copied.exitCode === 0 && copied.stdout.includes("every count and checksum equal"),
        `db-copy from the npm layout (${runner}) exited ${copied.exitCode}: ${copied.stderr.slice(-1500)}${copied.stdout.slice(-800)}`,
      );

      // API image layout.
      const image = join(work, "image");
      mkdirSync(image, { recursive: true });
      const binary = join(image, "agent-swarm-api");
      const compiled = await run(
        ["bun", "build", ...dockerfileCompileEntrypoints(), "--compile", `--outfile=${binary}`],
        repoRoot,
        { ...minimalEnv() },
      );
      expect(
        compiled.exitCode === 0,
        `bun build --compile failed: ${compiled.stderr.slice(-1500)}`,
      );
      const layout = replicateDockerfileCopies(image);
      expect(
        existsSync(join(layout.migrationsDir, "postgres")),
        `the Dockerfile runtime stage copies no Postgres chain to $MIGRATIONS_DIR/postgres (${layout.migrationsDir})`,
      );

      // `db-copy` through the compiled API binary: the cutover runs in the API image.
      // A binary that boots the API instead never exits: the timeout fails it.
      const copyEnv = {
        ...minimalEnv(),
        HOME: work,
        DESPLEGA_TELEMETRY_ENV: "test",
        MIGRATIONS_DIR: layout.migrationsDir,
        DATABASE_PATH: join(image, "unused.sqlite"),
        PORT: String(await freePort()),
      };
      const help = await run([binary, "db-copy", "--help"], image, copyEnv, 60_000);
      expect(
        help.exitCode === 0 && help.stdout.includes("db-copy --from <sqlite file>"),
        `agent-swarm-api db-copy --help printed no db-copy usage (exit ${help.exitCode}; a booted API stops only at the timeout): ${help.stderr.slice(-800)}${help.stdout.slice(-800)}`,
      );
      const noTarget = await run(
        [binary, "db-copy", "--from", source.dbPath],
        image,
        copyEnv,
        60_000,
      );
      expect(
        noTarget.exitCode === 2 && noTarget.stderr.includes("db-copy needs the target"),
        `agent-swarm-api db-copy without a target exited ${noTarget.exitCode}, not 2: ${noTarget.stderr.slice(-800)}${noTarget.stdout.slice(-800)}`,
      );
      const binaryTarget = await createPostgresDatabase(`chain-bin-${ctx.nonce}`);
      databases.push(binaryTarget);
      const binaryCopy = await run(
        [binary, "db-copy", "--from", source.dbPath, "--to", binaryTarget],
        image,
        copyEnv,
        300_000,
      );
      expect(
        binaryCopy.exitCode === 0 &&
          binaryCopy.stdout.includes("every count and checksum equal") &&
          !binaryCopy.stdout.includes("MCP HTTP server running"),
        `agent-swarm-api db-copy exited ${binaryCopy.exitCode}: ${binaryCopy.stderr.slice(-1500)}${binaryCopy.stdout.slice(-800)}`,
      );
      expect(
        !existsSync(copyEnv.DATABASE_PATH),
        "agent-swarm-api db-copy opened DATABASE_PATH: it booted the API",
      );
      const imageTarget = await createPostgresDatabase(`chain-img-${ctx.nonce}`);
      databases.push(imageTarget);
      const port = await freePort();
      const env: Record<string, string> = {
        ...source.env,
        PORT: String(port),
        DATABASE_URL: imageTarget,
        DATABASE_PATH: join(image, "unused.sqlite"),
        MIGRATIONS_DIR: layout.migrationsDir,
      };
      delete env.DATABASE_QUERY_URL;
      api = Bun.spawn([join(image, "agent-swarm-api")], {
        cwd: image,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = Promise.all([
        new Response(api.stdout as ReadableStream).text(),
        new Response(api.stderr as ReadableStream).text(),
      ]);
      const deadline = Date.now() + 90_000;
      let healthy = false;
      while (!healthy && Date.now() < deadline && api.exitCode === null) {
        healthy = await fetch(`http://127.0.0.1:${port}/health`)
          .then((r) => r.status === 200)
          .catch(() => false);
        if (!healthy) await Bun.sleep(250);
      }
      if (!healthy) {
        api.kill("SIGKILL");
        const [stdout, stderr] = await output;
        throw new Error(
          `the compiled API never answered /health on DATABASE_URL: ${stderr.slice(-1500)}${stdout.slice(-1500)}`,
        );
      }
      const agents = await createApiClient(`http://127.0.0.1:${port}`, source.apiKey)(
        "GET",
        "/api/agents",
      );
      expectStatus(agents, [200], "GET /api/agents on the compiled API");
    } finally {
      if (api && api.exitCode === null) {
        api.kill("SIGTERM");
        await Promise.race([api.exited, Bun.sleep(10_000)]);
        if (api.exitCode === null) api.kill("SIGKILL");
      }
      for (const url of databases) await dropPostgresDatabase(url).catch(() => {});
      await stopSut(source, false);
      rmSync(work, { recursive: true, force: true });
    }
  },
};
