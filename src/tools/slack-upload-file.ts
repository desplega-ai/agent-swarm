import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getInboxMessageById, getTaskById } from "@/be/db";
import { getSlackApp } from "@/slack/app";
import { MAX_FILE_SIZE, uploadFile } from "@/slack/files";
import { createToolRegistrar } from "@/tools/utils";

/**
 * Base directory for agent file operations.
 * All relative paths are resolved from here.
 */
const WORKSPACE_DIR = "/workspace";

/**
 * Resolves a file path to an absolute path and checks if it exists.
 * Handles several common patterns:
 * 1. Relative paths (e.g., "shared/file.png") -> resolved from /workspace
 * 2. Absolute paths under /workspace (e.g., "/workspace/shared/file.png") -> used as-is
 * 3. Absolute paths that look like they should be under /workspace (e.g., "/tmp/file.png")
 *    -> tries to find at /workspace/tmp/file.png if not found at original path
 *
 * @param filePath - The path provided by the user
 * @returns Object with resolved path and exists flag, or error message
 */
async function resolveAndValidateFilePath(
  filePath: string,
): Promise<
  { success: true; resolvedPath: string } | { success: false; error: string; triedPaths: string[] }
> {
  const triedPaths: string[] = [];

  // Helper to check if file exists
  const fileExists = async (path: string): Promise<boolean> => {
    try {
      const bunFile = Bun.file(path);
      return await bunFile.exists();
    } catch {
      return false;
    }
  };

  // Case 1: Relative path - resolve from /workspace
  if (!filePath.startsWith("/")) {
    const absolutePath = `${WORKSPACE_DIR}/${filePath}`;
    triedPaths.push(absolutePath);
    if (await fileExists(absolutePath)) {
      return { success: true, resolvedPath: absolutePath };
    }
    return {
      success: false,
      error: `File not found. Relative paths are resolved from ${WORKSPACE_DIR}.`,
      triedPaths,
    };
  }

  // Case 2: Absolute path - try it directly first
  triedPaths.push(filePath);
  if (await fileExists(filePath)) {
    return { success: true, resolvedPath: filePath };
  }

  // Case 3: Absolute path didn't exist - try resolving under /workspace
  // This helps with paths like /tmp/file.png -> /workspace/tmp/file.png
  if (!filePath.startsWith(WORKSPACE_DIR)) {
    // Remove leading slash and resolve from workspace
    const relativePath = filePath.slice(1); // "/tmp/file.png" -> "tmp/file.png"
    const workspacePath = `${WORKSPACE_DIR}/${relativePath}`;
    triedPaths.push(workspacePath);
    if (await fileExists(workspacePath)) {
      return { success: true, resolvedPath: workspacePath };
    }
  }

  return {
    success: false,
    error: `File not found at any of the attempted locations.`,
    triedPaths,
  };
}

export const registerSlackUploadFileTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-upload-file",
    {
      title: "Upload file to Slack",
      description:
        "Upload a file (image, document, etc.) to a Slack channel or thread. Use inboxMessageId or taskId for context, or provide channelId directly (leads only). Maximum file size is 1 GB.",
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
              "Relative paths are resolved from /workspace (e.g., 'shared/file.png' -> '/workspace/shared/file.png'). " +
              "Absolute paths work if they exist or if the file exists under /workspace with that path (e.g., '/tmp/file.png' checks '/tmp/file.png' then '/workspace/tmp/file.png').",
          ),
        content: z
          .string()
          .optional()
          .describe(
            "Base64-encoded file content. Use this when the file is not on the local filesystem. Either filePath OR content must be provided.",
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
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        fileId: z.string().optional(),
      }),
    },
    async (
      { inboxMessageId, taskId, channelId, threadTs, filePath, content, filename, initialComment },
      requestInfo,
      _meta,
    ) => {
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

      let slackChannelId: string | undefined;
      let slackThreadTs: string | undefined;

      // Determine Slack context from inbox message, task, or direct params
      if (inboxMessageId) {
        const inboxMsg = getInboxMessageById(inboxMessageId);
        if (!inboxMsg) {
          return {
            content: [{ type: "text", text: "Inbox message not found." }],
            structuredContent: { success: false, message: "Inbox message not found." },
          };
        }
        if (inboxMsg.agentId !== requestInfo.agentId) {
          return {
            content: [{ type: "text", text: "This inbox message is not yours." }],
            structuredContent: { success: false, message: "This inbox message is not yours." },
          };
        }
        slackChannelId = inboxMsg.slackChannelId;
        slackThreadTs = inboxMsg.slackThreadTs;
      } else if (taskId) {
        const task = getTaskById(taskId);
        if (!task) {
          return {
            content: [{ type: "text", text: "Task not found." }],
            structuredContent: { success: false, message: "Task not found." },
          };
        }
        // Verify agent has context for this task
        if (task.agentId !== requestInfo.agentId && task.creatorAgentId !== requestInfo.agentId) {
          return {
            content: [{ type: "text", text: "You don't have context for this task." }],
            structuredContent: { success: false, message: "You don't have context for this task." },
          };
        }
        slackChannelId = task.slackChannelId;
        slackThreadTs = task.slackThreadTs;
      } else if (channelId) {
        // Direct channel access requires lead privileges
        if (!agent.isLead) {
          return {
            content: [{ type: "text", text: "Direct channel access requires lead privileges." }],
            structuredContent: {
              success: false,
              message: "Direct channel access requires lead privileges.",
            },
          };
        }
        slackChannelId = channelId;
        slackThreadTs = threadTs;
      } else {
        return {
          content: [{ type: "text", text: "Must provide inboxMessageId, taskId, or channelId." }],
          structuredContent: {
            success: false,
            message: "Must provide inboxMessageId, taskId, or channelId.",
          },
        };
      }

      if (!slackChannelId) {
        return {
          content: [{ type: "text", text: "No Slack channel context available." }],
          structuredContent: {
            success: false,
            message: "No Slack channel context available.",
          },
        };
      }

      const app = getSlackApp();
      if (!app) {
        return {
          content: [{ type: "text", text: "Slack not configured." }],
          structuredContent: { success: false, message: "Slack not configured." },
        };
      }

      // Validate: must provide either filePath OR content (not both, not neither)
      if (!filePath && !content) {
        return {
          content: [{ type: "text", text: "Must provide either filePath or content (base64)." }],
          structuredContent: {
            success: false,
            message: "Must provide either filePath or content (base64).",
          },
        };
      }

      if (filePath && content) {
        return {
          content: [
            {
              type: "text",
              text: "Cannot provide both filePath and content. Use one or the other.",
            },
          ],
          structuredContent: {
            success: false,
            message: "Cannot provide both filePath and content. Use one or the other.",
          },
        };
      }

      // If using content (base64), filename is required
      if (content && !filename) {
        return {
          content: [
            { type: "text", text: "filename is required when using base64 content upload." },
          ],
          structuredContent: {
            success: false,
            message: "filename is required when using base64 content upload.",
          },
        };
      }

      let fileToUpload: string | Buffer;
      let actualFilename: string;

      if (filePath) {
        // Resolve and validate the file path
        const pathResult = await resolveAndValidateFilePath(filePath);

        if (!pathResult.success) {
          const triedPathsList = pathResult.triedPaths.map((p) => `  - ${p}`).join("\n");
          const errorMsg =
            `${pathResult.error}\n` +
            `Provided path: ${filePath}\n` +
            `Tried locations:\n${triedPathsList}\n\n` +
            `Tips:\n` +
            `- Use relative paths from /workspace (e.g., 'shared/my-file.png')\n` +
            `- Or use absolute paths under /workspace (e.g., '/workspace/shared/my-file.png')`;
          return {
            content: [{ type: "text", text: errorMsg }],
            structuredContent: { success: false, message: errorMsg },
          };
        }

        const resolvedPath = pathResult.resolvedPath;
        const bunFile = Bun.file(resolvedPath);
        const fileSize = bunFile.size;

        if (fileSize > MAX_FILE_SIZE) {
          const sizeMB = Math.round(fileSize / 1024 / 1024);
          return {
            content: [{ type: "text", text: `File too large: ${sizeMB} MB. Maximum is 1 GB.` }],
            structuredContent: {
              success: false,
              message: `File too large: ${sizeMB} MB. Maximum is 1 GB.`,
            },
          };
        }

        fileToUpload = resolvedPath;
        actualFilename = filename || resolvedPath.split("/").pop() || "file";
      } else {
        // Base64 content mode: decode and check size
        try {
          fileToUpload = Buffer.from(content!, "base64");
        } catch {
          return {
            content: [{ type: "text", text: "Invalid base64 content." }],
            structuredContent: { success: false, message: "Invalid base64 content." },
          };
        }

        if (fileToUpload.length > MAX_FILE_SIZE) {
          const sizeMB = Math.round(fileToUpload.length / 1024 / 1024);
          return {
            content: [{ type: "text", text: `File too large: ${sizeMB} MB. Maximum is 1 GB.` }],
            structuredContent: {
              success: false,
              message: `File too large: ${sizeMB} MB. Maximum is 1 GB.`,
            },
          };
        }

        actualFilename = filename!;
      }

      try {
        const result = await uploadFile(app.client, {
          file: fileToUpload,
          filename: actualFilename,
          channelId: slackChannelId,
          threadTs: slackThreadTs,
          initialComment,
        });

        if (!result.success) {
          return {
            content: [{ type: "text", text: `Failed to upload file: ${result.error}` }],
            structuredContent: {
              success: false,
              message: `Failed to upload file: ${result.error}`,
            },
          };
        }

        const successMsg = `File uploaded successfully${result.fileId ? ` (ID: ${result.fileId})` : ""}.`;
        return {
          content: [{ type: "text", text: successMsg }],
          structuredContent: {
            success: true,
            message: successMsg,
            fileId: result.fileId,
          },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to upload file: ${errorMsg}` }],
          structuredContent: { success: false, message: `Failed to upload file: ${errorMsg}` },
        };
      }
    },
  );
};
