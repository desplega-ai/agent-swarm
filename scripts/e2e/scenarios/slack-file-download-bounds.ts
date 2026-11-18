import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "../http";
import type { McpConnection } from "../mcp";
import type { Scenario } from "../run";
import {
  Cleanup,
  callTool,
  expectToolError,
  expectToolOk,
  registerWorker,
  retireAgent,
  type ToolOutcome,
} from "./platformb-helpers";

const DOWNLOAD_ROOT = "/workspace/shared/downloads";
const OUTSIDE_ROOT = `must be inside ${DOWNLOAD_ROOT}`;
const NO_SLACK_FILE = "Could not identify the Slack file in that URL; pass fileId instead.";

/**
 * A save under the download directory either lands there with the right bytes, or (on a host
 * where the API cannot create that directory) fails with a disk error. It is never refused by
 * the path or host checks.
 */
async function expectSavedUnderRoot(
  outcome: ToolOutcome,
  expectedPath: string,
  body: string,
  label: string,
) {
  if (!outcome.isError) {
    expectToolOk(outcome, label);
    expect(outcome.data.savedPath === expectedPath, `${label}: saved at ${outcome.data.savedPath}`);
    expect((await Bun.file(expectedPath).text()) === body, `${label}: the saved bytes differ`);
    return;
  }
  expect(
    !outcome.message.includes(OUTSIDE_ROOT) && !outcome.message.includes("not a Slack file URL"),
    `${label}: a save under ${DOWNLOAD_ROOT} was refused: ${outcome.message}`,
  );
}

/**
 * slack-download-file without a task: the bot token goes only to the URL Slack returns for the
 * file, and the file is saved only inside /workspace/shared/downloads.
 */
export const slackFileDownloadBounds: Scenario = {
  name: "slack-file-download-bounds",
  order: 681,
  async run(ctx) {
    const cleanup = new Cleanup();
    let workerId: string | undefined;
    let workerConn: McpConnection | undefined;
    let scratchDir: string | undefined;
    const seen: { path: string; authorization: string | null }[] = [];
    const listener = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push({
          path: new URL(req.url).pathname,
          authorization: req.headers.get("authorization"),
        });
        return new Response("not a Slack file");
      },
    });
    const subdir = `e2e-bounds-${ctx.nonce}`;
    cleanup.add("close MCP", async () => {
      await workerConn?.close();
    });
    cleanup.add("retire worker", () => retireAgent(ctx, workerId));
    cleanup.add("stop listener", () => listener.stop(true));
    cleanup.add("remove saved files", async () => {
      if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
      await rm(join(DOWNLOAD_ROOT, subdir), { recursive: true, force: true });
    });

    await cleanup.around(async () => {
      workerId = await registerWorker(ctx, `e2e-slack-bounds-worker-${ctx.nonce}`);
      workerConn = await ctx.connectMcp(workerId);
      scratchDir = await mkdtemp(join(tmpdir(), "e2e-slack-bounds-"));
      const body = `bounds body ${ctx.nonce}`;
      const name = `bounds-${ctx.nonce}.txt`;
      const file = ctx.slack.store.addFile({
        name,
        user: "U0E2EBOUND",
        bytes: new TextEncoder().encode(body),
        baseUrl: ctx.slack.baseUrl,
      });
      const listenerUrl = `http://127.0.0.1:${listener.port}`;

      // ===== the bot token goes only to the URL Slack returns =====
      expectToolError(
        await callTool(workerConn, "slack-download-file", {
          url: `${listenerUrl}/report.txt`,
          savePath: `${subdir}/`,
        }),
        NO_SLACK_FILE,
        "a URL with no Slack file in it",
      );
      // A URL that names a real file on another host downloads from Slack's own URL.
      await expectSavedUnderRoot(
        await callTool(workerConn, "slack-download-file", {
          url: `${listenerUrl}/files-pri/T0TEAM-${file.id}/download/${name}`,
          savePath: `${subdir}/via-other-host/`,
        }),
        join(DOWNLOAD_ROOT, subdir, "via-other-host", name),
        body,
        "a Slack file id on another host",
      );
      expect(
        seen.length === 0,
        `The other host got requests: ${JSON.stringify(seen.map((request) => request.path))}`,
      );

      // ===== the file is saved only inside the download directory =====
      for (const [savePath, label] of [
        [`${scratchDir}/`, "an absolute directory outside the root"],
        [join(scratchDir, "named.txt"), "an absolute file outside the root"],
        [`../escape-${ctx.nonce}.txt`, "a relative path that climbs out of the root"],
        [`${DOWNLOAD_ROOT}/../escape-${ctx.nonce}.txt`, "a root path that climbs out of it"],
      ] as const) {
        expectToolError(
          await callTool(workerConn, "slack-download-file", { fileId: file.id, savePath }),
          OUTSIDE_ROOT,
          `slack-download-file to ${label}`,
        );
      }
      expect(
        (await readdir(scratchDir)).length === 0,
        "A refused download wrote into the scratch directory",
      );

      // ===== legitimate saves under the root still work =====
      await expectSavedUnderRoot(
        await callTool(workerConn, "slack-download-file", {
          fileId: file.id,
          savePath: `${subdir}/`,
        }),
        join(DOWNLOAD_ROOT, subdir, name),
        body,
        "by id into a relative directory",
      );
      await expectSavedUnderRoot(
        await callTool(workerConn, "slack-download-file", {
          url: file.url_private_download,
          savePath: join(DOWNLOAD_ROOT, subdir, "by-url.txt"),
        }),
        join(DOWNLOAD_ROOT, subdir, "by-url.txt"),
        body,
        "by Slack URL into an absolute file under the root",
      );
      // A filename with directories in it keeps only its last part.
      await expectSavedUnderRoot(
        await callTool(workerConn, "slack-download-file", {
          fileId: file.id,
          savePath: `${subdir}/`,
          filename: "../../flat.txt",
        }),
        join(DOWNLOAD_ROOT, subdir, "flat.txt"),
        body,
        "a filename with directories",
      );
    });
  },
};
