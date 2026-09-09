import { parseArgs } from "node:util";

type Frame = {
  file: string;
  index: number;
  kind: string;
};

type Thread = {
  label: string;
  channel: string;
  ts: string;
  frames: Frame[];
  gif: string | null;
  finalThread: string;
  finalDesktop: string;
};

type Scenario = {
  name: string;
  status: string;
  error: string | null;
  threads: Thread[];
};

type VisualIndex = {
  profile: string;
  channel: string;
  scenarios: Scenario[];
};

type Profile = {
  name: string;
  /** Null when the profile has no index.json (its E2E run or render failed). */
  index: VisualIndex | null;
};

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function imageUrl(baseUrl: string, profile: string, file: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${profile.replace(/^\/+|\/+$/g, "")}/${file.replace(/^\/+/, "")}`;
}

function image(baseUrl: string, profile: string, file: string): string {
  return `<img src="${imageUrl(baseUrl, profile, file)}" width="420">`;
}

function table(profiles: Profile[], cells: (profile: Profile) => string): string[] {
  return [
    `| ${profiles.map((profile) => markdownCell(profile.name)).join(" | ")} |`,
    `| ${profiles.map(() => "---").join(" | ")} |`,
    `| ${profiles.map(cells).join(" | ")} |`,
  ];
}

function scenarioFor(profile: Profile, name: string): Scenario | undefined {
  return profile.index?.scenarios.find((scenario) => scenario.name === name);
}

function scenarioCell(
  profile: Profile,
  scenario: Scenario | undefined,
  baseUrl: string,
  file: (thread: Thread) => string | null,
  missingFile = "not recorded",
): string {
  if (!profile.index) return "not rendered";
  if (!scenario) return "not recorded";
  const files = scenario.threads.map(file);
  const images = files
    .map((value) => (value ? image(baseUrl, profile.name, value) : missingFile))
    .join("<br>");
  if (scenario.status !== "pass") {
    // A failed scenario may still have frames from the steps that ran before the failure.
    const status = `**${scenario.status.toUpperCase()}**: ${markdownCell(scenario.error ?? "No error reported")}`;
    return files.length === 0 ? status : `${status}<br>${images}`;
  }
  if (files.length === 0) return "not recorded";
  return images;
}

function mainSection(
  profiles: Profile[],
  scenarioNames: string[],
  baseUrl: string,
  intro: string,
  includeSteps: boolean,
): string[] {
  const lines = ["<!-- slack-visuals -->", "", "### Slack rendering preview", "", intro, ""];

  for (const name of scenarioNames) {
    lines.push(
      `#### ${name}`,
      "",
      ...table(profiles, (profile) =>
        scenarioCell(profile, scenarioFor(profile, name), baseUrl, (thread) => thread.finalThread),
      ),
    );
    if (includeSteps) {
      lines.push(
        "",
        "<details><summary>Step by step</summary>",
        "",
        ...table(profiles, (profile) => {
          const scenario = scenarioFor(profile, name);
          return scenarioCell(
            profile,
            scenario,
            baseUrl,
            (thread) => thread.gif,
            "no ffmpeg on the runner",
          );
        }),
        "",
        "</details>",
      );
    }
    lines.push("");
  }
  return lines;
}

function desktopSection(profiles: Profile[], scenarioNames: string[], baseUrl: string): string[] {
  const lines = ["<details><summary>Desktop layout and channel</summary>", ""];
  for (const name of scenarioNames) {
    lines.push(
      `##### ${name}`,
      "",
      ...table(profiles, (profile) =>
        scenarioCell(profile, scenarioFor(profile, name), baseUrl, (thread) => thread.finalDesktop),
      ),
      "",
    );
  }
  lines.push(
    "##### Channel",
    "",
    ...table(profiles, (profile) =>
      profile.index ? image(baseUrl, profile.name, profile.index.channel) : "not rendered",
    ),
    "",
    "</details>",
    "",
  );
  return lines;
}

async function readProfile(argument: string): Promise<Profile> {
  const separator = argument.indexOf("=");
  if (separator < 1 || separator === argument.length - 1) {
    throw new Error(`--profile must use NAME=DIR: ${argument}`);
  }
  const name = argument.slice(0, separator);
  const directory = argument.slice(separator + 1);
  const indexPath = `${directory.replace(/\/+$/, "")}/index.json`;
  if (!(await Bun.file(indexPath).exists())) {
    console.error(`${name}: no ${indexPath}; the column will read "not rendered"`);
    return { name, index: null };
  }
  try {
    return { name, index: (await Bun.file(indexPath).json()) as VisualIndex };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${indexPath}: ${message}`);
  }
}

const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    profile: { type: "string", multiple: true },
    out: { type: "string" },
    "run-url": { type: "string" },
    sha: { type: "string" },
  },
});

const baseUrl = required(values["base-url"], "--base-url");
const outputPath = required(values.out, "--out");
const profiles = await Promise.all((values.profile ?? []).map(readProfile));
if (profiles.length === 0) throw new Error("At least one --profile is required");
if (profiles.every((profile) => profile.index === null)) {
  throw new Error("No profile has an index.json; nothing to render");
}

const scenarioNames = [
  ...new Set(
    profiles.flatMap((profile) =>
      (profile.index?.scenarios ?? []).map((scenario) => scenario.name),
    ),
  ),
];
const sha = values.sha ? values.sha.slice(0, 7) : "unknown";
const run = values["run-url"] ? ` [Workflow run](${values["run-url"]}).` : "";
const intro = `Rendered by slack-mock from the black-box E2E journal. Commit ${sha}.${run}`;

function render(includeSteps: boolean, includeDesktop: boolean, note?: string): string {
  const lines = mainSection(profiles, scenarioNames, baseUrl, intro, includeSteps);
  if (includeDesktop) lines.push(...desktopSection(profiles, scenarioNames, baseUrl));
  if (note) lines.push(note, "");
  return lines.join("\n");
}

let comment = render(true, true);
if (comment.length > 60_000) {
  comment = render(
    true,
    false,
    "Desktop layout omitted because the comment exceeded 60,000 characters.",
  );
}
if (comment.length > 60_000) {
  comment = render(
    false,
    false,
    "Desktop layout and step-by-step images omitted because the comment exceeded 60,000 characters.",
  );
}
if (comment.length > 60_000) {
  const note =
    "Additional scenario content omitted because the comment exceeded 60,000 characters.";
  comment = `${comment.slice(0, 60_000 - note.length - 2)}\n\n${note}\n`;
}
await Bun.write(outputPath, comment);
