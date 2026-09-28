/**
 * Container engine selection for `agent-swarm onboard`.
 *
 * The generated stack is plain OCI images plus a Compose file, so it runs under
 * Docker Compose or under Podman with a Compose provider (`podman compose`).
 * `auto` keeps the historical behavior: Docker whenever the `docker` binary is
 * present, Podman only as a fallback.
 */

export type ContainerEngine = "docker" | "podman";
export type ContainerEnginePreference = "auto" | ContainerEngine;

export const CONTAINER_ENGINE_PREFERENCES: readonly ContainerEnginePreference[] = [
  "auto",
  "docker",
  "podman",
];

export const CONTAINER_ENGINE_LABELS: Record<ContainerEngine, string> = {
  docker: "Docker",
  podman: "Podman",
};

export const ENGINE_INSTALL_HINTS: Record<ContainerEngine, string> = {
  docker: "Install: brew install --cask docker (macOS) or https://docs.docker.com/get-docker/",
  podman: "Install: https://podman.io/docs/installation",
};

export const PODMAN_COMPOSE_PROVIDER_HINT =
  "`podman compose` needs an external Compose provider. Install podman-compose (dnf/apt install podman-compose, or pipx install podman-compose) or docker-compose v2, or point PODMAN_COMPOSE_PROVIDER at one. See https://docs.agent-swarm.dev/docs/guides/podman-rootless";

export function isContainerEnginePreference(value: string): value is ContainerEnginePreference {
  return (CONTAINER_ENGINE_PREFERENCES as readonly string[]).includes(value);
}

/**
 * Engine to use for commands and generated instructions when detection has not
 * run yet. `auto` renders as Docker, matching its preference order.
 */
export function engineForCommands(preference: ContainerEnginePreference): ContainerEngine {
  return preference === "podman" ? "podman" : "docker";
}

/** `docker compose <args>` / `podman compose <args>` as an argv array. */
export function composeArgv(engine: ContainerEngine, args: string[]): string[] {
  return [engine, "compose", ...args];
}

/** Human-readable compose command for logs and printed instructions. */
export function composeCommandText(engine: ContainerEngine, args: string): string {
  return `${engine} compose ${args}`;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (argv: string[], options?: { cwd?: string }) => Promise<CommandResult>;

/** Runs a command without throwing. A binary that cannot be spawned reports exit code 127. */
export const defaultCommandRunner: CommandRunner = async (argv, options) => {
  try {
    const proc = Bun.spawn(argv, {
      cwd: options?.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (err) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
};

export interface EngineCheck {
  ok: boolean;
  version?: string;
  error?: string;
  hint?: string;
}

export interface EngineProbe {
  engine: ContainerEngine;
  binary: EngineCheck;
  compose: EngineCheck;
}

export type EngineResolution =
  | { ok: true; engine: ContainerEngine; probe: EngineProbe }
  | { ok: false; engine: ContainerEngine | null; error: string; probe: EngineProbe | null };

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

async function checkBinary(engine: ContainerEngine, run: CommandRunner): Promise<EngineCheck> {
  const label = CONTAINER_ENGINE_LABELS[engine];
  const result = await run([engine, "--version"]);
  if (result.exitCode === 0) return { ok: true, version: firstLine(result.stdout) };
  return {
    ok: false,
    error: result.exitCode === 127 ? `${label} not found` : `${label} exited with non-zero status`,
    hint: ENGINE_INSTALL_HINTS[engine],
  };
}

async function checkCompose(engine: ContainerEngine, run: CommandRunner): Promise<EngineCheck> {
  const result = await run(composeArgv(engine, ["version"]));
  if (result.exitCode === 0) {
    // `podman compose` prints its provider banner on stderr; the version is on stdout.
    return { ok: true, version: firstLine(result.stdout) || firstLine(result.stderr) };
  }
  if (engine === "podman") {
    const detail = firstLine(result.stderr) || firstLine(result.stdout);
    return {
      ok: false,
      error: `podman compose has no working Compose provider${detail ? ` (${detail})` : ""}`,
      hint: PODMAN_COMPOSE_PROVIDER_HINT,
    };
  }
  return {
    ok: false,
    error: "Docker Compose v2 not found",
    hint: "Install the Compose v2 plugin: https://docs.docker.com/compose/install/",
  };
}

/** Check one engine: the binary first, then its Compose subcommand. */
export async function probeEngine(
  engine: ContainerEngine,
  run: CommandRunner = defaultCommandRunner,
): Promise<EngineProbe> {
  const binary = await checkBinary(engine, run);
  if (!binary.ok) {
    return { engine, binary, compose: { ok: false, error: "skipped: engine unavailable" } };
  }
  return { engine, binary, compose: await checkCompose(engine, run) };
}

function probeError(probe: EngineProbe): string {
  if (!probe.binary.ok) return probe.binary.error ?? "engine unavailable";
  return probe.compose.error ?? "Compose unavailable";
}

/**
 * Resolve the engine to use. An explicit choice never falls back to the other
 * engine. `auto` picks Docker whenever the `docker` binary exists (so a broken
 * Docker Compose still reports as a Docker problem, as before) and only tries
 * Podman when Docker is absent.
 */
export async function resolveContainerEngine(
  preference: ContainerEnginePreference,
  run: CommandRunner = defaultCommandRunner,
): Promise<EngineResolution> {
  if (preference !== "auto") {
    const probe = await probeEngine(preference, run);
    if (probe.binary.ok && probe.compose.ok) return { ok: true, engine: preference, probe };
    return { ok: false, engine: preference, error: probeError(probe), probe };
  }

  const docker = await probeEngine("docker", run);
  if (docker.binary.ok) {
    if (docker.compose.ok) return { ok: true, engine: "docker", probe: docker };
    return { ok: false, engine: "docker", error: probeError(docker), probe: docker };
  }

  const podman = await probeEngine("podman", run);
  if (podman.binary.ok) {
    if (podman.compose.ok) return { ok: true, engine: "podman", probe: podman };
    return { ok: false, engine: "podman", error: probeError(podman), probe: podman };
  }

  return {
    ok: false,
    engine: null,
    error: "Neither Docker nor Podman was found",
    probe: docker,
  };
}
