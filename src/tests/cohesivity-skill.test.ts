import { describe, expect, test } from "bun:test";

const skillPath = `${import.meta.dir}/../../templates/skills/cohesivity/SKILL.md`;
const skill = await Bun.file(skillPath).text();
const curlBlocks = [...skill.matchAll(/```bash\n(curl[\s\S]*?)\n```/g)].map(
  (match) => match[1] ?? "",
);

describe("cohesivity skill template", () => {
  test("keeps the shared tenant in swarm config under three keys", () => {
    expect(skill).toContain('get-config(key="COHESIVITY_TENANT_ID", includeSecrets=true)');
    for (const key of [
      "COHESIVITY_TENANT_ID",
      "COHESIVITY_MANAGEMENT_KEY",
      "COHESIVITY_APPLICATION_KEY",
    ]) {
      expect(skill).toContain(`| \`${key}\` |`);
    }
    expect(skill).toContain('`set-config` (`scope="global"`, `isSecret=true`)');
  });

  test("creates the tenant with one create_tenant call to the hosted MCP server", () => {
    const create = curlBlocks.find((block) => block.includes('"create_tenant"'));
    expect(create).toBeDefined();
    expect(create).toContain("curl -sS https://cohesivity.ai/mcp");
    const body = create?.match(/-d '(\{.*\})'/)?.[1];
    expect(JSON.parse(body ?? "")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_tenant",
        arguments: { confirmed: true, attribution: "gh-agent-swarm" },
      },
    });
    expect(create).toContain(".result.structuredContent.credentials_file.content");
  });

  test("sends an explicit User-Agent on every curl call", () => {
    expect(curlBlocks.length).toBe(4);
    for (const block of curlBlocks) {
      expect(block).toContain("-H 'User-Agent: agent-swarm'");
    }
  });

  test("provisions with the management key and queries with the application key", () => {
    expect(skill).toContain("curl -sS -X POST https://cohesivity.ai/api/resources/postgres");
    expect(skill).toContain('-H "Authorization: Bearer $COHESIVITY_MANAGEMENT_KEY"');
    expect(skill).toContain(
      'curl -sS -X POST "https://cohesivity.ai/edge/postgres?key=$COHESIVITY_APPLICATION_KEY"',
    );
  });
});
