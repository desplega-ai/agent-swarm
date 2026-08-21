import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getContextVersion } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export async function computeDiff(
  oldContent: string,
  newContent: string,
  labels: { old: string; new: string } = { old: "old", new: "new" },
): Promise<string> {
  const tmpDir = tmpdir();
  const oldPath = join(tmpDir, `ctx-diff-old-${crypto.randomUUID()}.txt`);
  const newPath = join(tmpDir, `ctx-diff-new-${crypto.randomUUID()}.txt`);

  try {
    await Bun.write(oldPath, oldContent);
    await Bun.write(newPath, newContent);

    const proc = Bun.spawn(
      ["diff", "-u", "--label", labels.old, "--label", labels.new, oldPath, newPath],
      { stdout: "pipe", stderr: "pipe" },
    );

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
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        versionId: z.string().uuid().describe('The "newer" version ID to diff.'),
        compareToVersionId: z
          .string()
          .uuid()
          .optional()
          .describe('The "older" version ID to compare against. Default: previous version.'),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
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
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }

      // Get the target version
      const version = await getContextVersion(versionId);
      if (!version) {
        return toolErr(`Version ${versionId} not found.`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }

      // Access control: agents can diff their own context, lead can diff any
      if (version.agentId !== requestInfo.agentId) {
        const callerAgent = await getAgentById(requestInfo.agentId);
        const decision = can({
          principal: {
            kind: "agent",
            agentId: requestInfo.agentId,
            isLead: callerAgent?.isLead ?? false,
          },
          verb: "agent.context.read.any",
          resource: { kind: "agent", agentId: version.agentId },
          source: "mcp",
        });
        if (!decision.allow) {
          return toolErr("Permission denied. Only the lead can diff other agents' context.", {
            data: { yourAgentId: requestInfo.agentId },
          });
        }
      }

      // Get the comparison version
      let compareVersion: import("@/types").ContextVersion | null | undefined;
      if (compareToVersionId) {
        compareVersion = await getContextVersion(compareToVersionId);
        if (!compareVersion) {
          return toolErr(`Comparison version ${compareToVersionId} not found.`, {
            data: { yourAgentId: requestInfo.agentId },
          });
        }
        if (compareVersion.agentId !== version.agentId || compareVersion.field !== version.field) {
          return toolErr("Both versions must be for the same agent and field.", {
            data: { yourAgentId: requestInfo.agentId },
          });
        }
      } else if (version.previousVersionId) {
        compareVersion = await getContextVersion(version.previousVersionId);
      }

      const oldContent = compareVersion?.content ?? "";
      const diff = await computeDiff(oldContent, version.content);

      const fromVersion = compareVersion?.version ?? 0;
      const toVersion = version.version;

      return toolOk(`Diff computed for ${version.field} v${fromVersion} → v${toVersion}.`, {
        details: `Diff for ${version.field} v${fromVersion} → v${toVersion}:\n\n${diff}`,
        data: {
          yourAgentId: requestInfo.agentId,
          field: version.field,
          fromVersion,
          toVersion,
          diff,
          changeSource: version.changeSource,
          createdAt: version.createdAt,
        },
      });
    },
  );
};
