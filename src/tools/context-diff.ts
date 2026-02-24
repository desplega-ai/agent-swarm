import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getContextVersion } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

async function computeDiff(oldContent: string, newContent: string): Promise<string> {
  const tmpDir = tmpdir();
  const oldPath = join(tmpDir, `ctx-diff-old-${crypto.randomUUID()}.txt`);
  const newPath = join(tmpDir, `ctx-diff-new-${crypto.randomUUID()}.txt`);

  try {
    await Bun.write(oldPath, oldContent);
    await Bun.write(newPath, newContent);

    const proc = Bun.spawn(["diff", "-u", "--label", "old", "--label", "new", oldPath, newPath], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    // diff returns exit code 1 when files differ — that's expected
    return output || "(no differences)";
  } finally {
    // Clean up temp files
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(oldPath);
      await unlink(newPath);
    } catch {
      /* ignore cleanup errors */
    }
  }
}

export const registerContextDiffTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "context-diff",
    {
      title: "Context Diff",
      description:
        "Compare two versions of a context file. Shows a unified diff between the specified version and its predecessor (or a specific comparison version).",
      inputSchema: z.object({
        versionId: z.string().uuid().describe('The "newer" version ID to diff.'),
        compareToVersionId: z
          .string()
          .uuid()
          .optional()
          .describe('The "older" version ID to compare against. Default: previous version.'),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        field: z.string().optional(),
        fromVersion: z.number().optional(),
        toVersion: z.number().optional(),
        diff: z.string().optional(),
        changeSource: z.string().optional(),
        createdAt: z.string().optional(),
      }),
    },
    async ({ versionId, compareToVersionId }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
          },
        };
      }

      // Get the target version
      const version = getContextVersion(versionId);
      if (!version) {
        return {
          content: [{ type: "text", text: `Version ${versionId} not found.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Version ${versionId} not found.`,
          },
        };
      }

      // Access control: agents can diff their own context, lead can diff any
      if (version.agentId !== requestInfo.agentId) {
        const callerAgent = getAgentById(requestInfo.agentId);
        if (!callerAgent?.isLead) {
          return {
            content: [
              {
                type: "text",
                text: "Permission denied. Only the lead can diff other agents' context.",
              },
            ],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Permission denied. Only the lead can diff other agents' context.",
            },
          };
        }
      }

      // Get the comparison version
      let compareVersion: import("@/types").ContextVersion | null | undefined;
      if (compareToVersionId) {
        compareVersion = getContextVersion(compareToVersionId);
        if (!compareVersion) {
          return {
            content: [
              { type: "text", text: `Comparison version ${compareToVersionId} not found.` },
            ],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `Comparison version ${compareToVersionId} not found.`,
            },
          };
        }
        if (compareVersion.agentId !== version.agentId || compareVersion.field !== version.field) {
          return {
            content: [
              { type: "text", text: "Both versions must be for the same agent and field." },
            ],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Both versions must be for the same agent and field.",
            },
          };
        }
      } else if (version.previousVersionId) {
        compareVersion = getContextVersion(version.previousVersionId);
      }

      const oldContent = compareVersion?.content ?? "";
      const diff = await computeDiff(oldContent, version.content);

      const fromVersion = compareVersion?.version ?? 0;
      const toVersion = version.version;

      return {
        content: [
          {
            type: "text",
            text: `Diff for ${version.field} v${fromVersion} → v${toVersion}:\n\n${diff}`,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Diff computed for ${version.field} v${fromVersion} → v${toVersion}.`,
          field: version.field,
          fromVersion,
          toVersion,
          diff,
          changeSource: version.changeSource,
          createdAt: version.createdAt,
        },
      };
    },
  );
};
