import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { getSlackApp } from "@/slack/app";
import { DEFAULT_DOWNLOAD_DIR, downloadFile, getFileInfo } from "@/slack/files";
import { createToolRegistrar } from "@/tools/utils";

export const registerSlackDownloadFileTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-download-file",
    {
      title: "Download file from Slack",
      description:
        "Download a file from Slack by file ID or URL. Files are saved to /workspace/shared/downloads/slack/ by default.",
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
            "Where to save the file. Can be a directory or full path. Defaults to /workspace/shared/downloads/slack/",
          ),
        filename: z
          .string()
          .optional()
          .describe("Filename to use when saving. Only used if savePath is a directory."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        savedPath: z.string().optional(),
        fileInfo: z
          .object({
            id: z.string(),
            name: z.string(),
            mimetype: z.string(),
            size: z.number(),
          })
          .optional(),
      }),
    },
    async ({ fileId, url, savePath, filename }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "Agent ID not found." }],
          structuredContent: { success: false, message: "Agent ID not found." },
        };
      }

      const agent = getAgentById(requestInfo.agentId);
      if (!agent) {
        return {
          content: [{ type: "text", text: "Agent not found." }],
          structuredContent: { success: false, message: "Agent not found." },
        };
      }

      // Must provide either fileId or url
      if (!fileId && !url) {
        return {
          content: [{ type: "text", text: "Must provide either fileId or url." }],
          structuredContent: { success: false, message: "Must provide either fileId or url." },
        };
      }

      const app = getSlackApp();
      if (!app) {
        return {
          content: [{ type: "text", text: "Slack not configured." }],
          structuredContent: { success: false, message: "Slack not configured." },
        };
      }

      const token = process.env.SLACK_BOT_TOKEN;
      if (!token) {
        return {
          content: [{ type: "text", text: "Slack bot token not configured." }],
          structuredContent: { success: false, message: "Slack bot token not configured." },
        };
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
            return {
              content: [{ type: "text", text: `File not found: ${fileId}` }],
              structuredContent: { success: false, message: `File not found: ${fileId}` },
            };
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
          return {
            content: [{ type: "text", text: "No download URL available." }],
            structuredContent: { success: false, message: "No download URL available." },
          };
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
          return {
            content: [{ type: "text", text: `Failed to download file: ${result.error}` }],
            structuredContent: {
              success: false,
              message: `Failed to download file: ${result.error}`,
            },
          };
        }

        const successMsg = `File downloaded successfully to ${result.savedPath}`;
        return {
          content: [{ type: "text", text: successMsg }],
          structuredContent: {
            success: true,
            message: successMsg,
            savedPath: result.savedPath,
            fileInfo,
          },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to download file: ${errorMsg}` }],
          structuredContent: { success: false, message: `Failed to download file: ${errorMsg}` },
        };
      }
    },
  );
};
