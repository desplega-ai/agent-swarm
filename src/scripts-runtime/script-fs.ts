import type { Bash, IFileSystem } from "just-bash";
import { placeholderForConfigKey } from "./credential-broker";
import type { ScriptAgentFsDescriptor } from "./executors/types";

/**
 * `ctx.fs` and `ctx.sh`: one virtual filesystem per script run, plus a
 * just-bash shell over it. just-bash reimplements the shell and its commands
 * (grep, sed, awk, jq, ...) in TypeScript, so nothing here spawns a process.
 *
 *   /afs   the invoking agent's default agent-fs drive (only when configured)
 *   /...   everything else is in-memory scratch that dies with the run
 *
 * Both executors run this on the host side: native inside the harness
 * subprocess, quickjs in the worker thread behind `__host_call`. The agent-fs
 * key never reaches this code. Requests carry the credential-broker
 * placeholder, and the patched fetch swaps in the agent's own key for the
 * agent-fs host only.
 */

export const AGENT_FS_MOUNT = "/afs";
/** Agent-scoped config key that holds the agent's own agent-fs API key. */
export const AGENT_FS_API_KEY_CONFIG = "AGENT_FS_API_KEY";

export type ScriptFsStat = { isFile: boolean; isDirectory: boolean; size: number; mtime: string };
export type ScriptShOptions = { cwd?: string; env?: Record<string, string>; stdin?: string };
export type ScriptShResult = { stdout: string; stderr: string; exitCode: number };

export type ScriptFs = {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  appendFile(path: string, content: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<ScriptFsStat>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void>;
  mv(src: string, dest: string): Promise<void>;
};

type Session = { fs: IFileSystem; bash: Bash };

async function openSession(agentFs: ScriptAgentFsDescriptor | undefined): Promise<Session> {
  // Loaded on first use, so runs that never touch ctx.fs / ctx.sh skip the import.
  const { Bash, InMemoryFs, MountableFs } = await import("just-bash");
  // just-bash writes its default layout (/bin, /usr, /dev, /proc) into the base
  // filesystem, so the base must be scratch memory and never the drive.
  const fs = new MountableFs({ base: new InMemoryFs() });
  if (agentFs) {
    const { AgentFsFileSystem } = await import("@desplega.ai/agent-fs-just-bash");
    const drive = new AgentFsFileSystem({
      baseUrl: agentFs.apiUrl,
      apiKey: placeholderForConfigKey(AGENT_FS_API_KEY_CONFIG),
      orgId: agentFs.orgId,
      driveId: agentFs.driveId,
      // Late-bound: each executor patches (and quickjs scopes per run) the global fetch.
      fetch: (input, init) => globalThis.fetch(input, init),
      writeMessage: (operation, path) => `swarm script: ${operation} ${path}`,
    });
    // The adapter declares its own copy of just-bash's branded ByteString type.
    // The runtime value is the same latin1 string, so only the brand differs.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- see the comment above.
    fs.mount(AGENT_FS_MOUNT, drive as unknown as IFileSystem);
  }
  const bash = new Bash({ fs, cwd: agentFs ? AGENT_FS_MOUNT : "/" });
  return { fs, bash };
}

export function createScriptFs(
  agentFs: ScriptAgentFsDescriptor | undefined,
  signal?: AbortSignal,
): { fs: ScriptFs; sh: (command: string, options?: ScriptShOptions) => Promise<ScriptShResult> } {
  let opened: Promise<Session> | undefined;
  const session = () => {
    opened ??= openSession(agentFs);
    return opened;
  };
  const home = agentFs ? AGENT_FS_MOUNT : "";
  const resolve = (path: string) => {
    const text = String(path);
    return text.startsWith("/") ? text : `${home}/${text}`;
  };
  // Resolves a script path against the session filesystem. Without agent-fs,
  // /afs paths fail with the reason instead of a bare ENOENT.
  const at = async (path: string) => {
    const resolved = resolve(path);
    if (!agentFs && (resolved === AGENT_FS_MOUNT || resolved.startsWith(`${AGENT_FS_MOUNT}/`))) {
      throw new Error(
        `ENOENT: ${resolved}: agent-fs is not configured for this agent (needs AGENT_FS_API_URL, AGENT_FS_DEFAULT_ORG_ID, AGENT_FS_DEFAULT_DRIVE_ID and an agent AGENT_FS_API_KEY)`,
      );
    }
    return { fs: (await session()).fs, path: resolved };
  };

  const fs: ScriptFs = {
    readFile: async (path) => {
      const target = await at(path);
      return target.fs.readFile(target.path, "utf8");
    },
    writeFile: async (path, content) => {
      const target = await at(path);
      await target.fs.writeFile(target.path, String(content), "utf8");
    },
    appendFile: async (path, content) => {
      const target = await at(path);
      await target.fs.appendFile(target.path, String(content), "utf8");
    },
    readdir: async (path) => {
      const target = await at(path);
      return target.fs.readdir(target.path);
    },
    stat: async (path) => {
      const target = await at(path);
      const stat = await target.fs.stat(target.path);
      return {
        isFile: stat.isFile,
        isDirectory: stat.isDirectory,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      };
    },
    exists: async (path) => {
      const target = await at(path).catch(() => undefined);
      return target ? target.fs.exists(target.path) : false;
    },
    mkdir: async (path, options) => {
      const target = await at(path);
      await target.fs.mkdir(target.path, { recursive: options?.recursive ?? false });
    },
    rm: async (path, options) => {
      const target = await at(path);
      await target.fs.rm(target.path, {
        recursive: options?.recursive ?? false,
        force: options?.force ?? false,
      });
    },
    cp: async (src, dest, options) => {
      const from = await at(src);
      const to = await at(dest);
      await from.fs.cp(from.path, to.path, { recursive: options?.recursive ?? false });
    },
    mv: async (src, dest) => {
      const from = await at(src);
      const to = await at(dest);
      await from.fs.mv(from.path, to.path);
    },
  };

  const sh = async (command: string, options: ScriptShOptions = {}): Promise<ScriptShResult> => {
    const { bash } = await session();
    const result = await bash.exec(String(command), {
      ...(options.cwd ? { cwd: resolve(options.cwd) } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.stdin !== undefined ? { stdin: String(options.stdin) } : {}),
      ...(signal ? { signal } : {}),
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  };

  return { fs, sh };
}
