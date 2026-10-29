import { $ } from "bun";

function imageTag(yaml: string): string {
  const values = Bun.YAML.parse(yaml) as { agentFs?: { image?: { tag?: string } } };
  return values.agentFs?.image?.tag ?? "";
}

export function renderAgentFsReleaseNotes(currentYaml: string, previousYaml?: string): string {
  const version = imageTag(currentYaml);
  if (!version) throw new Error("Current chart is missing agentFs.image.tag");

  const previousVersion = previousYaml === undefined ? "" : imageTag(previousYaml);
  const bump =
    previousVersion && previousVersion !== version ? ` (bumped from ${previousVersion})` : "";

  return `## agent-fs

Ships [agent-fs ${version}](https://github.com/desplega-ai/agent-fs/releases/tag/v${version})${bump}.

agent-swarm pins agent-fs via the chart image tag and npm packages \`@desplega.ai/agent-fs\` and \`@desplega.ai/agent-fs-just-bash\`; each agent-fs release needs a \`chore(deps): bump agent-fs pins\` PR here.`;
}

if (import.meta.main) {
  const tag = Bun.argv[2];
  if (!tag) throw new Error("Usage: bun scripts/agent-fs-release-notes.ts <release-tag>");

  const currentYaml = await $`git show ${`${tag}:charts/agent-swarm/values.yaml`}`.text();
  const previousTagResult = await $`git describe --tags --abbrev=0 --match 'v[0-9]*' ${`${tag}^`}`
    .quiet()
    .nothrow();
  const previousTag = previousTagResult.exitCode === 0 ? previousTagResult.text().trim() : "";
  const previousYaml = previousTag
    ? await $`git show ${`${previousTag}:charts/agent-swarm/values.yaml`}`.text()
    : undefined;
  console.log(renderAgentFsReleaseNotes(currentYaml, previousYaml));
}
