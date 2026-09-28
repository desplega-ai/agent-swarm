import { describe, expect, test } from "bun:test";
import { generateCompose } from "../commands/onboard/compose-generator.ts";
import {
  type CommandResult,
  type CommandRunner,
  composeCommandText,
  engineForCommands,
  isContainerEnginePreference,
  resolveContainerEngine,
} from "../commands/onboard/container-engine.ts";
import { INITIAL_STATE } from "../commands/onboard/types.ts";

const ok = (stdout: string, stderr = ""): CommandResult => ({ exitCode: 0, stdout, stderr });
const missing: CommandResult = { exitCode: 127, stdout: "", stderr: "not found" };

/** Mocked runner keyed by the joined argv; unknown commands behave like a missing binary. */
function mockRunner(responses: Record<string, CommandResult>): CommandRunner & {
  calls: string[];
} {
  const calls: string[] = [];
  const run = async (argv: string[]) => {
    const key = argv.join(" ");
    calls.push(key);
    return responses[key] ?? missing;
  };
  return Object.assign(run, { calls });
}

const DOCKER = {
  "docker --version": ok("Docker version 27.3.1, build ce12230\n"),
  "docker compose version": ok("Docker Compose version v2.29.7\n"),
};
const PODMAN = {
  "podman --version": ok("podman version 5.2.3\n"),
  "podman compose version": ok(
    "docker-compose version 2.29.7\n",
    ">>>> Executing external compose provider ...\n",
  ),
};
const PODMAN_NO_PROVIDER = {
  "podman --version": ok("podman version 5.2.3\n"),
  "podman compose version": {
    exitCode: 125,
    stdout: "",
    stderr:
      'Error: looking up compose provider failed\n7 errors occurred:\n\t* exec: "docker-compose": executable file not found in $PATH\n',
  },
};

describe("resolveContainerEngine", () => {
  test("auto keeps Docker when both engines are installed", async () => {
    const run = mockRunner({ ...DOCKER, ...PODMAN });
    const result = await resolveContainerEngine("auto", run);
    expect(result.ok).toBe(true);
    expect(result.engine).toBe("docker");
    expect(run.calls.some((c) => c.startsWith("podman"))).toBe(false);
  });

  test("auto falls back to Podman when Docker is absent", async () => {
    const result = await resolveContainerEngine("auto", mockRunner(PODMAN));
    expect(result.ok).toBe(true);
    expect(result.engine).toBe("podman");
    if (result.ok) {
      expect(result.probe.binary.version).toBe("podman version 5.2.3");
      expect(result.probe.compose.version).toBe("docker-compose version 2.29.7");
    }
  });

  test("auto reports a broken Docker Compose as a Docker failure, without trying Podman", async () => {
    const run = mockRunner({ "docker --version": DOCKER["docker --version"], ...PODMAN });
    const result = await resolveContainerEngine("auto", run);
    expect(result.ok).toBe(false);
    expect(result.engine).toBe("docker");
    if (!result.ok) expect(result.error).toBe("Docker Compose v2 not found");
    expect(run.calls.some((c) => c.startsWith("podman"))).toBe(false);
  });

  test("auto fails clearly when neither engine exists", async () => {
    const result = await resolveContainerEngine("auto", mockRunner({}));
    expect(result.ok).toBe(false);
    expect(result.engine).toBeNull();
    if (!result.ok) expect(result.error).toBe("Neither Docker nor Podman was found");
  });

  test("explicit docker succeeds with Docker and Compose v2", async () => {
    const result = await resolveContainerEngine("docker", mockRunner(DOCKER));
    expect(result.ok).toBe(true);
    expect(result.engine).toBe("docker");
  });

  test("explicit docker fails when Docker is missing, even if Podman works", async () => {
    const run = mockRunner(PODMAN);
    const result = await resolveContainerEngine("docker", run);
    expect(result.ok).toBe(false);
    expect(result.engine).toBe("docker");
    if (!result.ok) {
      expect(result.error).toBe("Docker not found");
      expect(result.probe?.binary.hint).toContain("docs.docker.com");
    }
    expect(run.calls).toEqual(["docker --version"]);
  });

  test("explicit podman succeeds with a Compose provider", async () => {
    const result = await resolveContainerEngine("podman", mockRunner(PODMAN));
    expect(result.ok).toBe(true);
    expect(result.engine).toBe("podman");
  });

  test("explicit podman fails when Podman is missing, even if Docker works", async () => {
    const run = mockRunner(DOCKER);
    const result = await resolveContainerEngine("podman", run);
    expect(result.ok).toBe(false);
    expect(result.engine).toBe("podman");
    if (!result.ok) {
      expect(result.error).toBe("Podman not found");
      expect(result.probe?.binary.hint).toContain("podman.io");
    }
    expect(run.calls).toEqual(["podman --version"]);
  });

  test("explicit podman without a Compose provider prints a provider diagnostic", async () => {
    const result = await resolveContainerEngine("podman", mockRunner(PODMAN_NO_PROVIDER));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("podman compose has no working Compose provider");
      expect(result.error).toContain("looking up compose provider failed");
      expect(result.probe?.compose.hint).toContain("podman-compose");
      expect(result.probe?.compose.hint).toContain("PODMAN_COMPOSE_PROVIDER");
    }
  });

  test("a binary that exits non-zero is reported distinctly from a missing one", async () => {
    const result = await resolveContainerEngine(
      "podman",
      mockRunner({ "podman --version": { exitCode: 1, stdout: "", stderr: "boom" } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Podman exited with non-zero status");
  });
});

describe("container engine helpers", () => {
  test("validates preferences", () => {
    expect(isContainerEnginePreference("auto")).toBe(true);
    expect(isContainerEnginePreference("docker")).toBe(true);
    expect(isContainerEnginePreference("podman")).toBe(true);
    expect(isContainerEnginePreference("nerdctl")).toBe(false);
    expect(isContainerEnginePreference("")).toBe(false);
  });

  test("auto renders commands as Docker", () => {
    expect(engineForCommands("auto")).toBe("docker");
    expect(composeCommandText(engineForCommands("podman"), "logs -f")).toBe(
      "podman compose logs -f",
    );
  });
});

describe("generateCompose engine output", () => {
  const bedrockState = {
    ...INITIAL_STATE,
    services: [{ template: "official/worker", displayName: "Worker", count: 1, role: "worker" }],
    agentIds: { "worker-worker": "00000000-0000-4000-8000-000000000001" },
    provider: "bedrock" as const,
    harness: "pi" as const,
    awsRegion: "us-east-1",
    awsProfile: "default",
  };

  test("Docker output is unchanged: docker usage line, plain :ro AWS mount", () => {
    const yaml = generateCompose(bedrockState);
    expect(yaml).toContain("#   docker compose --env-file .env up -d");
    expect(yaml).toContain("/home/worker/.aws:ro\n");
    expect(yaml).not.toContain(":ro,z");
  });

  test("Podman output uses podman compose and a shared SELinux label on the AWS mount", () => {
    const yaml = generateCompose({ ...bedrockState, containerEngine: "podman" });
    expect(yaml).toContain("# Podman Compose for Agent Swarm");
    expect(yaml).toContain("#   podman compose --env-file .env up -d");
    expect(yaml).toContain("/home/worker/.aws:ro,z\n");
  });
});
