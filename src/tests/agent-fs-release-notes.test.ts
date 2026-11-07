import { describe, expect, test } from "bun:test";
import { renderAgentFsReleaseNotes } from "../../scripts/agent-fs-release-notes";

const currentYaml = 'agentFs:\n  image:\n    tag: "0.18.11"\n';
const unchangedSection = `## agent-fs

Ships [agent-fs 0.18.11](https://github.com/desplega-ai/agent-fs/releases/tag/v0.18.11).

agent-swarm pins agent-fs via the chart image tag and npm packages \`@desplega.ai/agent-fs\` and \`@desplega.ai/agent-fs-just-bash\`; each agent-fs release needs a \`chore(deps): bump agent-fs pins\` PR here.`;

describe("agent-fs release notes", () => {
  test("renders the bump when the version changed", () => {
    expect(renderAgentFsReleaseNotes(currentYaml, 'agentFs:\n  image:\n    tag: "0.18.9"\n')).toBe(
      unchangedSection.replace(").\n", ") (bumped from 0.18.9).\n"),
    );
  });

  test("omits the bump when the version is unchanged", () => {
    expect(renderAgentFsReleaseNotes(currentYaml, currentYaml)).toBe(unchangedSection);
  });

  test("omits the bump when there is no previous release tag", () => {
    expect(renderAgentFsReleaseNotes(currentYaml)).toBe(unchangedSection);
  });

  test("omits the bump when the previous chart has no agentFs.image.tag", () => {
    expect(renderAgentFsReleaseNotes(currentYaml, "agentFs:\n  image: {}\n")).toBe(
      unchangedSection,
    );
  });

  test.each([
    "agentFs:\n  image: {}\n",
    'agentFs:\n  image:\n    tag: ""\n',
  ])("fails loudly when the current chart tag is missing or empty: %s", (yaml) => {
    expect(() => renderAgentFsReleaseNotes(yaml)).toThrow(
      "Current chart is missing agentFs.image.tag",
    );
  });
});
