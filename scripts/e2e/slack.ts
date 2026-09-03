import { randomBytes } from "node:crypto";
import { SlackMock } from "@desplega.ai/slack-mock";
import { repoRoot } from "./sut";

export type SlackHarness = { mock: SlackMock; dataFile?: string };

// Started before the SUT so the API server finds a live mock Slack on boot.
export async function startSlackMock(keep: boolean): Promise<SlackHarness> {
  const stamp = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const dataFile = keep ? `/tmp/e2e-slack-${stamp}.jsonl` : undefined;
  const mock = await SlackMock.start({
    port: 0,
    manifest: `${repoRoot}/slack-manifest.json`,
    ...(dataFile ? { dataFile } : {}),
  });
  return { mock, dataFile };
}

export async function stopSlackMock(slack: SlackHarness, keep: boolean): Promise<void> {
  await slack.mock.stop();
  if (keep && slack.dataFile) console.log(`KEEP slack data: ${slack.dataFile}`);
}
