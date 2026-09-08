#!/usr/bin/env bun

export {};

const SKILL_DIRECTORY = "skills/agent-swarm";
const SKILL_FILE = `${SKILL_DIRECTORY}/SKILL.md`;
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const GITHUB_BLOB_URL =
  /https?:\/\/github\.com\/desplega-ai\/agent-swarm\/blob\/main\/[^\s<>()\]}"',`]+/g;
const DOCS_URL =
  /https?:\/\/docs\.agent-swarm\.dev(?:[/?#:][^\s<>()\]}"',`]*)?(?=$|[\s<>()\]}"',`])/g;
const REQUEST_TIMEOUT_MS = 10_000;
const REQUEST_ATTEMPTS = 3;

type Source = {
  path: string;
  text: string;
};

async function gitFiles(): Promise<Set<string>> {
  const process = Bun.spawn(["git", "ls-files", "-z"], { stdout: "pipe", stderr: "pipe" });
  const [output, code] = await Promise.all([new Response(process.stdout).text(), process.exited]);

  if (code !== 0) {
    throw new Error("git ls-files failed while checking operator skill links.");
  }

  return new Set(output.split("\0").filter(Boolean));
}

async function sources(): Promise<Source[]> {
  const skill = Bun.file(SKILL_FILE);
  if (!(await skill.exists())) {
    return [];
  }

  const result: Source[] = [{ path: SKILL_FILE, text: await skill.text() }];
  const references = new Bun.Glob("references/*.md");
  for await (const reference of references.scan({ cwd: SKILL_DIRECTORY })) {
    const path = `${SKILL_DIRECTORY}/${reference}`;
    const file = Bun.file(path);
    if (await file.exists()) {
      result.push({ path, text: await file.text() });
    }
  }
  return result;
}

function collectUrls(
  source: Source,
  pattern: RegExp,
  urls: Map<string, Set<string>>,
  problems: string[],
): void {
  for (const match of source.text.matchAll(pattern)) {
    const reported = match[0].replace(/[.,;:!?]+$/, "");
    try {
      const url = new URL(reported);
      const network = new URL(url);
      network.hash = "";
      const reports = urls.get(network.href) ?? new Set<string>();
      reports.add(reported);
      urls.set(network.href, reports);
    } catch {
      problems.push(`${source.path}: invalid URL ${reported}`);
    }
  }
}

async function checkDocumentationUrls(
  urls: Map<string, Set<string>>,
  problems: string[],
): Promise<void> {
  for (const [networkUrl, reportedUrls] of urls) {
    let lastError = "";
    let succeeded = false;

    for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(networkUrl, {
          method: "HEAD",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status === 200) {
          succeeded = true;
          break;
        }
        lastError = `returned HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    if (!succeeded) {
      problems.push(
        `${[...reportedUrls].join(", ")}: ${lastError} after ${REQUEST_ATTEMPTS} HEAD attempts`,
      );
    }
  }
}

async function main(): Promise<void> {
  const problems: string[] = [];
  const skill = Bun.file(SKILL_FILE);
  if (!(await skill.exists())) {
    problems.push(`${SKILL_FILE}: required file is missing`);
  }

  const sourceFiles = await sources();
  const skillSource = sourceFiles.find((source) => source.path === SKILL_FILE);
  if (skillSource) {
    const match = skillSource.text.match(FRONTMATTER);
    if (!match) {
      problems.push(`${SKILL_FILE}: valid YAML frontmatter is required`);
    } else {
      try {
        const frontmatter = Bun.YAML.parse(match[1]);
        if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
          problems.push(`${SKILL_FILE}: frontmatter must be a YAML object`);
        } else {
          const { name, description } = frontmatter as Record<string, unknown>;
          if (name !== "agent-swarm") {
            problems.push(`${SKILL_FILE}: frontmatter name must be "agent-swarm"`);
          }
          if (typeof description !== "string" || description.trim().length === 0) {
            problems.push(`${SKILL_FILE}: frontmatter description must be a nonempty string`);
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        problems.push(`${SKILL_FILE}: invalid YAML frontmatter (${detail})`);
      }
    }
  }

  const files = await gitFiles();
  const githubUrls = new Map<string, Set<string>>();
  const documentationUrls = new Map<string, Set<string>>();
  for (const source of sourceFiles) {
    collectUrls(source, GITHUB_BLOB_URL, githubUrls, problems);
    collectUrls(source, DOCS_URL, documentationUrls, problems);
  }

  for (const [networkUrl, reportedUrls] of githubUrls) {
    try {
      const pathname = decodeURIComponent(new URL(networkUrl).pathname);
      const path = pathname.replace("/desplega-ai/agent-swarm/blob/main/", "");
      if (!files.has(path) || !(await Bun.file(path).exists())) {
        problems.push(`${[...reportedUrls].join(", ")}: references missing tracked file ${path}`);
      }
    } catch {
      problems.push(`${[...reportedUrls].join(", ")}: has an invalid encoded pathname`);
    }
  }

  await checkDocumentationUrls(documentationUrls, problems);

  if (problems.length > 0) {
    console.error(`Operator skill check failed (${problems.length} problem(s)):`);
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }

  console.log(
    `Operator skill check passed (${sourceFiles.length} file(s), ${githubUrls.size} GitHub link(s), ${documentationUrls.size} documentation URL(s)).`,
  );
}

await main();
