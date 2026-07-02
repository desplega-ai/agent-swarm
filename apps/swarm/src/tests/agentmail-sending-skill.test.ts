import { describe, expect, test } from "bun:test";

const skillPath = `${import.meta.dir}/../../templates/skills/agentmail-sending/SKILL.md`;
const skill = await Bun.file(skillPath).text();
const curlInboxVariable = "$" + "{INBOX}";
const scriptApiKeyVariable = "$" + "{apiKey}";

function requireMatch(pattern: RegExp, label: string): RegExpMatchArray {
  const match = skill.match(pattern);
  if (!match) {
    throw new Error(`Missing ${label}`);
  }
  return match;
}

describe("agentmail-sending skill template", () => {
  test("pins the canonical base URL and rejects the hallucinated host", () => {
    expect(skill).toContain("```text\nhttps://api.agentmail.to/v0/\n```");
    expect(skill).toContain("DO NOT use `api.agentmail.ai`");
    expect(skill).not.toContain("https://api.agentmail.ai");
  });

  test("pins send-message field names and text-only guidance", () => {
    expect(skill).toContain("```text\nto\nbcc\nsubject\ntext\n```");
    expect(skill).toContain("Use `text`, NOT `text_body`, `body`, or `content`.");
    expect(skill).toContain("Do NOT pass `html`.");
  });

  test("curl example uses the canonical endpoint, bearer auth, and exact JSON fields", () => {
    expect(skill).toContain("https://api.agentmail.to/v0/inboxes/{inbox}/messages/send");
    expect(skill).toContain(
      [
        'curl -sS -X POST "https://api.agentmail.to/v0/inboxes/',
        curlInboxVariable,
        '/messages/send"',
      ].join(""),
    );
    expect(skill).toContain('-H "Authorization: Bearer $AGENTMAIL_API_KEY"');

    const jsonBlock = requireMatch(
      /--data-binary @- <<'JSON'\n([\s\S]*?)\nJSON/,
      "curl JSON body",
    )[1];
    const payload = JSON.parse(jsonBlock);

    expect(Object.keys(payload)).toEqual(["to", "bcc", "subject", "text"]);
    expect(payload).not.toHaveProperty("text_body");
    expect(payload).not.toHaveProperty("body");
    expect(payload).not.toHaveProperty("content");
    expect(payload).not.toHaveProperty("html");
  });

  test("script_upsert example uses fetch and resolves AGENTMAIL_API_KEY from swarm config", () => {
    const scriptBlock = requireMatch(/```ts\n([\s\S]*?)\n```/, "script_upsert example")[1];

    expect(scriptBlock).toContain("await script_upsert({");
    expect(scriptBlock).toContain("ctx.swarm.config.get('AGENTMAIL_API_KEY')");
    expect(scriptBlock).toContain("ctx.stdlib.fetch(");
    expect(scriptBlock).toContain("https://api.agentmail.to/v0/inboxes/");
    expect(scriptBlock).toContain("messages/send");
    expect(scriptBlock).toContain(
      ["Authorization: \\`Bearer \\", scriptApiKeyVariable, "\\`"].join(""),
    );
    expect(scriptBlock).toContain("text: args.text");
    expect(scriptBlock).not.toContain("text_body");
    expect(scriptBlock).not.toContain("html:");
  });

  test("common error table covers known AgentMail mistakes", () => {
    expect(skill).toContain("404 on `/v0/inboxes/.../send`");
    expect(skill).toContain('422 `{"detail":"text Field required"}`');
    expect(skill).toContain("401");
    expect(skill).toContain("HTML rendering bug");
  });
});
