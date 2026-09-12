import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { getSlackApp } from "@/slack/app";
import { DEFAULT_DOWNLOAD_DIR, downloadFile, getFileInfo } from "@/slack/files";
import { attachableTask, attachSlackFilesForAgent } from "@/slack/inbound-files";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

/** `F0123ABCD` out of a `files.slack.com/files-pri/<team>-<file>/…` URL. */
function fileIdFromUrl(url: string): string | undefined {
  return /\/files-pri\/[A-Z0-9]+-([A-Z0-9]+)\//.exec(url)?.[1];
}

export const registerSlackDownloadFileTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-download-file",
    {
      title: "Download file from Slack",
      description:
        "Download a file from Slack by file ID or URL. From a task, the file is stored as an attachment of that task and the result carries a ready-to-run `fetchCommand` to get the bytes into your container. Without a task, the file is saved on the API server's disk, which your container usually can't read.",
      // Not read-only: from a task it uploads the file and records an attachment.
      annotations: { readOnlyHint: false, openWorldHint: true },

      inputSchema: z.object({
        fileId: z
          .string()
          .optional()
          .describe("The Slack file ID to download (e.g., 'F0RDC39U1')."),
        url: z
          .string()
          .url()
          .optional()
          .describe("Direct URL to download (url_private_download from a file object)."),
        taskId: z
          .uuid()
          .optional()
          .describe(
            "Task to attach the file to. Defaults to the task you are working on; must be a task you own or created.",
          ),
        savePath: z
          .string()
          .optional()
          .describe(
            "Only without a task: where to save the file on the API server (directory or full path). Defaults to /workspace/shared/downloads/{agentId}/slack/.",
          ),
        filename: z
          .string()
          .optional()
          .describe("Filename to use when saving. Only used if savePath is a directory."),
      }),
      outputSchema: swarmToolOutputSchema({
        taskId: z.string().optional(),
        attachmentId: z.string().optional(),
        fetchCommand: z.string().optional(),
        savedPath: z
          .string()
          .optional()
          .describe(
            "Only without a task: the path on the API server's disk, not in your container.",
          ),
        fileInfo: z
          .looseObject({
            id: z.string().optional(),
            name: z.string().optional(),
            mimetype: z.string().optional(),
            size: z.number().optional(),
          })
          .optional(),
      }),
    },
    async ({ fileId, url, taskId, savePath, filename }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      const agent = await getAgentById(requestInfo.agentId);
      if (!agent) {
        return toolErr("Agent not found.");
      }

      // Must provide either fileId or url
      if (!fileId && !url) {
        return toolErr("Must provide either fileId or url.");
      }

      const app = getSlackApp();
      if (!app) {
        return toolErr("Slack not configured.");
      }

      const token = process.env.SLACK_BOT_TOKEN;
      if (!token) {
        return toolErr("Slack bot token not configured.");
      }

      const task = await attachableTask(agent.id, taskId ?? requestInfo.sourceTaskId);
      if (taskId && !task) {
        return toolErr("You don't have context for this task.");
      }

      try {
        const id = fileId ?? (url ? fileIdFromUrl(url) : undefined);
        const info = id ? await getFileInfo(app.client, id) : null;
        if (fileId && !info) {
          return toolErr(`File not found: ${fileId}`);
        }
        const fileInfo = info
          ? { id: info.id, name: info.name, mimetype: info.mimetype, size: info.size }
          : undefined;

        if (task) {
          if (!info) {
            return toolErr("Could not identify the Slack file in that URL; pass fileId instead.");
          }
          const outcome = (await attachSlackFilesForAgent(app.client, task, [info], agent.id)).get(
            info.id,
          );
          if (!outcome || "reason" in outcome) {
            return toolErr(`Failed to attach file: ${outcome?.reason ?? "unknown error"}`);
          }
          const { attachment, fetchCommand } = outcome;
          return toolOk(
            `Attached ${attachment.name} to task ${task.id} (attachment ${attachment.id}).`,
            {
              details: `Get it into your container with:\n${fetchCommand}`,
              data: { taskId: task.id, attachmentId: attachment.id, fetchCommand, fileInfo },
            },
          );
        }

        const downloadUrl = info?.url_private_download ?? url;
        if (!downloadUrl) {
          return toolErr("No download URL available.");
        }

        // Determine save path
        let finalSavePath = savePath || DEFAULT_DOWNLOAD_DIR;

        // If it's a directory path, append the filename
        if (finalSavePath.endsWith("/") || !finalSavePath.includes(".")) {
          const actualFilename = filename || fileInfo?.name || `file_${Date.now()}`;
          finalSavePath = finalSavePath.endsWith("/")
            ? `${finalSavePath}${actualFilename}`
            : `${finalSavePath}/${actualFilename}`;
        }

        // Download the file
        const result = await downloadFile({
          file: downloadUrl,
          savePath: finalSavePath,
          token,
        });

        if (!result.success) {
          return toolErr(`Failed to download file: ${result.error}`);
        }

        return toolOk(`File saved on the API server at ${result.savedPath}.`, {
          data: { savedPath: result.savedPath, fileInfo },
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return toolErr(`Failed to download file: ${errorMsg}`);
      }
    },
  );
};
