import { chmod, mkdir, readFile, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";

// A PATH of stand-ins (fixtures/deploy-stubs) so install.sh and
// deploy/one-box/bootstrap.sh run for real without Docker, root or a network.
// The fake docker records what the stack publishes; see its header.

const STUBS = resolve(import.meta.dir, "fixtures/deploy-stubs");
const NO_OPS = ["apt-get", "caddy", "systemctl", "ufw"];

export interface DeployStubs {
  /** Environment for the child: the stub PATH plus the fake docker's settings. */
  env: Record<string, string>;
  /** The fake docker's state directory. */
  state: string;
  /** Published ports of the running stack, in `docker ps` form. */
  ports(): Promise<string[]>;
  /** Every port the stack ever published. */
  history(): Promise<string[]>;
  /** Every docker invocation. */
  calls(): Promise<string[]>;
  /** One "<network> <default host address>" line per `docker compose up`. */
  ups(): Promise<string[]>;
  /** Create a project network as an earlier `up` would, with this default address ("" for none). */
  network(name: string, hostBinding: string): Promise<void>;
}

async function lines(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean);
}

export async function makeDeployStubs(
  dir: string,
  env: Record<string, string> = {},
): Promise<DeployStubs> {
  const bin = join(dir, "bin");
  const state = join(dir, "docker-state");
  await mkdir(bin, { recursive: true });
  await mkdir(state, { recursive: true });
  for (const name of ["docker", "curl", "bun", "bunx"]) {
    await symlink(join(STUBS, name), join(bin, name));
  }
  for (const name of NO_OPS) {
    await Bun.write(join(bin, name), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, name), 0o755);
  }
  // bootstrap.sh insists on root.
  await Bun.write(join(bin, "id"), "#!/bin/sh\necho 0\n");
  await chmod(join(bin, "id"), 0o755);

  return {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      FAKE_DOCKER_STATE: state,
      ...env,
    },
    state,
    ports: () => lines(join(state, "ports")),
    history: () => lines(join(state, "history")),
    calls: () => lines(join(state, "calls")),
    ups: () => lines(join(state, "ups")),
    network: async (name, hostBinding) => {
      await Bun.write(join(state, "networks", name), `${hostBinding}\n`);
    },
  };
}
