import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  createSkill,
  deleteSkill,
  getAgentSkills,
  getSkillById,
  installSkill,
  listSkills,
  searchSkills,
  uninstallSkill,
  updateSkill,
} from "../be/db";
import { parseSkillContent } from "../be/skill-parser";
import { syncSkillsToFilesystem } from "../be/skill-sync";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const listSkillsRoute = route({
  method: "get",
  path: "/api/skills",
  pattern: ["api", "skills"],
  summary: "List skills with optional filters",
  tags: ["Skills"],
  auth: { apiKey: true },
  query: z.object({
    type: z.string().optional(),
    scope: z.string().optional(),
    agentId: z.string().optional(),
    enabled: z.string().optional(),
    search: z.string().optional(),
  }),
  responses: {
    200: { description: "Skill list" },
  },
});

const getSkillRoute = route({
  method: "get",
  path: "/api/skills/{id}",
  pattern: ["api", "skills", null],
  summary: "Get skill by ID",
  tags: ["Skills"],
  auth: { apiKey: true },
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Skill details" },
    404: { description: "Skill not found" },
  },
});

const createSkillRoute = route({
  method: "post",
  path: "/api/skills",
  pattern: ["api", "skills"],
  summary: "Create a new skill",
  tags: ["Skills"],
  auth: { apiKey: true },
  body: z.object({
    content: z.string().min(1),
    type: z.string().optional(),
    scope: z.string().optional(),
    ownerAgentId: z.string().optional(),
  }),
  responses: {
    201: { description: "Skill created" },
    400: { description: "Validation error" },
  },
});

const updateSkillRoute = route({
  method: "put",
  path: "/api/skills/{id}",
  pattern: ["api", "skills", null],
  summary: "Update a skill",
  tags: ["Skills"],
  auth: { apiKey: true },
  params: z.object({ id: z.string() }),
  body: z.record(z.string(), z.unknown()),
  responses: {
    200: { description: "Skill updated" },
    404: { description: "Skill not found" },
  },
});

const deleteSkillRoute = route({
  method: "delete",
  path: "/api/skills/{id}",
  pattern: ["api", "skills", null],
  summary: "Delete a skill",
  tags: ["Skills"],
  auth: { apiKey: true },
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Skill deleted" },
    404: { description: "Skill not found" },
  },
});

const installSkillRoute = route({
  method: "post",
  path: "/api/skills/{id}/install",
  pattern: ["api", "skills", null, "install"],
  summary: "Install skill for an agent",
  tags: ["Skills"],
  auth: { apiKey: true },
  params: z.object({ id: z.string() }),
  body: z.object({
    agentId: z.string(),
  }),
  responses: {
    200: { description: "Skill installed" },
    404: { description: "Skill not found" },
  },
});

const uninstallSkillRoute = route({
  method: "delete",
  path: "/api/skills/{id}/install/{agentId}",
  pattern: ["api", "skills", null, "install", null],
  summary: "Uninstall skill for an agent",
  tags: ["Skills"],
  auth: { apiKey: true },
  params: z.object({ id: z.string(), agentId: z.string() }),
  responses: {
    200: { description: "Skill uninstalled" },
  },
});

const installRemoteRoute = route({
  method: "post",
  path: "/api/skills/install-remote",
  pattern: ["api", "skills", "install-remote"],
  summary: "Install a remote skill from GitHub",
  tags: ["Skills"],
  auth: { apiKey: true },
  body: z.object({
    sourceRepo: z.string(),
    sourcePath: z.string().optional(),
    scope: z.string().optional(),
    isComplex: z.boolean().optional(),
  }),
  responses: {
    201: { description: "Remote skill installed" },
    400: { description: "Fetch failed" },
  },
});

const syncRemoteRoute = route({
  method: "post",
  path: "/api/skills/sync-remote",
  pattern: ["api", "skills", "sync-remote"],
  summary: "Trigger remote skill sync",
  tags: ["Skills"],
  auth: { apiKey: true },
  body: z.object({
    skillId: z.string().optional(),
    force: z.boolean().optional(),
  }),
  responses: {
    200: { description: "Sync results" },
  },
});

const syncFilesystemRoute = route({
  method: "post",
  path: "/api/skills/sync-filesystem",
  pattern: ["api", "skills", "sync-filesystem"],
  summary: "Sync installed skills to agent filesystem",
  tags: ["Skills"],
  auth: { apiKey: true, agentId: true },
  responses: {
    200: { description: "Filesystem sync results" },
  },
});

const getAgentSkillsRoute = route({
  method: "get",
  path: "/api/agents/{id}/skills",
  pattern: ["api", "agents", null, "skills"],
  summary: "Get all skills installed for an agent",
  tags: ["Skills"],
  auth: { apiKey: true },
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Agent skills list" },
  },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleSkills(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  // GET /api/agents/:id/skills (must be before /api/skills routes)
  if (getAgentSkillsRoute.match(req.method, pathSegments)) {
    const parsed = await getAgentSkillsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const skills = getAgentSkills(parsed.params.id);
    json(res, { skills, total: skills.length });
    return true;
  }

  // POST /api/skills/install-remote (must be before /api/skills/:id)
  if (installRemoteRoute.match(req.method, pathSegments)) {
    const parsed = await installRemoteRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    try {
      const branch = "main";
      const filePath = parsed.body.sourcePath ? `${parsed.body.sourcePath}/SKILL.md` : "SKILL.md";
      const rawUrl = `https://raw.githubusercontent.com/${parsed.body.sourceRepo}/${branch}/${filePath}`;

      let content = "";
      if (!parsed.body.isComplex) {
        const response = await fetch(rawUrl);
        if (!response.ok) {
          jsonError(res, `Failed to fetch SKILL.md: HTTP ${response.status}`, 400);
          return true;
        }
        content = await response.text();
      }

      let name: string;
      let description: string;
      if (content) {
        const pm = parseSkillContent(content);
        name = pm.name;
        description = pm.description;
      } else {
        name = parsed.body.sourcePath?.split("/").pop() || parsed.body.sourceRepo;
        description = `Complex skill from ${parsed.body.sourceRepo}`;
      }

      const skill = createSkill({
        name,
        description,
        content,
        type: "remote",
        scope: (parsed.body.scope as "global" | "swarm") ?? "global",
        sourceUrl: rawUrl,
        sourceRepo: parsed.body.sourceRepo,
        sourcePath: parsed.body.sourcePath,
        sourceBranch: branch,
        isComplex: parsed.body.isComplex ?? false,
      });

      json(res, { skill }, 201);
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Unknown error", 400);
    }
    return true;
  }

  // POST /api/skills/sync-remote
  if (syncRemoteRoute.match(req.method, pathSegments)) {
    const parsed = await syncRemoteRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const remoteSkills = parsed.body.skillId
      ? (() => {
          const s = getSkillById(parsed.body.skillId!);
          return s && s.type === "remote" ? [s] : [];
        })()
      : listSkills({ type: "remote" });

    let updated = 0;
    const errors: string[] = [];

    for (const skill of remoteSkills) {
      if (skill.isComplex || !skill.sourceRepo) continue;
      try {
        const fp = skill.sourcePath ? `${skill.sourcePath}/SKILL.md` : "SKILL.md";
        const url = `https://raw.githubusercontent.com/${skill.sourceRepo}/${skill.sourceBranch}/${fp}`;
        const resp = await fetch(url);
        if (!resp.ok) {
          errors.push(`${skill.name}: HTTP ${resp.status}`);
          continue;
        }
        const newContent = await resp.text();
        const newHash = new Bun.CryptoHasher("sha256").update(newContent).digest("hex");
        const now = new Date().toISOString();

        if (parsed.body.force || newHash !== skill.sourceHash) {
          const pm = parseSkillContent(newContent);
          updateSkill(skill.id, {
            content: newContent,
            name: pm.name,
            description: pm.description,
            allowedTools: pm.allowedTools,
            model: pm.model,
            effort: pm.effort,
            context: pm.context,
            agent: pm.agent,
            disableModelInvocation: pm.disableModelInvocation,
            userInvocable: pm.userInvocable,
            sourceHash: newHash,
            lastFetchedAt: now,
          });
          updated++;
        } else {
          // Content unchanged — still update lastFetchedAt
          updateSkill(skill.id, { lastFetchedAt: now });
        }
      } catch (err) {
        errors.push(`${skill.name}: ${err instanceof Error ? err.message : "Unknown"}`);
      }
    }

    json(res, { updated, checked: remoteSkills.length, errors });
    return true;
  }

  // POST /api/skills/sync-filesystem
  if (syncFilesystemRoute.match(req.method, pathSegments)) {
    // This endpoint is called by the runner to sync skills to the filesystem
    const agentId = myAgentId;
    if (!agentId) {
      jsonError(res, "X-Agent-ID required", 400);
      return true;
    }

    const result = syncSkillsToFilesystem(agentId);
    json(res, {
      synced: result.synced,
      removed: result.removed,
      errors: result.errors,
      message: `Synced ${result.synced} skills, removed ${result.removed} stale entries`,
    });
    return true;
  }

  // POST /api/skills/:id/install
  if (installSkillRoute.match(req.method, pathSegments)) {
    const parsed = await installSkillRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const skill = getSkillById(parsed.params.id);
    if (!skill) {
      jsonError(res, "Skill not found", 404);
      return true;
    }

    try {
      const agentSkill = installSkill(parsed.body.agentId, parsed.params.id);
      json(res, { agentSkill });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Install failed", 400);
    }
    return true;
  }

  // DELETE /api/skills/:id/install/:agentId
  if (uninstallSkillRoute.match(req.method, pathSegments)) {
    const parsed = await uninstallSkillRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const removed = uninstallSkill(parsed.params.agentId, parsed.params.id);
    json(res, { success: removed });
    return true;
  }

  // GET /api/skills
  if (listSkillsRoute.match(req.method, pathSegments)) {
    const parsed = await listSkillsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const skills = parsed.query.search
      ? searchSkills(parsed.query.search)
      : listSkills({
          type: parsed.query.type as "remote" | "personal" | undefined,
          scope: parsed.query.scope as "global" | "swarm" | "agent" | undefined,
          ownerAgentId: parsed.query.agentId,
          isEnabled:
            parsed.query.enabled !== undefined ? parsed.query.enabled === "true" : undefined,
        });

    json(res, { skills, total: skills.length });
    return true;
  }

  // GET /api/skills/:id
  if (getSkillRoute.match(req.method, pathSegments)) {
    const parsed = await getSkillRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const skill = getSkillById(parsed.params.id);
    if (!skill) {
      jsonError(res, "Skill not found", 404);
      return true;
    }
    json(res, skill);
    return true;
  }

  // POST /api/skills
  if (createSkillRoute.match(req.method, pathSegments)) {
    const parsed = await createSkillRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    try {
      const pm = parseSkillContent(parsed.body.content);
      const skill = createSkill({
        name: pm.name,
        description: pm.description,
        content: parsed.body.content,
        type: (parsed.body.type as "remote" | "personal") ?? "personal",
        scope: (parsed.body.scope as "global" | "swarm" | "agent") ?? "agent",
        ownerAgentId: parsed.body.ownerAgentId,
        allowedTools: pm.allowedTools,
        model: pm.model,
        effort: pm.effort,
        context: pm.context,
        agent: pm.agent,
        disableModelInvocation: pm.disableModelInvocation,
        userInvocable: pm.userInvocable,
      });
      json(res, { skill }, 201);
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Create failed", 400);
    }
    return true;
  }

  // PUT /api/skills/:id
  if (updateSkillRoute.match(req.method, pathSegments)) {
    const parsed = await updateSkillRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const updates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed.body)) {
      updates[key] = value;
    }

    // If content is being updated, re-parse frontmatter
    if (typeof updates.content === "string") {
      const pm = parseSkillContent(updates.content as string);
      updates.name = pm.name;
      updates.description = pm.description;
      updates.allowedTools = pm.allowedTools;
      updates.model = pm.model;
      updates.effort = pm.effort;
      updates.context = pm.context;
      updates.agent = pm.agent;
      updates.disableModelInvocation = pm.disableModelInvocation;
      updates.userInvocable = pm.userInvocable;
    }

    const skill = updateSkill(parsed.params.id, updates as Parameters<typeof updateSkill>[1]);
    if (!skill) {
      jsonError(res, "Skill not found", 404);
      return true;
    }
    json(res, { skill });
    return true;
  }

  // DELETE /api/skills/:id
  if (deleteSkillRoute.match(req.method, pathSegments)) {
    const parsed = await deleteSkillRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const deleted = deleteSkill(parsed.params.id);
    if (!deleted) {
      jsonError(res, "Skill not found", 404);
      return true;
    }
    json(res, { success: true });
    return true;
  }

  return false;
}
