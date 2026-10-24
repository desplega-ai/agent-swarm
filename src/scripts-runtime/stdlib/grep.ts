export type GrepMatch = {
  path: string;
  line: number;
  text: string;
};

function spawnDeniedError(error: unknown): Error | undefined {
  if ((error as { code?: unknown } | null)?.code !== "EPERM") return undefined;
  return new Error(
    "stdlib.grep cannot start rg: the native script sandbox's exec-deny filter blocks starting programs. An operator can set SCRIPT_NATIVE_EXEC_DENY=false to allow it.",
    { cause: error },
  );
}

function spawnRg(pattern: string, cwd: string) {
  try {
    return Bun.spawn(["rg", "--line-number", "--no-heading", pattern, "."], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw spawnDeniedError(error) ?? error;
  }
}

export async function grep(pattern: string, cwd = process.cwd()): Promise<GrepMatch[]> {
  const proc = spawnRg(pattern, cwd);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode === 1) return [];
  if (exitCode !== 0) {
    const message = stderr.includes("No such file or directory")
      ? "rg is not available on PATH"
      : stderr.trim() || `rg exited with ${exitCode}`;
    throw new Error(message);
  }

  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [path = "", lineNo = "0", ...rest] = line.split(":");
      return { path, line: Number(lineNo), text: rest.join(":") };
    });
}
