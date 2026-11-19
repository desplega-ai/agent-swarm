import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { asString, expect } from "../http";
import type { McpConnection } from "../mcp";
import type { Scenario } from "../run";
import { createAssignedTask } from "./core-helpers";
import {
  Cleanup,
  callTool,
  expectToolError,
  expectToolOk,
  registerLead,
  registerWorker,
  retireAgent,
} from "./platformb-helpers";

const WORKSPACE = "/workspace";
const OUTSIDE = "must be a regular file inside";

/**
 * slack-upload-file with `filePath` reads only a regular file whose real path is inside
 * /workspace or the working directory of the caller's own task (`X-Source-Task-ID`). Other
 * paths, `..` climbs, symlinks that lead out, directories, another agent's task directory and
 * a task directory of "/" are refused, and nothing reaches Slack. An allowed file is sent from
 * the open file descriptor and arrives byte for byte.
 */
export const slackUploadPathBounds: Scenario = {
  name: "slack-upload-path-bounds",
  order: 682,
  async run(ctx) {
    const cleanup = new Cleanup();
    let leadId: string | undefined;
    let workerId: string | undefined;
    const conns: McpConnection[] = [];
    const taskIds: string[] = [];
    let channelId: string | undefined;
    let taskDir: string | undefined;
    let otherDir: string | undefined;
    const sharedDir = join(WORKSPACE, "shared", `e2e-upload-${ctx.nonce}`);
    cleanup.add("close MCP", async () => {
      for (const conn of conns) await conn.close();
    });
    cleanup.add("retire agents", async () => {
      await retireAgent(ctx, leadId);
      await retireAgent(ctx, workerId);
    });
    cleanup.add("cancel tasks", async () => {
      for (const id of taskIds) await ctx.api("POST", `/api/tasks/${id}/cancel`, { body: {} });
    });
    cleanup.add("archive channel", async () => {
      if (conns[0] && channelId) {
        await callTool(conns[0], "slack-archive-channel", { channelId });
      }
    });
    cleanup.add("remove files", async () => {
      for (const dir of [taskDir, otherDir, sharedDir]) {
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    });

    await cleanup.around(async () => {
      leadId = await registerLead(ctx, `e2e-upload-bounds-lead-${ctx.nonce}`);
      workerId = await registerWorker(ctx, `e2e-upload-bounds-worker-${ctx.nonce}`);
      const lead = await ctx.connectMcp(leadId);
      conns.push(lead);
      const created = expectToolOk(
        await callTool(lead, "slack-create-channel", { name: `e2e-upload-${ctx.nonce}` }),
        "slack-create-channel",
      );
      channelId = asString(created.data.channelId, "created channel id");

      // A host-run API has no /workspace: the task directory is the only root there.
      taskDir = await mkdtemp(join(tmpdir(), "e2e-upload-task-"));
      otherDir = await mkdtemp(join(tmpdir(), "e2e-upload-other-"));
      const fileName = `inside-${ctx.nonce}.bin`;
      const filePath = join(taskDir, fileName);
      const body = randomBytes(3 * 1024 * 1024);
      await Bun.write(filePath, body);
      const otherName = `other-${ctx.nonce}.txt`;
      const otherPath = join(otherDir, otherName);
      await Bun.write(otherPath, `other body ${ctx.nonce}`);
      const announced = (name: string) =>
        ctx.slack
          .apiCalls("files.getUploadURLExternal")
          .some((call) => call.args.filename === name);
      const expectRefused = async (conn: McpConnection, path: string, label: string) => {
        const outcome = await callTool(conn, "slack-upload-file", { channelId, filePath: path });
        expect(outcome.isError, `slack-upload-file with ${label} was not refused`);
        expect(
          outcome.message.includes(OUTSIDE) || outcome.message.includes("File not found"),
          `slack-upload-file with ${label}: unexpected error ${outcome.message}`,
        );
      };
      const connectAs = async (agentId: string, taskId: string) => {
        const conn = await ctx.connectMcp(agentId, { headers: { "X-Source-Task-ID": taskId } });
        conns.push(conn);
        return conn;
      };

      // ===== without a task, only /workspace is allowed =====
      expectToolError(
        await callTool(lead, "slack-upload-file", { channelId, filePath }),
        OUTSIDE,
        "slack-upload-file with an absolute path outside /workspace and no task",
      );
      await expectRefused(lead, `${WORKSPACE}/..${filePath}`, "a /workspace path that climbs out");
      await expectRefused(lead, relative(WORKSPACE, filePath), "a relative path that climbs out");
      expect(!announced(fileName), "A file outside /workspace reached Slack without a task");

      // ===== the caller's own task directory is allowed, and the bytes arrive intact =====
      const ownTask = await createAssignedTask(ctx, leadId, `upload bounds ${ctx.nonce}`, {
        dir: taskDir,
      });
      taskIds.push(ownTask);
      const inTask = await connectAs(leadId, ownTask);
      const uploaded = expectToolOk(
        await callTool(inTask, "slack-upload-file", { channelId, filePath }),
        "slack-upload-file with a file in the task directory",
      );
      const fileId = asString(uploaded.data.fileId, "uploaded file id");
      expect(
        ctx.slack
          .apiCalls("files.getUploadURLExternal")
          .some(
            (call) => call.args.filename === fileName && Number(call.args.length) === body.length,
          ),
        "files.getUploadURLExternal did not announce the file with its name and size",
      );
      expect(
        ctx.slack
          .apiCalls("files.completeUploadExternal")
          .some((call) => call.ok && call.args.channel_id === channelId),
        "The upload was not shared to the channel",
      );
      const stored = ctx.slack.store.files.get(fileId)?.bytes;
      expect(
        !!stored && Buffer.from(stored).equals(body),
        `The uploaded bytes differ (${stored?.byteLength ?? 0} of ${body.length} bytes arrived)`,
      );

      // A symlink in the task directory that leads out, and a directory, are refused.
      const linkName = `link-${ctx.nonce}.txt`;
      await symlink(otherPath, join(taskDir, linkName));
      expectToolError(
        await callTool(inTask, "slack-upload-file", {
          channelId,
          filePath: join(taskDir, linkName),
        }),
        OUTSIDE,
        "slack-upload-file with a symlink that leads out of the task directory",
      );
      await mkdir(join(taskDir, "sub"));
      expectToolError(
        await callTool(inTask, "slack-upload-file", { channelId, filePath: join(taskDir, "sub") }),
        OUTSIDE,
        "slack-upload-file with a directory",
      );

      // ===== another agent's task directory and a task directory of "/" do not count =====
      const otherTask = await createAssignedTask(ctx, workerId, `upload other ${ctx.nonce}`, {
        dir: otherDir,
      });
      taskIds.push(otherTask);
      expectToolError(
        await callTool(await connectAs(leadId, otherTask), "slack-upload-file", {
          channelId,
          filePath: otherPath,
        }),
        OUTSIDE,
        "slack-upload-file from another agent's task directory",
      );
      const rootTask = await createAssignedTask(ctx, leadId, `upload root ${ctx.nonce}`, {
        dir: "/",
      });
      taskIds.push(rootTask);
      expectToolError(
        await callTool(await connectAs(leadId, rootTask), "slack-upload-file", {
          channelId,
          filePath: otherPath,
        }),
        OUTSIDE,
        "slack-upload-file with a task directory of /",
      );
      expect(!announced(linkName) && !announced(otherName), "A refused file reached Slack");

      // ===== a file under /workspace/shared uploads without a task =====
      // The API runs as a plain user on CI and dev machines, where /workspace does not exist.
      const canWrite = await mkdir(sharedDir, { recursive: true }).then(
        () => true,
        () => false,
      );
      if (!canWrite) {
        expectToolError(
          await callTool(lead, "slack-upload-file", {
            channelId,
            filePath: join(sharedDir, "missing.txt"),
          }),
          "File not found",
          "slack-upload-file with a missing file under /workspace/shared",
        );
        return;
      }
      const sharedName = `shared-${ctx.nonce}.txt`;
      await Bun.write(join(sharedDir, sharedName), `shared body ${ctx.nonce}`);
      for (const [path, label] of [
        [join(sharedDir, sharedName), "an absolute /workspace/shared path"],
        [relative(WORKSPACE, join(sharedDir, sharedName)), "a path relative to /workspace"],
      ] as const) {
        expectToolOk(
          await callTool(lead, "slack-upload-file", { channelId, filePath: path }),
          `slack-upload-file with ${label}`,
        );
      }
    });
  },
};
