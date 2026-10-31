import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  callTool,
  cancelTask,
  dbCount,
  ensureLead,
  expectToolError,
  expectToolOk,
  registerAgent,
  UUID,
} from "./knowledge-helpers";

function skillMarkdown(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

export const knowledgeSkills: Scenario = {
  name: "knowledge-skills",
  order: 520,
  async run(ctx) {
    const owner = await registerAgent(ctx, "skill-owner");
    const other = await registerAgent(ctx, "skill-other");
    const lead = await ensureLead(ctx);
    const sessionOwner = await ctx.connectMcp(owner);
    const sessionOther = await ctx.connectMcp(other);
    const sessionLead = await ctx.connectMcp(lead);
    const cleanupSkills: string[] = [];
    const cleanupTasks: string[] = [];
    try {
      // ── Seeded catalog ──────────────────────────────────────────────────────────────────────
      let response = await ctx.api("GET", "/api/skills");
      expectStatus(response, [200], "list skills");
      const listing = asRecord(response.json);
      const seeded = asRecords(listing, "skills");
      expect(
        typeof listing.total === "number" && listing.total === seeded.length && seeded.length > 0,
        "the skills list must carry the seeded catalog and a matching total",
      );
      const systemSkill = seeded.find((skill) => skill.systemDefault === true);
      expect(systemSkill, "no system-default skill was seeded at boot");
      const systemId = asString(systemSkill.id, "system skill id");
      expect(
        seeded.every((skill) => skill.content === ""),
        "the default list must omit skill content",
      );
      response = await ctx.api("GET", `/api/skills?fields=full&search=${systemSkill.name}`);
      expectStatus(response, [200], "list skills with fields=full");
      const full = asRecords(response.json, "skills").find((skill) => skill.id === systemId);
      expect(
        full && typeof full.content === "string" && full.content.length > 0,
        "fields=full must include the skill content",
      );

      // ── HTTP create / read / filter ─────────────────────────────────────────────────────────
      const httpName = `e2e-skill-http-${ctx.nonce}`;
      response = await ctx.api("POST", "/api/skills", {
        body: {
          content: skillMarkdown(httpName, "HTTP skill under test", "Step one. Step two."),
          scope: "agent",
          ownerAgentId: owner,
        },
      });
      expectStatus(response, [201], "create skill over HTTP");
      let skill = asRecord(asRecord(response.json).skill);
      const httpId = asString(skill.id, "created skill id");
      cleanupSkills.push(httpId);
      expect(UUID.test(httpId), "skill id is a UUID");
      expect(
        skill.name === httpName &&
          skill.description === "HTTP skill under test" &&
          skill.type === "personal" &&
          skill.scope === "agent" &&
          skill.ownerAgentId === owner &&
          skill.version === 1 &&
          skill.isEnabled === true &&
          skill.systemDefault === false,
        `created skill fields: ${JSON.stringify(skill)}`,
      );
      expect(
        dbCount(ctx, "SELECT count(*) AS n FROM skills WHERE id = ? AND name = ?", [
          httpId,
          httpName,
        ]) === 1,
        "skill row was not persisted",
      );
      response = await ctx.api("POST", "/api/skills", {
        body: { content: skillMarkdown(httpName, "dup", "dup"), ownerAgentId: owner },
      });
      expectStatus(response, [400], "duplicate skill name in the same scope");
      response = await ctx.api("POST", "/api/skills", { body: { content: "no frontmatter" } });
      expectStatus(response, [400], "create skill without frontmatter");
      response = await ctx.api("POST", "/api/skills", {
        body: { content: "---\nname: only-a-name\n---\nbody" },
      });
      expectStatus(response, [400], "create skill without a description");
      response = await ctx.api("POST", "/api/skills", { body: { content: "" } });
      expectStatus(response, [400], "create skill with empty content");

      response = await ctx.api("GET", `/api/skills/${httpId}`);
      expectStatus(response, [200], "get skill");
      skill = asRecord(response.json);
      expect(
        String(skill.content).includes("Step one."),
        "GET /api/skills/{id} must include the content",
      );
      response = await ctx.api("GET", `/api/skills/${crypto.randomUUID()}`);
      expectStatus(response, [404], "get unknown skill");

      response = await ctx.api("GET", `/api/skills?scope=agent&agentId=${owner}&type=personal`);
      expectStatus(response, [200], "list skills with filters");
      expect(
        asRecords(response.json, "skills").some((row) => row.id === httpId),
        "scope/agent/type filter lost the skill",
      );
      response = await ctx.api("GET", `/api/skills?search=${encodeURIComponent(httpName)}`);
      expectStatus(response, [200], "search skills over HTTP");
      expect(
        asRecords(response.json, "skills").some((row) => row.id === httpId),
        "search lost the skill",
      );
      response = await ctx.api("GET", `/api/skills?enabled=false&agentId=${owner}`);
      expectStatus(response, [200], "list disabled skills");
      expect(
        !asRecords(response.json, "skills").some((row) => row.id === httpId),
        "enabled=false must exclude an enabled skill",
      );

      // ── Update ──────────────────────────────────────────────────────────────────────────────
      response = await ctx.api("PUT", `/api/skills/${httpId}`, {
        body: { content: skillMarkdown(httpName, "Rewritten description", "Rewritten body.") },
      });
      expectStatus(response, [200], "update skill content");
      skill = asRecord(asRecord(response.json).skill);
      expect(skill.description === "Rewritten description", "frontmatter is re-parsed on update");
      expect(
        typeof skill.version === "number" && skill.version > 1,
        "a content update must bump the version",
      );
      response = await ctx.api("PUT", `/api/skills/${httpId}`, { body: { isEnabled: false } });
      expectStatus(response, [200], "disable skill");
      expect(asRecord(asRecord(response.json).skill).isEnabled === false, "skill not disabled");
      response = await ctx.api("PUT", `/api/skills/${crypto.randomUUID()}`, {
        body: { isEnabled: true },
      });
      expectStatus(response, [404], "update unknown skill");
      response = await ctx.api("PUT", `/api/skills/${systemId}`, {
        body: { content: skillMarkdown("hijack", "hijack", "hijack") },
      });
      expectStatus(response, [403], "update a system-managed skill");
      response = await ctx.api("DELETE", `/api/skills/${systemId}`);
      expectStatus(response, [403], "delete a system-managed skill");

      // ── Install / uninstall over HTTP (a disabled skill first re-enabled) ───────────────────
      response = await ctx.api("PUT", `/api/skills/${httpId}`, { body: { isEnabled: true } });
      expectStatus(response, [200], "re-enable skill");
      response = await ctx.api("POST", `/api/skills/${httpId}/install`, {
        body: { agentId: other },
      });
      expectStatus(response, [200], "install skill for an agent");
      const agentSkill = asRecord(asRecord(response.json).agentSkill);
      expect(
        agentSkill.agentId === other &&
          agentSkill.skillId === httpId &&
          agentSkill.isActive === true,
        "agentSkill fields",
      );
      expect(
        dbCount(ctx, "SELECT count(*) AS n FROM agent_skills WHERE agentId = ? AND skillId = ?", [
          other,
          httpId,
        ]) === 1,
        "agent_skills row was not persisted",
      );
      response = await ctx.api("GET", `/api/agents/${other}/skills`);
      expectStatus(response, [200], "agent skills after install");
      expect(
        asRecords(response.json, "skills").some((row) => row.id === httpId),
        "the installed skill is missing from the agent's skills",
      );
      response = await ctx.api("POST", `/api/skills/${crypto.randomUUID()}/install`, {
        body: { agentId: other },
      });
      expectStatus(response, [404], "install an unknown skill");
      response = await ctx.api("POST", `/api/skills/${httpId}/install`, { body: {} });
      expectStatus(response, [400], "install without agentId");
      response = await ctx.api("DELETE", `/api/skills/${httpId}/install/${other}`);
      expectStatus(response, [200], "uninstall skill");
      expect(asRecord(response.json).success === true, "uninstall success");
      response = await ctx.api("DELETE", `/api/skills/${httpId}/install/${other}`);
      expectStatus(response, [200], "uninstall skill twice");
      expect(asRecord(response.json).success === false, "second uninstall reports success false");

      // ── Bundled files ───────────────────────────────────────────────────────────────────────
      response = await ctx.api("POST", `/api/skills/${httpId}/files`, {
        body: {
          files: [
            { path: "guide.md", content: "# Guide\nRead me.", mimeType: "text/markdown" },
            { path: "references/deep.md", content: "# Deep\nNested file." },
            { path: "run.sh", content: "#!/bin/sh\necho hi\n" },
          ],
        },
      });
      expectStatus(response, [200], "bulk upsert skill files");
      let fileDoc = asRecord(response.json);
      expect(fileDoc.total === 3 && asRecords(fileDoc, "files").length === 3, "bulk files total");
      expect(asRecord(fileDoc.skill).id === httpId, "bulk upsert returns the skill");
      response = await ctx.api("GET", `/api/skills/${httpId}/files`);
      expectStatus(response, [200], "list skill files");
      fileDoc = asRecord(response.json);
      const manifest = asRecords(fileDoc, "files");
      expect(
        fileDoc.total === 3 && manifest.every((file) => file.content === undefined),
        "the file manifest lists files without content",
      );
      expect(
        manifest
          .map((file) => file.path)
          .sort()
          .join(",") === "guide.md,references/deep.md,run.sh",
        "manifest paths",
      );
      response = await ctx.api("GET", `/api/skills/${httpId}/files/guide.md`);
      expectStatus(response, [200], "get a skill file");
      let file = asRecord(asRecord(response.json).file);
      expect(
        file.content === "# Guide\nRead me." &&
          file.mimeType === "text/markdown" &&
          file.isBinary === false,
        `skill file fields: ${JSON.stringify(file)}`,
      );
      response = await ctx.api("PUT", `/api/skills/${httpId}/files/extra.txt`, {
        body: { content: "extra notes", mimeType: "text/plain" },
      });
      expectStatus(response, [200], "upsert one skill file");
      file = asRecord(asRecord(response.json).file);
      expect(file.path === "extra.txt" && file.size === 11, "single upsert file fields");
      response = await ctx.api("PUT", `/api/skills/${httpId}/files/extra.txt`, {
        body: { content: "extra notes, revised" },
      });
      expectStatus(response, [200], "upsert the same file again");
      response = await ctx.api("GET", `/api/skills/${httpId}/files/extra.txt`);
      expect(
        asRecord(asRecord(response.json).file).content === "extra notes, revised",
        "a repeated upsert must replace the content",
      );
      expect(
        dbCount(ctx, "SELECT count(*) AS n FROM skill_files WHERE skillId = ?", [httpId]) === 4,
        "skill_files rows",
      );
      response = await ctx.api("DELETE", `/api/skills/${httpId}/files/extra.txt`);
      expectStatus(response, [200], "delete a skill file");
      expect(asRecord(response.json).success === true, "delete file success");
      response = await ctx.api("DELETE", `/api/skills/${httpId}/files/extra.txt`);
      expectStatus(response, [404], "delete a missing skill file");
      response = await ctx.api("GET", `/api/skills/${httpId}/files/extra.txt`);
      expectStatus(response, [404], "get a deleted skill file");
      response = await ctx.api("PUT", `/api/skills/${httpId}/files/SKILL.md`, {
        body: { content: "x" },
      });
      expectStatus(response, [400], "SKILL.md cannot be a bundled file");
      response = await ctx.api("POST", `/api/skills/${httpId}/files`, {
        body: { files: [{ path: "../escape.txt", content: "x" }] },
      });
      expectStatus(response, [400], "traversal path in bulk upsert");
      response = await ctx.api("POST", `/api/skills/${httpId}/files`, {
        body: {
          files: Array.from({ length: 101 }, (_, index) => ({
            path: `f${index}.txt`,
            content: "x",
          })),
        },
      });
      expectStatus(response, [400], "bulk upsert above 100 files");
      const missingSkill = crypto.randomUUID();
      for (const [method, path, body] of [
        ["GET", `/api/skills/${missingSkill}/files`, undefined],
        ["GET", `/api/skills/${missingSkill}/files/a.txt`, undefined],
        ["POST", `/api/skills/${missingSkill}/files`, { files: [] }],
        ["PUT", `/api/skills/${missingSkill}/files/a.txt`, { content: "x" }],
        ["DELETE", `/api/skills/${missingSkill}/files/a.txt`, undefined],
      ] as const) {
        response = await ctx.api(method, path, body === undefined ? {} : { body });
        expectStatus(response, [404], `${method} ${path} for an unknown skill`);
      }
      for (const [method, path, body] of [
        ["POST", `/api/skills/${systemId}/files`, { files: [{ path: "a.txt", content: "x" }] }],
        ["PUT", `/api/skills/${systemId}/files/a.txt`, { content: "x" }],
        ["DELETE", `/api/skills/${systemId}/files/a.txt`, undefined],
      ] as const) {
        response = await ctx.api(method, path, body === undefined ? {} : { body });
        expectStatus(response, [403], `${method} ${path} on a system-managed skill`);
      }

      // MCP skill-get-file reads the same bundle.
      let outcome = expectToolOk(
        await callTool(sessionOwner, "skill-get-file", {
          skillId: httpId,
          path: "references/deep.md",
        }),
        "skill-get-file",
      );
      expect(
        asRecord(outcome.data.file).content === "# Deep\nNested file.",
        "skill-get-file content",
      );
      expect(outcome.text.includes("Nested file."), "skill-get-file text lacks the content");
      expectToolError(
        await callTool(sessionOwner, "skill-get-file", { skillId: httpId, path: "nope.md" }),
        "skill-get-file missing file",
        /not found/i,
      );
      expectToolError(
        await callTool(sessionOwner, "skill-get-file", { skillId: missingSkill, path: "a.md" }),
        "skill-get-file unknown skill",
        /not found/i,
      );
      expectToolError(
        await callTool(sessionOwner, "skill-get-file", { skillId: httpId, path: "SKILL.md" }),
        "skill-get-file rejects SKILL.md",
        /SKILL\.md/,
      );

      // ── Tools: create, list, search, get ────────────────────────────────────────────────────
      const toolName = `e2e-skill-tool-${ctx.nonce}`;
      outcome = expectToolOk(
        await callTool(sessionOwner, "skill-create", {
          content: skillMarkdown(toolName, "Tool-made skill", "Tool body."),
        }),
        "skill-create",
      );
      const toolSkill = asRecord(outcome.data.skill);
      const toolId = asString(toolSkill.id, "tool skill id");
      cleanupSkills.push(toolId);
      expect(
        toolSkill.ownerAgentId === owner &&
          toolSkill.scope === "agent" &&
          toolSkill.type === "personal",
        "skill-create owner/scope/type",
      );
      expect(
        dbCount(ctx, "SELECT count(*) AS n FROM agent_skills WHERE agentId = ? AND skillId = ?", [
          owner,
          toolId,
        ]) === 1,
        "skill-create must auto-install for the creator",
      );
      expectToolError(
        await callTool(sessionOwner, "skill-create", {
          content: skillMarkdown(toolName, "dup", "dup"),
        }),
        "skill-create duplicate name",
        /Failed to create skill/i,
      );
      expectToolError(
        await callTool(sessionOwner, "skill-create", { content: "no frontmatter at all" }),
        "skill-create invalid content",
        /frontmatter/i,
      );
      expectToolError(
        await callTool(sessionOwner, "skill-create", {
          content: skillMarkdown(`e2e-skill-swarm-w-${ctx.nonce}`, "x", "x"),
          scope: "swarm",
        }),
        "skill-create swarm scope as worker",
        /lead/i,
      );
      const swarmName = `e2e-skill-swarm-${ctx.nonce}`;
      outcome = expectToolOk(
        await callTool(sessionLead, "skill-create", {
          content: skillMarkdown(swarmName, "Swarm-wide skill", "Shared body."),
          scope: "swarm",
        }),
        "skill-create swarm scope as lead",
      );
      const swarmSkillId = asString(asRecord(outcome.data.skill).id, "swarm skill id");
      cleanupSkills.push(swarmSkillId);
      response = await ctx.api("GET", `/api/agents/${other}/skills`);
      expect(
        asRecords(response.json, "skills").some((row) => row.id === swarmSkillId),
        "a swarm-scope skill must reach every agent without an install",
      );
      response = await ctx.api("GET", `/api/agents/${other}/skills/signature`);
      expectStatus(response, [200], "agent skills signature");
      expect(typeof asRecord(response.json).hash === "string", "signature hash");

      outcome = expectToolOk(
        await callTool(sessionOwner, "skill-list", { scope: "agent", agentId: owner }),
        "skill-list",
      );
      const listed = outcome.data.skills as Record<string, unknown>[];
      expect(
        listed.some((row) => row.id === toolId) &&
          listed.some((row) => row.id === httpId) &&
          listed.every((row) => row.content === undefined) &&
          outcome.data.total === listed.length,
        "skill-list filters and strips content",
      );
      // includeContent is only safe on a narrow filter: the seeded catalog is large enough
      // for the registrar to spill it to KV.
      outcome = expectToolOk(
        await callTool(sessionOwner, "skill-list", { installedOnly: true }),
        "skill-list installedOnly",
      );
      // The installed set includes every system default, so the registrar truncates the
      // structured list: assert the shape here and the membership over HTTP.
      expect(
        Array.isArray(outcome.data.skills) && (outcome.data.skills as unknown[]).length > 0,
        "installedOnly lists the installed skills",
      );
      response = await ctx.api("GET", `/api/agents/${owner}/skills`);
      expectStatus(response, [200], "owner skills");
      const ownerSkills = asRecords(response.json, "skills").map((row) => row.id);
      expect(
        ownerSkills.includes(toolId) && ownerSkills.includes(swarmSkillId),
        "the creator's skill and swarm-scope skills are installed for the owner",
      );
      outcome = expectToolOk(
        await callTool(sessionOwner, "skill-list", {
          scope: "agent",
          agentId: owner,
          includeContent: true,
        }),
        "skill-list includeContent",
      );
      expect(
        (outcome.data.skills as Record<string, unknown>[]).some(
          (row) => row.id === toolId && typeof row.content === "string" && row.content.length > 0,
        ),
        "includeContent returns the SKILL.md body",
      );
      outcome = expectToolOk(
        await callTool(sessionOwner, "skill-search", { query: toolName, limit: 5 }),
        "skill-search",
      );
      const found = outcome.data.skills as Record<string, unknown>[];
      expect(
        found.some((row) => row.id === toolId) && found.every((row) => row.content === undefined),
        "skill-search finds the skill without content",
      );
      outcome = expectToolOk(
        await callTool(sessionOwner, "skill-search", { query: `nothing-matches-${ctx.nonce}-zz` }),
        "skill-search without a match",
      );
      expect(outcome.data.total === 0, "skill-search total for no match");
      outcome = expectToolOk(
        await callTool(sessionOwner, "skill-get", { skillId: toolId }),
        "skill-get by id",
      );
      expect(asRecord(outcome.data.skill).name === toolName, "skill-get by id");
      expect(outcome.text.includes("Tool body."), "skill-get text lacks the content");
      outcome = expectToolOk(
        await callTool(sessionOwner, "skill-get", { name: toolName }),
        "skill-get by name (agent scope first)",
      );
      expect(asRecord(outcome.data.skill).id === toolId, "skill-get by name");
      outcome = expectToolOk(
        await callTool(sessionOther, "skill-get", { name: swarmName }),
        "skill-get by name resolves swarm scope",
      );
      expect(asRecord(outcome.data.skill).id === swarmSkillId, "skill-get swarm name");
      expectToolError(
        await callTool(sessionOwner, "skill-get", {}),
        "skill-get without arguments",
        /skillId or name/i,
      );
      expectToolError(
        await callTool(sessionOwner, "skill-get", { name: `missing-${ctx.nonce}` }),
        "skill-get unknown name",
        /not found/i,
      );

      // ── Tools: install, uninstall ───────────────────────────────────────────────────────────
      expectToolOk(
        await callTool(sessionOther, "skill-install", { skillId: toolId }),
        "skill-install for self",
      );
      expectToolError(
        await callTool(sessionOther, "skill-install", { skillId: toolId, agentId: owner }),
        "skill-install for another agent as worker",
        /lead/i,
      );
      expectToolError(
        await callTool(sessionOther, "skill-install", { skillId: missingSkill }),
        "skill-install unknown skill",
        /not found/i,
      );
      outcome = expectToolOk(
        await callTool(sessionLead, "skill-install", { skillId: httpId, agentId: other }),
        "skill-install for another agent as lead",
      );
      expect(asRecord(outcome.data.agentSkill).agentId === other, "lead install target");
      response = await ctx.api("PUT", `/api/skills/${httpId}`, { body: { isEnabled: false } });
      expectStatus(response, [200], "disable skill for the install guard");
      expectToolError(
        await callTool(sessionOwner, "skill-install", { skillId: httpId }),
        "skill-install of a disabled skill",
        /disabled/i,
      );
      response = await ctx.api("PUT", `/api/skills/${httpId}`, { body: { isEnabled: true } });
      expectStatus(response, [200], "re-enable skill");
      expectToolOk(
        await callTool(sessionOther, "skill-uninstall", { skillId: toolId }),
        "skill-uninstall for self",
      );
      expectToolError(
        await callTool(sessionOther, "skill-uninstall", { skillId: toolId }),
        "skill-uninstall twice",
        /not installed/i,
      );
      expectToolError(
        await callTool(sessionOther, "skill-uninstall", { skillId: httpId, agentId: owner }),
        "skill-uninstall for another agent as worker",
        /lead/i,
      );
      expectToolOk(
        await callTool(sessionLead, "skill-uninstall", { skillId: httpId, agentId: other }),
        "skill-uninstall for another agent as lead",
      );

      // ── Tools: update ───────────────────────────────────────────────────────────────────────
      outcome = expectToolOk(
        await callTool(sessionOwner, "skill-update", {
          skillId: toolId,
          content: skillMarkdown(toolName, "Updated by the owner", "Updated body."),
        }),
        "skill-update content",
      );
      expect(
        asRecord(outcome.data.skill).description === "Updated by the owner" &&
          (asRecord(outcome.data.skill).version as number) > 1,
        "skill-update re-parses and bumps the version",
      );
      outcome = expectToolOk(
        await callTool(sessionOwner, "skill-update", { skillId: toolId, isEnabled: false }),
        "skill-update disable",
      );
      expect(asRecord(outcome.data.skill).isEnabled === false, "skill-update isEnabled");
      expectToolOk(
        await callTool(sessionOwner, "skill-update", { skillId: toolId, isEnabled: true }),
        "skill-update re-enable",
      );
      expectToolError(
        await callTool(sessionOther, "skill-update", { skillId: toolId, isEnabled: false }),
        "skill-update by a non-owner",
        /owning agent or lead/i,
      );
      expectToolError(
        await callTool(sessionOwner, "skill-update", { skillId: missingSkill, isEnabled: false }),
        "skill-update unknown skill",
        /not found/i,
      );
      expectToolError(
        await callTool(sessionOwner, "skill-update", { isEnabled: false }),
        "skill-update without skillId",
        /skillId is required/i,
      );
      expectToolError(
        await callTool(sessionOwner, "skill-update", { skillId: toolId, scope: "swarm" }),
        "skill-update promotes to swarm as worker",
        /lead/i,
      );
      expectToolError(
        await callTool(sessionLead, "skill-update", {
          skillId: systemId,
          content: skillMarkdown("x", "x", "x"),
        }),
        "skill-update of a system-managed skill",
        /system-managed/i,
      );
      outcome = expectToolOk(
        await callTool(sessionLead, "skill-update", { skillId: toolId, scope: "swarm" }),
        "skill-update promotes to swarm as lead",
      );
      expect(asRecord(outcome.data.skill).scope === "swarm", "promoted skill scope");

      // ── Tools: publish ──────────────────────────────────────────────────────────────────────
      const publishName = `e2e-skill-publish-${ctx.nonce}`;
      outcome = expectToolOk(
        await callTool(sessionOwner, "skill-create", {
          content: skillMarkdown(publishName, "Publish candidate", "Publish me."),
        }),
        "skill-create for publish",
      );
      const publishId = asString(asRecord(outcome.data.skill).id, "publish skill id");
      cleanupSkills.push(publishId);
      outcome = expectToolOk(
        await callTool(sessionOwner, "skill-publish", { skillId: publishId }),
        "skill-publish",
      );
      const approvalTaskId = asString(outcome.data.taskId, "approval task id");
      cleanupTasks.push(approvalTaskId);
      response = await ctx.api("GET", `/api/tasks/${approvalTaskId}`);
      expectStatus(response, [200], "read the approval task");
      const approval = asRecord(response.json);
      expect(
        approval.taskType === "skill-approval" &&
          String(approval.task).includes(publishName) &&
          approval.creatorAgentId === owner,
        `publish must create a skill-approval task: ${JSON.stringify(approval).slice(0, 300)}`,
      );
      expectToolError(
        await callTool(sessionOther, "skill-publish", { skillId: publishId }),
        "skill-publish by a non-owner",
        /your own skills/i,
      );
      expectToolError(
        await callTool(sessionOwner, "skill-publish", { skillId: missingSkill }),
        "skill-publish unknown skill",
        /not found/i,
      );

      // ── Remote skills (no network: complex skills carry metadata only) ──────────────────────
      expectToolError(
        await callTool(sessionOwner, "skill-install-remote", {
          sourceRepo: "e2e-org/e2e-skills",
          isComplex: true,
        }),
        "skill-install-remote as worker",
        /lead/i,
      );
      outcome = expectToolOk(
        await callTool(sessionLead, "skill-install-remote", {
          sourceRepo: `e2e-org-${ctx.nonce}/e2e-skills`,
          sourcePath: "skills/complex",
          isComplex: true,
          scope: "global",
        }),
        "skill-install-remote complex as lead",
      );
      const toolRemote = asRecord(outcome.data.skill);
      cleanupSkills.push(asString(toolRemote.id, "remote skill id"));
      expect(
        toolRemote.type === "remote" &&
          toolRemote.isComplex === true &&
          toolRemote.name === "complex" &&
          toolRemote.scope === "global",
        `remote skill fields: ${JSON.stringify(toolRemote)}`,
      );
      response = await ctx.api("POST", "/api/skills/install-remote", {
        body: {
          sourceRepo: `e2e-org-${ctx.nonce}/http-skills`,
          sourcePath: "skills/http-complex",
          isComplex: true,
          scope: "swarm",
        },
      });
      expectStatus(response, [201], "install a complex remote skill over HTTP");
      const httpRemote = asRecord(asRecord(response.json).skill);
      cleanupSkills.push(asString(httpRemote.id, "http remote skill id"));
      expect(
        httpRemote.type === "remote" &&
          httpRemote.name === "http-complex" &&
          httpRemote.scope === "swarm" &&
          String(httpRemote.sourceUrl).endsWith("/skills/http-complex/SKILL.md"),
        `http remote skill fields: ${JSON.stringify(httpRemote)}`,
      );
      response = await ctx.api("POST", "/api/skills/install-remote", { body: { isComplex: true } });
      expectStatus(response, [400], "install-remote without sourceRepo");
      expectToolError(
        await callTool(sessionOwner, "skill-publish", { skillId: asString(httpRemote.id, "id") }),
        "skill-publish of a remote skill",
        /personal/i,
      );

      response = await ctx.api("POST", "/api/skills/sync-remote", {
        body: { skillId: httpRemote.id, force: true },
      });
      expectStatus(response, [200], "sync-remote of a complex skill");
      const sync = asRecord(response.json);
      expect(
        sync.checked === 1 && sync.updated === 0 && asRecords(sync, "errors").length === 0,
        `complex remote skills are skipped by sync: ${JSON.stringify(sync)}`,
      );
      response = await ctx.api("POST", "/api/skills/sync-remote", {
        body: { skillId: crypto.randomUUID() },
      });
      expectStatus(response, [200], "sync-remote of an unknown skill");
      expect(asRecord(response.json).checked === 0, "sync-remote unknown skill checks nothing");
      response = await ctx.api("POST", "/api/skills/sync-remote", { body: { skillId: 7 } });
      expectStatus(response, [400], "sync-remote with an invalid skillId");
      outcome = expectToolOk(
        await callTool(sessionOwner, "skill-sync-remote", { skillId: toolRemote.id }),
        "skill-sync-remote complex",
      );
      expect(outcome.data.checked === 1 && outcome.data.updated === 0, "skill-sync-remote counts");
      outcome = expectToolOk(
        await callTool(sessionOwner, "skill-sync-remote", { skillId: toolId }),
        "skill-sync-remote of a personal skill",
      );
      expect(outcome.data.checked === 0, "skill-sync-remote ignores non-remote skills");

      // ── Usage ───────────────────────────────────────────────────────────────────────────────
      response = await ctx.api("GET", "/api/skills/usage");
      expectStatus(response, [200], "swarm skill usage");
      let usage = asRecord(response.json);
      expect(usage.window === "30d", "usage defaults to a 30 day window");
      for (const field of ["totals", "taskAdoption"]) asRecord(usage[field]);
      for (const field of ["daily", "byHarness", "bySkill", "agents", "unused"]) {
        expect(Array.isArray(usage[field]), `usage.${field} is an array`);
      }
      response = await ctx.api("GET", "/api/skills/usage?window=7d&tzOffset=120");
      expectStatus(response, [200], "usage with window and tzOffset");
      expect(asRecord(response.json).window === "7d", "usage window");
      response = await ctx.api("GET", "/api/skills/usage?window=forever");
      expectStatus(response, [400], "usage with an invalid window");
      response = await ctx.api("GET", "/api/skills/usage?tzOffset=9999");
      expectStatus(response, [400], "usage with an invalid tzOffset");
      response = await ctx.api("GET", `/api/skills/${httpId}/usage?window=all`);
      expectStatus(response, [200], "single skill usage");
      usage = asRecord(response.json);
      expect(
        usage.skillId === httpId &&
          usage.window === "all" &&
          asRecord(usage.totals).invocations === 0 &&
          Array.isArray(usage.recent),
        `single skill usage: ${JSON.stringify(usage).slice(0, 300)}`,
      );
      response = await ctx.api("GET", `/api/skills/${missingSkill}/usage`);
      expectStatus(response, [404], "usage of an unknown skill");

      // ── Filesystem sync ───────────────────────────────────────────────────────────────────
      // The SUT runs with a per-run HOME (scripts/e2e/sut.ts), so the write path is safe to
      // exercise: it lands under /tmp/e2e-home-*, never in the developer's home.
      response = await ctx.api("POST", "/api/skills/sync-filesystem", { body: {} });
      expectStatus(response, [400], "sync-filesystem without X-Agent-ID");
      response = await ctx.api("POST", "/api/skills/sync-filesystem", {
        agentId: owner,
        body: {},
      });
      expectStatus(response, [200], "sync-filesystem as the owner agent");
      const synced = asRecord(response.json);
      expect(
        typeof synced.synced === "number" && synced.synced >= 1,
        `sync-filesystem synced ${String(synced.synced)} skills; expected at least one`,
      );
      expect(
        Array.isArray(synced.errors) && synced.errors.length === 0,
        `sync-filesystem reported errors: ${JSON.stringify(synced.errors)}`,
      );

      // ── Delete ──────────────────────────────────────────────────────────────────────────────
      expectToolError(
        await callTool(sessionOther, "skill-delete", { skillId: toolId }),
        "skill-delete by a non-owner",
        /owning agent or lead/i,
      );
      expectToolError(
        await callTool(sessionLead, "skill-delete", { skillId: systemId }),
        "skill-delete of a system-managed skill",
        /system-managed/i,
      );
      expectToolError(
        await callTool(sessionOwner, "skill-delete", { skillId: missingSkill }),
        "skill-delete unknown skill",
        /not found/i,
      );
      expectToolOk(
        await callTool(sessionOwner, "skill-delete", { skillId: publishId }),
        "skill-delete by the owner",
      );
      expect(
        dbCount(ctx, "SELECT count(*) AS n FROM skills WHERE id = ?", [publishId]) === 0,
        "skill-delete left the row behind",
      );
      response = await ctx.api("DELETE", `/api/skills/${httpId}`);
      expectStatus(response, [200], "delete skill over HTTP");
      expect(asRecord(response.json).success === true, "delete skill success");
      expect(
        dbCount(ctx, "SELECT count(*) AS n FROM skill_files WHERE skillId = ?", [httpId]) === 0,
        "deleting a skill must delete its bundled files",
      );
      response = await ctx.api("GET", `/api/skills/${httpId}`);
      expectStatus(response, [404], "get a deleted skill");
      response = await ctx.api("DELETE", `/api/skills/${httpId}`);
      expectStatus(response, [404], "delete a skill twice");
    } finally {
      for (const id of cleanupSkills) await ctx.api("DELETE", `/api/skills/${id}`);
      for (const id of cleanupTasks) await cancelTask(ctx, id).catch(() => {});
      await sessionLead.close();
      await sessionOther.close();
      await sessionOwner.close();
    }
  },
};
