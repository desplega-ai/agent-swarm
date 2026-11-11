import { randomBytes } from "node:crypto";
import { minimalEnv, repoRoot } from "./sut";

/**
 * The CLI as a black box: `bun run src/cli.tsx <command> <args>` in a child process with its
 * own temp HOME and working directory. The strict gate counts a command covered when a
 * scenario ran it with anything but `--help`, so a help page never stands in for a run.
 */
export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The child's working directory: read the files the command wrote from here. */
  cwd: string;
  home: string;
  durationMs: number;
};

export type CliOptions = {
  /** Extra env on top of PATH, TMPDIR, LANG, a temp HOME and NO_COLOR. */
  env?: Record<string, string>;
  /** Written to the child's stdin, then closed. Default: no stdin. */
  stdin?: string;
  /** Reuse a working directory (a second command on the files the first wrote). */
  cwd?: string;
  home?: string;
  timeoutMs?: number;
  /**
   * For a command that serves until stopped (`api`): runs while the child does, then the
   * child gets SIGTERM. Its error fails the run after the child is stopped.
   */
  whileRunning?: () => Promise<void>;
};

const calledCommands = new Set<string>();
let coverageDir: string | undefined;
let coverageRuns = 0;

/** `--coverage`: each CLI child writes `<dir>/cli-<stamp>/lcov.info`, like each API process. */
export function setCliCoverageDir(dir: string | undefined): void {
  coverageDir = dir;
}

export function calledCliCommands(): ReadonlySet<string> {
  return calledCommands;
}

/** The command a run covers: the first argument, unless the run only asked for help. */
export function commandOf(args: readonly string[]): string | undefined {
  const [first] = args;
  if (!first || first.startsWith("-")) return undefined;
  if (args.includes("--help") || args.includes("-h")) return undefined;
  return first;
}

const tempDirs = new Set<string>();

async function tempDir(kind: string): Promise<string> {
  const path = `/tmp/e2e-cli-${kind}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  await Bun.$`mkdir -p ${path}`.quiet();
  tempDirs.add(path);
  return path;
}

/** Delete every temp HOME and working directory the CLI runs made, or list them with keep. */
export async function cleanupCliTemp(keep: boolean): Promise<void> {
  for (const path of tempDirs) {
    if (keep) console.log(`KEEP CLI dir: ${path}`);
    else await Bun.$`rm -rf ${path}`.quiet().nothrow();
  }
  tempDirs.clear();
}

async function coverageCommand(args: readonly string[], cwd: string) {
  const name = `cli-${Date.now()}-${++coverageRuns}`;
  const configPath = `/tmp/e2e-${name}.toml`;
  await Bun.write(
    configPath,
    [
      "[test]",
      "coverage = true",
      'coverageReporter = ["lcov"]',
      `coverageDir = ${JSON.stringify(`${coverageDir}/${name}`)}`,
      'coveragePathIgnorePatterns = ["scripts/**", "node_modules/**"]',
      "",
    ].join("\n"),
  );
  const exitFile = `/tmp/e2e-${name}.exit`;
  return {
    command: [`--config=${configPath}`, "test", "./scripts/e2e/coverage-cli.ts"],
    cwd: repoRoot,
    env: { E2E_CLI_ARGV: JSON.stringify(args), E2E_CLI_CWD: cwd, E2E_CLI_EXIT_FILE: exitFile },
    exitFile,
    temp: [configPath, exitFile],
  };
}

/**
 * Run the CLI once. Never throws on a non-zero exit: scenarios assert on `exitCode`.
 * Throws when the child outlives `timeoutMs` (it is killed first).
 */
export async function runCli(args: string[], options: CliOptions = {}): Promise<CliResult> {
  const cwd = options.cwd ?? (await tempDir("cwd"));
  const home = options.home ?? (await tempDir("home"));
  const command = commandOf(args);
  if (command) calledCommands.add(command);
  const base = { ...minimalEnv(), HOME: home, NO_COLOR: "1", ...options.env };
  const wrapped = coverageDir ? await coverageCommand(args, cwd) : undefined;
  const started = Date.now();
  const child = Bun.spawn(
    [
      "bun",
      "--no-orphans",
      ...(wrapped ? wrapped.command : ["run", `${repoRoot}/src/cli.tsx`, ...args]),
    ],
    {
      cwd: wrapped?.cwd ?? cwd,
      env: { ...base, ...wrapped?.env },
      stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs ?? 60_000);
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  let duringError: unknown;
  if (options.whileRunning) {
    try {
      await options.whileRunning();
    } catch (error) {
      duringError = error;
    }
    child.kill("SIGTERM");
  }
  const [rawStdout, stderr] = await output;
  // Under --coverage the child is `bun test`, which prints its own banner first.
  const stdout = wrapped ? rawStdout.replace(/^bun test v\S+ \([0-9a-f]+\)\n/, "") : rawStdout;
  let exitCode = await child.exited;
  clearTimeout(timer);
  if (wrapped) {
    // The wrapper's own exit says only whether the test ran; the CLI's code is in the file.
    const recorded = await Bun.file(wrapped.exitFile)
      .text()
      .catch(() => "");
    exitCode = recorded.trim() === "" ? 1 : Number(recorded.trim());
    for (const path of wrapped.temp) await Bun.$`rm -f ${path}`.quiet().nothrow();
  }
  if (timedOut) {
    throw new Error(
      `CLI ${args.join(" ")} did not exit within ${options.timeoutMs ?? 60_000} ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  if (duringError) {
    const message = duringError instanceof Error ? duringError.message : String(duringError);
    throw new Error(`${message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return { exitCode, stdout, stderr, cwd, home, durationMs: Date.now() - started };
}

/** The command list `cli help` prints: the CLI surface the strict gate holds scenarios to. */
export async function fetchCliUniverse(): Promise<string[]> {
  const child = Bun.spawn(["bun", "--no-orphans", "run", `${repoRoot}/src/cli.tsx`, "help"], {
    cwd: await tempDir("cwd"),
    env: { ...minimalEnv(), NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error("`cli help` exited non-zero");
  return parseHelpCommands(stdout);
}

export function parseHelpCommands(helpText: string): string[] {
  const start = helpText.indexOf("Commands:");
  if (start < 0) throw new Error("`cli help` printed no Commands: list");
  const commands: string[] = [];
  for (const line of helpText.slice(start).split("\n").slice(1)) {
    const match = /^ {2}([a-z][a-z0-9-]*)\s/.exec(line);
    if (!match) {
      if (commands.length > 0 && line.trim() === "") break;
      continue;
    }
    commands.push(match[1]!);
  }
  if (commands.length === 0) throw new Error("`cli help` listed no commands");
  return commands.sort();
}
