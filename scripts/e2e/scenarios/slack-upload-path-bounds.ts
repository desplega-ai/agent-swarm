import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { asString, expect } from "../http";
import type { McpConnection } from "../mcp";
import type { Scenario } from "../run";
import {
  Cleanup,
  callTool,
  expectToolError,
  expectToolOk,
  registerLead,
  retireAgent,
} from "./platformb-helpers";

const WORKSPACE = "/workspace";
const OUTSIDE = `filePath must be a file inside ${WORKSPACE}.`;

/**
 * slack-upload-file with `filePath` reads only files whose real path is inside /workspace on
 * the API server. Paths outside it, `..` climbs and symlinks that lead out are refused, and
 * nothing reaches Slack. A file under /workspace/shared still uploads.
 */
export const slackUploadPathBounds: Scenario = {
  name: "slack-upload-path-bounds",
  order: 682,
  async run(ctx) {
    const cleanup = new Cleanup();
    let leadId: string | undefined;
    let leadConn: McpConnection | undefined;
    let channelId: string | undefined;
    let scratchDir: string | undefined;
    const sharedDir = join(WORKSPACE, "shared", `e2e-upload-${ctx.nonce}`);
    cleanup.add("close MCP", async () => {
      await leadConn?.close();
    });
    cleanup.add("retire lead", () => retireAgent(ctx, leadId));
    cleanup.add("archive channel", async () => {
      if (leadConn && channelId) {
        await callTool(leadConn, "slack-archive-channel", { channelId });
      }
    });
    cleanup.add("remove files", async () => {
      if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
      await rm(sharedDir, { recursive: true, force: true });
    });

    await cleanup.around(async () => {
      leadId = await registerLead(ctx, `e2e-upload-bounds-lead-${ctx.nonce}`);
      leadConn = await ctx.connectMcp(leadId);
      const created = expectToolOk(
        await callTool(leadConn, "slack-create-channel", { name: `e2e-upload-${ctx.nonce}` }),
        "slack-create-channel",
      );
      channelId = asString(created.data.channelId, "created channel id");

      scratchDir = await mkdtemp(join(tmpdir(), "e2e-upload-bounds-"));
      const outsideName = `outside-${ctx.nonce}.txt`;
      const outsidePath = join(scratchDir, outsideName);
      await Bun.write(outsidePath, `outside body ${ctx.nonce}`);
      const announced = (name: string) =>
        ctx.slack.apiCalls("files.getUploadURLExternal").some((call) => call.args.filename === name);

      // ===== paths outside /workspace are refused =====
      for (const [filePath, label] of [
        [outsidePath, "an absolute path outside /workspace"],
        [`${WORKSPACE}/..${outsidePath}`, "a /workspace path that climbs out of it"],
        [relative(WORKSPACE, outsidePath), "a relative path that climbs out of /workspace"],
      ] as const) {
        const outcome = await callTool(leadConn, "slack-upload-file", { channelId, filePath });
        expect(outcome.isError, `slack-upload-file with ${label} was not refused`);
        expect(
          outcome.message.includes("File not found") || outcome.message.includes(OUTSIDE),
          `slack-upload-file with ${label}: unexpected error ${outcome.message}`,
        );
      }
      expect(!announced(outsideName), "A file outside /workspace reached Slack");

      // ===== a file under /workspace/shared still uploads =====
      // The API runs as a plain user on CI and dev machines, where /workspace does not exist.
      const canWrite = await mkdir(sharedDir, { recursive: true }).then(
        () => true,
        () => false,
      );
      if (!canWrite) {
        // Without the directory, a legitimate path is "not found", never refused as outside.
        expectToolError(
          await callTool(leadConn, "slack-upload-file", {
            channelId,
            filePath: join(sharedDir, "missing.txt"),
          }),
          "File not found",
          "slack-upload-file with a missing file under /workspace/shared",
        );
        return;
      }
      const insideName = `inside-${ctx.nonce}.txt`;
      await Bun.write(join(sharedDir, insideName), `inside body ${ctx.nonce}`);
      for (const [filePath, label] of [
        [join(sharedDir, insideName), "an absolute /workspace/shared path"],
        [relative(WORKSPACE, join(sharedDir, insideName)), "a path relative to /workspace"],
      ] as const) {
        expectToolOk(
          await callTool(leadConn, "slack-upload-file", { channelId, filePath }),
          `slack-upload-file with ${label}`,
        );
      }
      expect(announced(insideName), "The /workspace/shared upload did not use the file's name");

      // A symlink inside /workspace that leads out is refused.
      const linkName = `link-${ctx.nonce}.txt`;
      await symlink(outsidePath, join(sharedDir, linkName));
      expectToolError(
        await callTool(leadConn, "slack-upload-file", {
          channelId,
          filePath: join(sharedDir, linkName),
        }),
        OUTSIDE,
        "slack-upload-file with a symlink that leads out of /workspace",
      );
      expect(!announced(linkName) && !announced(outsideName), "The symlink target reached Slack");
    });
  },
};
