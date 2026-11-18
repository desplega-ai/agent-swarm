import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getInboxMessageById, getSwarmRepoById, getTaskById } from "@/be/db";
import { vcsRepoId } from "@/be/model-profile-check";
import { can } from "@/rbac";
import { getSlackApp } from "@/slack/app";
import { externalChannelToolError, getChannelBlockReason } from "@/slack/external-channel";
import {
  MAX_FILE_SIZE,
  type OpenedFile,
  openFileInside,
  type UploadFileResult,
  uploadFile,
  uploadOpenFile,
} from "@/slack/files";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

/**
 * Base directory for agent file operations.
 * All relative paths are resolved from here.
 */
const WORKSPACE_DIR = "/workspace";

function resolveTaskUploadThreadTs(
  task: Awaited<ReturnType<typeof getTaskById>>,
): string | undefined {
  if (!task) return undefined;

  if (task.slackChannelId?.startsWith("D")) {
    return task.slackTreeRootMessageTs ?? task.slackProgressMessageTs ?? task.slackThreadTs;
  }

  return task.slackThreadTs;
}

/**
 * Directories that a `filePath` upload may read from: /workspace, plus the working
 * directory of each given task that the agent runs or created (the task `dir` and
 * the clone path of its registered repo). A host-run API has no /workspace, so
 * there the task directory is the only root.
 */
async function uploadRoots(agentId: string, taskIds: (string | undefined)[]): Promise<string[]> {
  const roots = [WORKSPACE_DIR];
  for (const id of new Set(taskIds.filter((t): t is string => !!t))) {
    const task = await getTaskById(id);
    if (!task || (task.agentId !== agentId && task.creatorAgentId !== agentId)) continue;
    if (task.dir) roots.push(task.dir);
    const repoId = await vcsRepoId(task.vcsRepo);
    const repo = repoId ? await getSwarmRepoById(repoId) : null;
    if (repo) roots.push(repo.clonePath);
  }
  return roots;
}

/**
 * Opens the file that `filePath` names, read on the API server's filesystem.
 *
 * NOTE: the file is read on the API server's filesystem (where this tool
 * runs), NOT the caller's. Worker/lead containers have their own `/tmp` that
 * the API server cannot see — the only volume mounted on both is
 * `/workspace/shared/`. Files outside `/workspace/shared/` must be passed
 * inline via the `content` (base64) param instead of `filePath`.
 *
 * Candidates, in order:
 * 1. Relative paths (e.g., "shared/file.png") -> resolved from /workspace
 * 2. Absolute paths (e.g., "/workspace/shared/file.png") -> used as-is
 * 3. Absolute paths outside /workspace (e.g., "/tmp/file.png") -> also tried as
 *    /workspace/tmp/file.png
 *
 * The first candidate whose real path is a regular file inside `roots` wins.
 */
async function openUploadFile(
  filePath: string,
  roots: string[],
): Promise<
  | { success: true; file: OpenedFile; resolvedPath: string }
  | { success: false; notFound: boolean; error: string; triedPaths: string[] }
> {
  const triedPaths = filePath.startsWith("/")
    ? [
        filePath,
        ...(filePath.startsWith(`${WORKSPACE_DIR}/`) ? [] : [`${WORKSPACE_DIR}${filePath}`]),
      ]
    : [`${WORKSPACE_DIR}/${filePath}`];
  let refusal: string | undefined;
  for (const candidate of triedPaths) {
    const opened = await openFileInside(candidate, roots);
    if (opened.success) return { success: true, file: opened.file, resolvedPath: candidate };
    if (!opened.notFound) refusal ??= opened.error;
  }
  if (refusal) return { success: false, notFound: false, error: refusal, triedPaths };
  return {
    success: false,
    notFound: true,
    error: filePath.startsWith("/")
      ? "File not found at any of the attempted locations."
      : `File not found. Relative paths are resolved from ${WORKSPACE_DIR}.`,
    triedPaths,
  };
}

function uploadResult(result: UploadFileResult) {
  if (!result.success) {
    return toolErr(`Failed to upload file: ${result.error}`);
  }
  const successMsg = `File uploaded successfully${result.fileId ? ` (ID: ${result.fileId})` : ""}.`;
  return toolOk(successMsg, { data: { fileId: result.fileId } });
}

export const registerSlackUploadFileTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-upload-file",
    {
      title: "Upload file to Slack",
      description:
        "Upload a file (image, document, etc.) to a Slack channel or thread. Use inboxMessageId or taskId for context, or provide channelId directly (leads only). Maximum file size is 1 GB.",
      annotations: { openWorldHint: true },

      inputSchema: z.object({
        inboxMessageId: z
          .uuid()
          .optional()
          .describe("The inbox message ID for thread context (leads only)."),
        taskId: z
          .uuid()
          .optional()
          .describe("The task ID with Slack context (for task-related threads)."),
        channelId: z
          .string()
          .optional()
          .describe("Direct channel ID to upload to (requires lead privileges)."),
        threadTs: z
          .string()
          .optional()
          .describe("Thread timestamp to upload as a thread reply (used with channelId)."),
        filePath: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Path to the file to upload. Either filePath OR content must be provided. " +
              "IMPORTANT: the file is read on the API server's filesystem (where this tool runs), NOT on the caller's. " +
              "Worker/lead containers do NOT share /tmp or /workspace/personal/ with the API server — the only shared volume is /workspace/shared/. " +
              "The file must be a regular file inside /workspace or the working directory of your current task. " +
              "Use /workspace/shared/<agent-id>/file.png (or a relative path like 'shared/<agent-id>/file.png'). " +
              "For files that only live on the caller (e.g. /tmp), pass them inline via `content` (base64) instead.",
          ),
        content: z
          .string()
          .optional()
          .describe(
            "Base64-encoded file content. Use this when the file lives on the caller's filesystem and isn't reachable by the API server " +
              "(e.g. anything under /tmp on a worker/lead container). Either filePath OR content must be provided.",
          ),
        filename: z
          .string()
          .optional()
          .describe(
            "Name to give the file in Slack. Required when using content, defaults to original filename when using filePath.",
          ),
        initialComment: z
          .string()
          .max(4000)
          .optional()
          .describe("Optional message to post with the file."),
      }),
      outputSchema: swarmToolOutputSchema({
        fileId: z.string().optional(),
      }),
    },
    async (
      { inboxMessageId, taskId, channelId, threadTs, filePath, content, filename, initialComment },
      requestInfo,
      _meta,
    ) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      const agent = await getAgentById(requestInfo.agentId);
      if (!agent) {
        return toolErr("Agent not found.");
      }

      let slackChannelId: string | undefined;
      let slackThreadTs: string | undefined;

      // Determine Slack context from inbox message, task, or direct params
      if (inboxMessageId) {
        const inboxMsg = await getInboxMessageById(inboxMessageId);
        if (!inboxMsg) {
          return toolErr("Inbox message not found.");
        }
        if (inboxMsg.agentId !== requestInfo.agentId) {
          return toolErr("This inbox message is not yours.");
        }
        slackChannelId = inboxMsg.slackChannelId;
        slackThreadTs = inboxMsg.slackThreadTs;
      } else if (taskId) {
        const task = await getTaskById(taskId);
        if (!task) {
          return toolErr("Task not found.");
        }
        // Verify agent has context for this task
        if (task.agentId !== requestInfo.agentId && task.creatorAgentId !== requestInfo.agentId) {
          return toolErr("You don't have context for this task.");
        }
        slackChannelId = task.slackChannelId;
        slackThreadTs = resolveTaskUploadThreadTs(task);
      } else if (channelId) {
        // Direct channel access requires lead privileges
        const decision = can({
          principal: { kind: "agent", agentId: agent.id, isLead: agent.isLead },
          verb: "integration.slack.upload",
          resource: { kind: "none" },
          source: "mcp",
        });
        if (!decision.allow) {
          return toolErr("Direct channel access requires lead privileges.");
        }
        slackChannelId = channelId;
        slackThreadTs = threadTs;
      } else {
        return toolErr("Must provide inboxMessageId, taskId, or channelId.");
      }

      if (!slackChannelId) {
        return toolErr("No Slack channel context available.");
      }

      const app = getSlackApp();
      if (!app) {
        return toolErr("Slack not configured.");
      }

      const blockReason = await getChannelBlockReason(app.client, slackChannelId);
      if (blockReason) {
        return toolErr(externalChannelToolError(slackChannelId, blockReason));
      }

      // Validate: must provide either filePath OR content (not both, not neither)
      if (!filePath && !content) {
        return toolErr("Must provide either filePath or content (base64).");
      }

      if (filePath && content) {
        return toolErr("Cannot provide both filePath and content. Use one or the other.");
      }

      // If using content (base64), filename is required
      if (content && !filename) {
        return toolErr("filename is required when using base64 content upload.");
      }

      if (filePath) {
        const roots = await uploadRoots(agent.id, [taskId, requestInfo.sourceTaskId]);
        const pathResult = await openUploadFile(filePath, roots);

        if (!pathResult.success) {
          if (!pathResult.notFound) return toolErr(pathResult.error);
          const triedPathsList = pathResult.triedPaths.map((p) => `  - ${p}`).join("\n");
          const errorMsg =
            `${pathResult.error}\n` +
            `Provided path: ${filePath}\n` +
            `Tried locations:\n${triedPathsList}\n\n` +
            `Note: this tool reads the file on the API server's filesystem, NOT the caller's. ` +
            `Worker/lead containers do not share /tmp or /workspace/personal/ with the API server — only /workspace/shared/.\n\n` +
            `Tips:\n` +
            `- Put the file in /workspace/shared/<agent-id>/ (e.g., '/workspace/shared/<agent-id>/my-file.png') and pass that path.\n` +
            `- Or pass the file inline via the \`content\` arg as base64 (with \`filename\`) so no shared-mount round-trip is needed.`;
          return toolErr(errorMsg);
        }

        // The handle stays open until the upload has sent every byte.
        try {
          return uploadResult(
            await uploadOpenFile(app.client, pathResult.file, {
              filename: filename || pathResult.resolvedPath.split("/").pop() || "file",
              channelId: slackChannelId,
              threadTs: slackThreadTs,
              initialComment,
            }),
          );
        } finally {
          await pathResult.file.handle.close();
        }
      }

      // Base64 content mode: decode and check size
      let fileToUpload: Buffer;
      try {
        fileToUpload = Buffer.from(content!, "base64");
      } catch {
        return toolErr("Invalid base64 content.");
      }

      if (fileToUpload.length > MAX_FILE_SIZE) {
        const sizeMB = Math.round(fileToUpload.length / 1024 / 1024);
        return toolErr(`File too large: ${sizeMB} MB. Maximum is 1 GB.`);
      }

      try {
        return uploadResult(
          await uploadFile(app.client, {
            file: fileToUpload,
            filename: filename!,
            channelId: slackChannelId,
            threadTs: slackThreadTs,
            initialComment,
          }),
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return toolErr(`Failed to upload file: ${errorMsg}`);
      }
    },
  );
};
