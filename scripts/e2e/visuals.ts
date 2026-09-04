import { basename, join, relative, resolve } from "node:path";
import { frames, SlackMock, screenshot } from "@desplega.ai/slack-mock";

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
type Frame = { file: string; index: number; kind: string };
type RenderedThread = ManifestThread & {
  frames: Frame[];
  gif: string | null;
  finalThread: string;
  finalDesktop: string;
};

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

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const manifest = JSON.parse(
    await Bun.file(join(options.visualsDir, "manifest.json")).text(),
  ) as VisualManifest;
  const journalPath = join(options.visualsDir, manifest.journal);
  const ffmpeg = options.noGif ? undefined : Bun.which("ffmpeg");
  if (!options.noGif && !ffmpeg) console.log("ffmpeg not found; step GIFs will be omitted.");
  const relativeTo = (path: string) => relative(options.visualsDir, path);

  const renderedScenarios: Array<{
    name: string;
    status: "pass" | "fail" | "skip";
    error: string | null;
    threads: RenderedThread[];
  }> = [];

  for (const scenario of manifest.scenarios) {
    const renderedThreads: RenderedThread[] = [];
    for (const thread of scenario.threads) {
      const threadDir = join(options.visualsDir, "frames", scenario.name, thread.label);
      // One PNG per journal line that touched the thread, plus final-thread.png and
      // final-desktop.png, all rendered by slack-mock from the journal in memory.
      const result = await frames({
        journal: journalPath,
        channel: thread.channel,
        thread: thread.ts,
        out: threadDir,
        manifest: manifest.slackManifest,
        width: options.width,
        height: options.height,
      });
      const frameFiles = result.frames.map((frame) => frame.path);
      const gif = ffmpeg ? relativeTo(join(threadDir, "steps.gif")) : null;
      if (ffmpeg) await createGif(ffmpeg, threadDir, frameFiles);
      renderedThreads.push({
        ...thread,
        frames: result.frames.map((frame) => ({
          file: relativeTo(frame.path),
          index: frame.index,
          kind: frame.kind,
        })),
        gif,
        finalThread: relativeTo(result.finalThread),
        finalDesktop: relativeTo(result.finalDesktop!),
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
  // The channel view after the whole run: one screenshot, so serve the full journal once
  // instead of rendering a frame per channel event.
  const mock = await SlackMock.start({
    port: 0,
    seed: false,
    dataFile: journalPath,
    manifest: manifest.slackManifest,
    log: false,
  });
  try {
    await screenshot(`${mock.baseUrl}/c/${firstThread.channel}`, {
      out: join(options.visualsDir, "channel.png"),
      width: 800,
      height: 700,
    });
  } finally {
    await mock.stop();
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
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
