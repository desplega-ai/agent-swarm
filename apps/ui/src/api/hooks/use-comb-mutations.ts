import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { agentFsKey, useAgentFsAccess } from "@/api/hooks/use-agent-fs";
import { type AgentFsClient, AgentFsError } from "@/lib/agent-fs/client";
import { joinComb, KEEP_FILE, starterContent } from "@/lib/comb/file-names";

type Drive = { orgId: string; driveId: string };

/** A write that the drive refused or that found the name taken, said plainly. */
export function mutationMessage(error: unknown): string {
  if (error instanceof AgentFsError) {
    if (error.status === 403) return "You can only read this drive.";
    if (error.status === 409) return error.message || "Something already exists there.";
    // A server error can name storage internals (local paths): keep it out of the dialog.
    if (error.status >= 500) return "agent-fs could not save it. Try again.";
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

function alreadyExists(path: string): AgentFsError {
  return new AgentFsError(409, "EDIT_CONFLICT", `Something already exists at ${path}.`);
}

/**
 * Comb's write actions on one drive, through the same ops as the agent-fs
 * live UI (`live/src/hooks/use-file-mutations.ts`): `write`, `mv`, `rm`.
 * Each one refetches the drive's queries (listings, stat, favorites).
 * Paths are Comb paths ("/docs/a.md").
 */
export function useCombMutations(drive: Drive) {
  const access = useAgentFsAccess();
  const queryClient = useQueryClient();
  const { orgId, driveId } = drive;

  const client = useCallback((): AgentFsClient => {
    if (!access.client) throw new Error("Comb is not connected to agent-fs.");
    return access.client;
  }, [access.client]);

  const refresh = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: agentFsKey(access.endpoint, access.userId, orgId, driveId),
      }),
    [queryClient, access.endpoint, access.userId, orgId, driveId],
  );

  /** True when something is stored at `path`. Only a 404 counts as free. */
  const exists = useCallback(
    async (path: string): Promise<boolean> => {
      try {
        await client().callOp(orgId, "stat", { path }, driveId);
        return true;
      } catch (error) {
        if (error instanceof AgentFsError && error.status === 404) return false;
        throw error;
      }
    },
    [client, orgId, driveId],
  );

  /**
   * Create-only write, as the live UI does it: refuse a taken path, write
   * with `expectedVersion: 0`, and on a conflict (a deleted path keeps its
   * version rows) write again only if the path is still free.
   */
  const writeCreateOnly = useCallback(
    async (path: string, content: string, message: string) => {
      if (await exists(path)) throw alreadyExists(path);
      try {
        await client().callOp(
          orgId,
          "write",
          { path, content, expectedVersion: 0, message },
          driveId,
        );
      } catch (error) {
        if (!(error instanceof AgentFsError && error.status === 409)) throw error;
        if (await exists(path)) throw alreadyExists(path);
        await client().callOp(orgId, "write", { path, content, message }, driveId);
      }
    },
    [client, exists, orgId, driveId],
  );

  /**
   * A file in the way of a new path: `relative` goes through folders that
   * are files ("plan.md/x.md" where "plan.md" is a file). `stat` finds files
   * only, so any hit is a file.
   */
  const assertFoldersFree = useCallback(
    async (folder: string, relative: string, includeLast: boolean) => {
      const segments = relative.split("/");
      const count = includeLast ? segments.length : segments.length - 1;
      for (let index = 1; index <= count; index++) {
        const path = joinComb(folder, segments.slice(0, index).join("/"));
        if (await exists(path)) throw alreadyExists(path);
      }
    },
    [exists],
  );

  return useMemo(
    () => ({
      exists,
      /** A new file in `folder`. Returns its Comb path. */
      createFile: async (folder: string, relative: string): Promise<string> => {
        const path = joinComb(folder, relative);
        await assertFoldersFree(folder, relative, false);
        await writeCreateOnly(path, starterContent(path), "Created in Comb");
        await refresh();
        return path;
      },
      /** A new folder in `folder` (an empty `.keep` file marks it). Returns its Comb path. */
      createFolder: async (folder: string, relative: string): Promise<string> => {
        const created = `${joinComb(folder, relative)}/`;
        await assertFoldersFree(folder, relative, true);
        await writeCreateOnly(`${created}${KEEP_FILE}`, "", "Created folder in Comb");
        await refresh();
        return created;
      },
      /**
       * Move a file (`to` is a full Comb path). agent-fs writes it as a new
       * version at `to`. The old path keeps its history and its comments.
       * Stars move with it. A taken path, or a file in the way, is refused first.
       */
      rename: async (from: string, to: string) => {
        if (await exists(to)) throw alreadyExists(to);
        await assertFoldersFree("/", to.replace(/^\/+/, ""), false);
        await client().callOp(orgId, "mv", { from, to }, driveId);
        await refresh();
      },
      /** Delete a file. Its versions are kept. agent-fs removes its comments. */
      remove: async (path: string) => {
        await client().callOp(orgId, "rm", { path }, driveId);
        await refresh();
      },
    }),
    [exists, assertFoldersFree, writeCreateOnly, refresh, client, orgId, driveId],
  );
}
