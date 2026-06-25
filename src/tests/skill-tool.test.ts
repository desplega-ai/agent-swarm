import { afterEach, describe, expect, test } from "bun:test";
import {
  loadAiSdkAgentSkillContent,
  resolveAvailableSkillByName,
} from "../providers/ai-sdk-agent-skill-tool";

const installedSkills = [
  {
    id: "skill-1",
    name: "work-on-task",
    description: "Task lifecycle",
    content: "# Work on Task\n\nFollow the lifecycle.",
  },
  {
    id: "skill-2",
    name: "browser-use-cloud",
    description: "Drive a real cloud browser through blocked pages",
    content: "# Browser Use Cloud\n\nUse the browser API.",
  },
];

function fakeClient(skills: typeof installedSkills) {
  return {
    callTool: async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe("skill-list");
      expect(args).toEqual({ installedOnly: true, includeContent: true });
      return {
        content: [{ type: "text", text: `Found ${skills.length} skill(s).` }],
        structuredContent: {
          success: true,
          skills,
          total: skills.length,
        },
      };
    },
  };
}

describe("ai-sdk-agent Skill tool", () => {
  afterEach(() => {
    delete process.env.MAX_SKILL_CHARS;
  });

  test("loads an installed skill by normalized exact name", async () => {
    const resolved = resolveAvailableSkillByName("/work_on_task", installedSkills);
    const content = await loadAiSdkAgentSkillContent({
      client: fakeClient(installedSkills),
      name: "/work_on_task",
    });

    expect(resolved.skill?.id).toBe("skill-1");
    expect(resolved.matchedBy).toBe("exact");
    expect(content).toBe(installedSkills[0].content);
  });

  test("falls back to fuzzy matching within installed skills", async () => {
    const resolved = resolveAvailableSkillByName("blocked pages", installedSkills);
    const content = await loadAiSdkAgentSkillContent({
      client: fakeClient(installedSkills),
      name: "blocked pages",
    });

    expect(resolved.skill?.id).toBe("skill-2");
    expect(resolved.matchedBy).toBe("fuzzy");
    expect(content).toBe(installedSkills[1].content);
  });

  test("does not load unavailable skills", async () => {
    const resolved = resolveAvailableSkillByName("private-skill", installedSkills);
    const content = await loadAiSdkAgentSkillContent({
      client: fakeClient(installedSkills),
      name: "private-skill",
    });

    expect(resolved.skill).toBeNull();
    expect(content).toContain('Skill "private-skill" not found for this agent.');
    expect(content).toContain("work-on-task, browser-use-cloud");
  });

  test("truncates loaded content using MAX_SKILL_CHARS", async () => {
    process.env.MAX_SKILL_CHARS = "10";
    const content = await loadAiSdkAgentSkillContent({
      client: fakeClient([
        {
          id: "skill-3",
          name: "large-skill",
          description: "Large skill",
          content: "0123456789abcdef",
        },
      ]),
      name: "large-skill",
    });

    expect(content).toBe("0123456789");
  });
});
