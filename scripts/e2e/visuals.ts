import { basename, join, resolve } from "node:path";
import { SlackMock, screenshot } from "@desplega.ai/slack-mock";

type ManifestThread = { label: string; channel: string; ts: string };
type ManifestScenario = {
  name: string;
  status: "pass" | "fail" | "skip";
  durationMs: number;
  error: string | null;
  threads: ManifestThread[];
};
type VisualManifest = {
  profile: string;
  sutEnv: Record<string, string>;
  journal: string;
  slackManifest: string;
  scenarios: ManifestScenario[];
};
type JournalEntry = {
  kind: string;
  message?: { ts?: string; thread_ts?: string };
};
type Frame = { file: string; index: number; kind: string };
type RenderedThread = ManifestThread & {
  frames: Frame[];
  gif: string | null;
  finalThread: string;
  finalDesktop: string;
};

const frameKinds = new Set([
  "message.add",
  "message.update",
  "message.delete",
  "reaction.add",
  "reaction.remove",
  "file.add",
]);

type Options = {
  visualsDir: string;
  noGif: boolean;
  width: number;
  height: number;
};

function dimension(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseOptions(args: string[]): Options {
  const visualsDir = args[0];
  if (!visualsDir || visualsDir.startsWith("--")) {
    throw new Error(
      "Usage: bun run e2e:visuals <visualsDir> [--no-gif] [--height 700] [--width 800]",
    );
  }
  const options: Options = {
    visualsDir: resolve(visualsDir),
    noGif: false,
    width: 800,
    height: 700,
  };
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--no-gif") {
      options.noGif = true;
      continue;
    }
    if (arg === "--height" || arg === "--width") {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      options[arg === "--height" ? "height" : "width"] = dimension(value, arg);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

async function renderFromJournal(
  dataFile: string,
  slackManifest: string,
  path: string,
  out: string,
  width: number,
  height: number,
): Promise<void> {
  const mock = await SlackMock.start({
    port: 0,
    seed: false,
    dataFile,
    manifest: slackManifest,
    log: false,
  });
  try {
    await screenshot(`${mock.baseUrl}${path}`, { out, width, height });
  } finally {
    await mock.stop();
  }
}

async function createGif(ffmpeg: string, threadDir: string, frameFiles: string[]): Promise<void> {
  const listPath = join(threadDir, "frames.txt");
  const lastFrame = basename(frameFiles.at(-1)!);
  const lines = frameFiles.flatMap((file) => [`file '${basename(file)}'`, "duration 1.2"]);
  lines.push(`file '${lastFrame}'`);
  await Bun.write(listPath, `${lines.join("\n")}\n`);
  try {
    const process = Bun.spawn(
      [
        ffmpeg,
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        basename(listPath),
        "-vf",
        "fps=2,scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer",
        "steps.gif",
      ],
      { cwd: threadDir, stdout: "ignore", stderr: "pipe" },
    );
    const stderr = new Response(process.stderr).text();
    const exitCode = await process.exited;
    if (exitCode !== 0) {
      throw new Error(`ffmpeg exited with ${exitCode}: ${(await stderr).slice(-1_000)}`);
    }
  } finally {
    await Bun.file(listPath)
      .delete()
      .catch(() => {});
  }
}

function relevantEntries(entries: JournalEntry[], threadTs: string): number[] {
  const result: number[] = [];
  for (const [index, entry] of entries.entries()) {
    if (
      frameKinds.has(entry.kind) &&
      (entry.message?.ts === threadTs || entry.message?.thread_ts === threadTs)
    ) {
      result.push(index + 1);
    }
  }
  return result;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const manifest = JSON.parse(
    await Bun.file(join(options.visualsDir, "manifest.json")).text(),
  ) as VisualManifest;
  const journalPath = join(options.visualsDir, manifest.journal);
  const journalLines = (await Bun.file(journalPath).text())
    .split("\n")
    .filter((line) => line.trim() !== "");
  const entries = journalLines.map((line) => JSON.parse(line) as JournalEntry);
  const prefixDir = (await Bun.$`mktemp -d`.text()).trim();
  const ffmpeg = options.noGif ? undefined : Bun.which("ffmpeg");
  if (!options.noGif && !ffmpeg) console.log("ffmpeg not found; step GIFs will be omitted.");

  try {
    const renderedScenarios: Array<{
      name: string;
      status: "pass" | "fail" | "skip";
      error: string | null;
      threads: RenderedThread[];
    }> = [];

    for (const scenario of manifest.scenarios) {
      const renderedThreads: RenderedThread[] = [];
      for (const thread of scenario.threads) {
        const relativeDir = `frames/${scenario.name}/${thread.label}`;
        const threadDir = join(options.visualsDir, relativeDir);
        await Bun.$`mkdir -p ${threadDir}`.quiet();
        const indexes = relevantEntries(entries, thread.ts);
        if (indexes.length === 0) {
          throw new Error(
            `No visual journal events found for ${thread.channel} thread ${thread.ts}`,
          );
        }

        const frames: Frame[] = [];
        const frameFiles: string[] = [];
        for (const [frameIndex, journalIndex] of indexes.entries()) {
          const entry = entries[journalIndex - 1]!;
          const prefixPath = join(prefixDir, `prefix-${journalIndex}.jsonl`);
          await Bun.write(prefixPath, `${journalLines.slice(0, journalIndex).join("\n")}\n`);
          const frameName = `${String(frameIndex + 1).padStart(2, "0")}-${entry.kind}.png`;
          const relativeFrame = `${relativeDir}/${frameName}`;
          const frameFile = join(options.visualsDir, relativeFrame);
          await renderFromJournal(
            prefixPath,
            manifest.slackManifest,
            `/c/${thread.channel}/t/${thread.ts}`,
            frameFile,
            options.width,
            options.height,
          );
          frames.push({ file: relativeFrame, index: journalIndex, kind: entry.kind });
          frameFiles.push(frameFile);
        }

        const finalThread = `${relativeDir}/final-thread.png`;
        await Bun.write(join(options.visualsDir, finalThread), Bun.file(frameFiles.at(-1)!));
        const gif = ffmpeg ? `${relativeDir}/steps.gif` : null;
        if (ffmpeg) await createGif(ffmpeg, threadDir, frameFiles);
        renderedThreads.push({
          ...thread,
          frames,
          gif,
          finalThread,
          finalDesktop: `${relativeDir}/final-desktop.png`,
        });
      }
      renderedScenarios.push({
        name: scenario.name,
        status: scenario.status,
        error: scenario.error,
        threads: renderedThreads,
      });
    }

    const firstThread = renderedScenarios.flatMap((scenario) => scenario.threads)[0];
    if (!firstThread) throw new Error("The visual manifest has no marked Slack threads");
    const fullMock = await SlackMock.start({
      port: 0,
      seed: false,
      dataFile: journalPath,
      manifest: manifest.slackManifest,
      log: false,
    });
    try {
      for (const scenario of renderedScenarios) {
        for (const thread of scenario.threads) {
          await screenshot(`${fullMock.baseUrl}/c/${thread.channel}/t/${thread.ts}?screenshot=0`, {
            out: join(options.visualsDir, thread.finalDesktop),
            width: 1280,
            height: 900,
          });
        }
      }
      await screenshot(`${fullMock.baseUrl}/c/${firstThread.channel}`, {
        out: join(options.visualsDir, "channel.png"),
        width: 800,
        height: 700,
      });
    } finally {
      await fullMock.stop();
    }

    await Bun.write(
      join(options.visualsDir, "index.json"),
      `${JSON.stringify(
        {
          profile: manifest.profile,
          channel: "channel.png",
          scenarios: renderedScenarios,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await Bun.$`rm -rf ${prefixDir}`.quiet();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
