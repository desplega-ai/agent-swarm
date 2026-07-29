import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { getSlackApp } from "@/slack/app";
import { DEFAULT_DOWNLOAD_DIR, downloadFile, getFileInfo } from "@/slack/files";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerSlackDownloadFileTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-download-file",
    {
      title: "Download file from Slack",
      description:
        "Download a file from Slack by file ID or URL. Files are saved to the agent's download directory on the shared disk by default.",
      annotations: { readOnlyHint: true, openWorldHint: true },

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
        savePath: z
          .string()
          .optional()
          .describe(
            "Where to save the file. Can be a directory or full path. Defaults to /workspace/shared/downloads/{agentId}/slack/",
          ),
        filename: z
          .string()
          .optional()
          .describe("Filename to use when saving. Only used if savePath is a directory."),
      }),
      outputSchema: swarmToolOutputSchema({
        savedPath: z.string().optional(),
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
    async ({ fileId, url, savePath, filename }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      const agent = getAgentById(requestInfo.agentId);
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

      try {
        let downloadUrl = url;
        let fileInfo:
          | {
              id: string;
              name: string;
              mimetype: string;
              size: number;
            }
          | undefined;

        // If fileId provided, get file info first
        if (fileId) {
          const info = await getFileInfo(app.client, fileId);
          if (!info) {
            return toolErr(`File not found: ${fileId}`);
          }

          downloadUrl = info.url_private_download;
          fileInfo = {
            id: info.id,
            name: info.name,
            mimetype: info.mimetype,
            size: info.size,
          };
        }

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

        const successMsg = `File downloaded successfully to ${result.savedPath}`;
        return toolOk(successMsg, { data: { savedPath: result.savedPath, fileInfo } });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return toolErr(`Failed to download file: ${errorMsg}`);
      }
    },
  );
};
