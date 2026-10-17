import type { Bash, IFileSystem } from "just-bash";
import { placeholderForConfigKey } from "./credential-broker";
import type { ScriptAgentFsDescriptor } from "./executors/types";
import { ScratchFs } from "./scratch-fs";

/**
 * `ctx.fs` and `ctx.sh`: one virtual filesystem per script run, plus a
 * just-bash shell over it. just-bash reimplements the shell and its commands
 * (grep, sed, awk, jq, ...) in TypeScript, so nothing here spawns a process.
 *
 *   /afs   the invoking agent's default agent-fs drive (only when configured)
 *   /...   everything else is in-memory scratch that dies with the run
 *
 * Both executors run this on the host side: native inside the harness
 * subprocess, quickjs in the worker thread behind `__host_call`. This code
 * never holds the agent-fs key: requests carry the credential-broker
 * placeholder, and the patched fetch swaps in the agent's own key for the
 * agent-fs host. That keeps the key out of this code and its errors. It is not
 * a confinement boundary: a script can already read its agent's config
 * secrets, this key included, through `ctx.swarm.config.get`.
 */

export const AGENT_FS_MOUNT = "/afs";
/** Agent-scoped config key that holds the agent's own agent-fs API key. */
export const AGENT_FS_API_KEY_CONFIG = "AGENT_FS_API_KEY";
/**
 * Bytes that one run's scratch files may hold, that one `ctx.sh` command may
 * read, keep live or print, and that one agent-fs response may carry. Under
 * quickjs this code runs in the API process, outside the QuickJS heap limit,
 * so just-bash's own defaults (1 GiB of scratch, 512 MiB per command) are too
 * high.
 */
export const SCRIPT_FS_MAX_BYTES = 64 * 1024 * 1024;

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

function notConfigured(path: string): Error {
  return new Error(
    `ENOENT: ${path}: agent-fs is not configured for this agent (needs AGENT_FS_API_URL, AGENT_FS_DEFAULT_ORG_ID, AGENT_FS_DEFAULT_DRIVE_ID and an agent AGENT_FS_API_KEY)`,
  );
}

/** A scratch symlink, or a scratch cp / mv, cannot reach the drive: InMemoryFs would keep the file. */
function crossDevice(path: string): Error {
  return new Error(
    `EXDEV: cross-device link not permitted, '${path}' resolves into the agent-fs drive at ${AGENT_FS_MOUNT}; use an ${AGENT_FS_MOUNT} path`,
  );
}

/**
 * Fails an agent-fs response body once it passes SCRIPT_FS_MAX_BYTES. The
 * adapter buffers whole bodies (`arrayBuffer()`, `text()`) for reads, shell
 * tools, and `appendFile`, so neither the scratch quota nor the shell limits
 * bound that buffer. The body errors instead of fetch throwing, because the
 * adapter reports a fetch error as an unreachable daemon.
 */
function limitBody(response: Response): Response {
  if (!response.body) return response;
  const tooLarge = () =>
    new Error(`EFBIG: agent-fs response exceeds the ${SCRIPT_FS_MAX_BYTES}-byte script limit`);
  const declared = Number(response.headers.get("content-length"));
  let received = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        if (declared > SCRIPT_FS_MAX_BYTES) controller.error(tooLarge());
      },
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > SCRIPT_FS_MAX_BYTES) controller.error(tooLarge());
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function openSession(agentFs: ScriptAgentFsDescriptor | undefined): Promise<Session> {
  // Loaded on first use, so runs that never touch ctx.fs / ctx.sh skip the import.
  const { Bash, InMemoryFs, MountableFs } = await import("just-bash");
  // just-bash writes its default layout (/bin, /usr, /dev, /proc) into the base
  // filesystem, so the base must be scratch memory and never the drive. The
  // base reserves /afs, so `ctx.sh` cannot put a file there that looks
  // persistent and dies with the run.
  const scratch = new InMemoryFs(undefined, { maxTotalBytes: SCRIPT_FS_MAX_BYTES });
  const fs = new MountableFs({
    base: new ScratchFs(scratch, {
      path: AGENT_FS_MOUNT,
      error: agentFs ? crossDevice : notConfigured,
    }),
  });
  if (agentFs) {
    const { AgentFsFileSystem } = await import("@desplega.ai/agent-fs-just-bash");
    const drive = new AgentFsFileSystem({
      baseUrl: agentFs.apiUrl,
      apiKey: placeholderForConfigKey(AGENT_FS_API_KEY_CONFIG),
      orgId: agentFs.orgId,
      driveId: agentFs.driveId,
      // Late-bound: each executor patches (and quickjs scopes per run) the global fetch.
      fetch: async (input, init) => limitBody(await globalThis.fetch(input, init)),
      writeMessage: (operation, path) => `swarm script: ${operation} ${path}`,
    });
    fs.mount(AGENT_FS_MOUNT, drive);
  }
  const bash = new Bash({
    fs,
    cwd: agentFs ? AGENT_FS_MOUNT : "/",
    executionLimits: {
      maxInputBytes: SCRIPT_FS_MAX_BYTES,
      maxLiveBytes: SCRIPT_FS_MAX_BYTES,
      maxOutputSize: SCRIPT_FS_MAX_BYTES,
      maxStringLength: SCRIPT_FS_MAX_BYTES,
    },
  });
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
  // Resolves a script path against the session filesystem. MountableFs
  // normalizes it, and without agent-fs ScratchFs rejects /afs with the reason.
  const at = async (path: string) => ({ fs: (await session()).fs, path: resolve(path) });

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
      const target = await at(path);
      return target.fs.exists(target.path);
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
    try {
      const result = await bash.exec(String(command), {
        ...(options.cwd ? { cwd: resolve(options.cwd) } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.stdin !== undefined ? { stdin: String(options.stdin) } : {}),
        ...(signal ? { signal } : {}),
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    } catch (error) {
      // just-bash rethrows a filesystem error from a redirect (an unconfigured
      // /afs, ENOSPC). Report it as a failed command, as bash does.
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return { stdout: "", stderr: `bash: ${message}\n`, exitCode: 1 };
    }
  };

  return { fs, sh };
}
