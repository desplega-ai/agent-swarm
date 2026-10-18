import { parseGhPrCommands, readGhPrBodyFiles, shellCommandOf } from "./pr-body-guard";

export type PrRoomGuardDeps = {
  env: Record<string, string | undefined>;
  readFile: (path: string) => Promise<string>;
  remoteOrigin: (cwd: string) => Promise<string>;
};

const BLOCK_REASON =
  'This repo uses PR rooms. Create the room first with the pr-room skill (app action createRoom). Then pass the returned prBody with --body-file. The body must contain the line "PR room: prr-...".';
const ROOM_LINE = /^PR room: prr-[a-z2-7]{10}\b/m;

const defaultDeps = (): PrRoomGuardDeps => ({
  env: process.env,
  readFile: (path) => Bun.file(path).text(),
  remoteOrigin: async (cwd) => {
    const proc = Bun.spawn(["git", "-C", cwd, "config", "--get", "remote.origin.url"], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) throw new Error("Cannot resolve checkout remote");
    return out.trim();
  },
});

/** Extract owner/repo from an HTTPS, SSH URL, or SCP-style SSH remote. */
function repoFromRemote(remote: string): string | undefined {
  const match =
    /^(?:https?:\/\/[^/]+\/|ssh:\/\/[^/]+\/|[^\s/@:]+@[^\s/:]+:)([^/\s]+)\/([^/\s]+?)\/?$/.exec(
      remote.trim(),
    );
  return match ? `${match[1]}/${match[2]?.replace(/\.git$/, "")}`.toLowerCase() : undefined;
}

/** Require a room marker for configured repositories. Unresolved inputs allow the command. */
export async function guardGhPrRoom(
  toolInput: unknown,
  cwd: string,
  deps: PrRoomGuardDeps = defaultDeps(),
): Promise<string | null> {
  try {
    const repos = new Set(
      (deps.env.PR_ROOM_REPOS ?? "")
        .split(",")
        .map((repo) => repo.trim().toLowerCase())
        .filter(Boolean),
    );
    if (repos.size === 0) return null;
    const command = shellCommandOf(toolInput);
    if (command === null) return null;
    for (const call of parseGhPrCommands(command, cwd, deps.env)) {
      if (call.action !== "create" || call.unknownTarget || call.cwd === null) continue;
      const targets = call.resolvedRepos;
      if (targets.some((repo) => repo === null)) continue;
      if (targets.length === 0 || call.alsoCheckout) {
        try {
          const repo = repoFromRemote(await deps.remoteOrigin(call.cwd));
          if (!repo) continue;
          targets.push(repo);
        } catch {
          continue;
        }
      }
      if (!targets.some((repo) => repo !== null && repos.has(repo.trim().toLowerCase()))) continue;
      const body = await readGhPrBodyFiles(call, deps.readFile);
      if (body.unreadable !== undefined) continue;
      if (!call.opaqueBody && call.bodyTexts.some((text) => text === null)) continue;
      const texts = [
        ...call.bodyTexts.filter((text): text is string => text !== null),
        ...body.texts,
        ...(call.opaqueBody ? [command] : []),
      ];
      if (!texts.some((text) => ROOM_LINE.test(text))) return BLOCK_REASON;
    }
  } catch {
    // A workflow reminder must not prevent commands when resolution fails.
  }
  return null;
}
