---
date: 2026-03-09T12:00:00-05:00
researcher: Claude
git_commit: fcfd06df3857fbb1c9fadac6429e018f3ddfece5
branch: main
repository: agent-swarm
topic: "Templates Registry: Pre-configured worker templates with browsing UI and docker-compose generation"
tags: [research, templates, registry, docker-compose, workers, ui, nextjs]
status: complete
autonomy: autopilot
last_updated: 2026-03-09
last_updated_by: Claude
---

# Research: Templates Registry for Agent-Swarm Workers

**Date**: 2026-03-09
**Researcher**: Claude
**Git Commit**: fcfd06d
**Branch**: main

## Research Question

Design a templates registry system (`templates.agent-swarm.dev`) for pre-configured worker templates. The system involves a NextJS browsing UI, file-based template storage, docker-compose generation, and a `TEMPLATE_ID` mechanism for workers to pull configuration on first start. Official templates: lead, Coder, Researcher, Reviewer, Tester.

## Summary

The agent-swarm already has all the agent profile fields needed for templates (`claudeMd`, `soulMd`, `identityMd`, `toolsMd`, `setupScript`) plus a well-defined boot sequence that generates defaults when fields are missing. The current system has no templating or docker-compose generation — `docker-compose.example.yml` is a manually-duplicated static file, and each worker's identity is generated from generic defaults at first boot. A templates registry would provide curated, role-specific content for these 5 profile fields, served via a static Next.js site and consumed either at docker-compose generation time or at worker boot time via `TEMPLATE_ID`.

## Detailed Findings

### 1. Current Agent Profile Fields (Template Target Fields)

The agent profile system stores 5 versionable fields per agent in the `agents` table. These are the exact fields a template would populate:

| Field | DB Column | Workspace File | Max Size | Purpose |
|-------|-----------|---------------|----------|---------|
| `claudeMd` | `agents.claudeMd` | `/workspace/CLAUDE.md` + `~/.claude/CLAUDE.md` | 65536 chars | Agent instructions, project-specific rules |
| `soulMd` | `agents.soulMd` | `/workspace/SOUL.md` | 65536 chars | Persona, behavioral directives, core identity |
| `identityMd` | `agents.identityMd` | `/workspace/IDENTITY.md` | 65536 chars | Structured identity card (role, expertise, style) |
| `toolsMd` | `agents.toolsMd` | `/workspace/TOOLS.md` | 65536 chars | Operational knowledge (repos, services, APIs) |
| `setupScript` | `agents.setupScript` | `/workspace/start-up.sh` | 65536 chars | Bash script for container initialization |

**Source**: `src/types.ts:143-177` (AgentSchema), `src/types.ts:202-208` (VersionableFieldSchema)

All 5 fields are:
- Generated with generic defaults at registration (`src/be/db.ts:2107-2286`)
- Written to workspace files at boot (`src/commands/runner.ts:1949-2001`)
- Synced back to DB on edit and session end (`src/hooks/hook.ts`)
- Version-tracked in `context_versions` table with change source attribution

### 2. Current Default Template Generators

Four functions in `src/be/db.ts` generate defaults when an agent has no profile content:

| Function | Line | Generates |
|----------|------|-----------|
| `generateDefaultClaudeMd(agent)` | 2107 | Instructions based on name, description, role, capabilities |
| `generateDefaultSoulMd(agent)` | 2154 | Philosophical persona based on name, role |
| `generateDefaultIdentityMd(agent)` | 2214 | Structured identity card with name, description, role, capabilities |
| `generateDefaultToolsMd(agent)` | 2252 | Environment knowledge template (mostly placeholders) |

These are called in `runner.ts:1900-1910` when profile fields are missing. They produce generic content — not role-optimized. A template would replace these defaults with curated, role-specific content.

### 3. Current Docker Compose Setup

**Static example file**: `docker-compose.example.yml`

The existing compose file defines 4 services:
- `api` — `ghcr.io/desplega-ai/agent-swarm:latest`, port 3013, healthcheck
- `lead` — `ghcr.io/desplega-ai/agent-swarm-worker:latest`, `AGENT_ROLE=lead`, port `${LEAD_PORT:-3020}`
- `worker-1` — same image, `AGENT_ROLE=worker`, port `${WORKER1_PORT:-3021}`
- `worker-2` — same image, `AGENT_ROLE=worker`, port `${WORKER2_PORT:-3022}`

Each worker/lead has:
- A hardcoded `AGENT_ID` UUID
- A unique host port via env var with default
- Shared volumes: `swarm_logs`, `swarm_shared`
- A personal volume: `swarm_lead`, `swarm_worker_1`, `swarm_worker_2`
- `MCP_BASE_URL=http://api:3013` (Docker service DNS)
- `depends_on: api` with healthcheck condition

**No generation logic exists.** Adding a new worker means copy-pasting a service block and changing name/port/UUID/volume. There is no `TEMPLATE_ID` concept.

### 4. Worker Boot Sequence (Where Templates Would Be Consumed)

The boot has two phases where template content would be applied:

**Phase A: docker-entrypoint.sh** (shell-level, before agent binary)
1. Validates env vars (`CLAUDE_CODE_OAUTH_TOKEN`, `API_KEY`)
2. Fetches ecosystem config from API → starts PM2 services
3. Fetches swarm config from API → exports as env vars
4. Generates `/workspace/.mcp.json`
5. Auth setup (GitHub/GitLab)
6. Auto-clones repos from API
7. Fetches + composes setup scripts from API (`GET /api/agents/{id}/setup-script`)
8. Executes `/workspace/start-up.sh`
9. `exec agent-swarm worker|lead`

**Phase B: runner.ts runAgent()** (binary-level)
1. `POST /api/agents` — register/reactivate
2. `GET /me` — fetch profile (soulMd, identityMd, claudeMd, toolsMd, setupScript)
3. **If fields missing → generate defaults** ← This is the injection point
4. `PUT /api/agents/{id}/profile` — save generated defaults
5. Write identity files to `/workspace/`
6. Build system prompt from identity fields
7. Enter poll loop

**Template injection could happen at step B.3**: instead of `generateDefault*()`, fetch template content from registry by `TEMPLATE_ID` and use that as the initial profile content — but only on first boot (when fields are empty).

### 5. Dashboard UI (new-ui/) — Branding Reference

The existing dashboard is a **Vite 7 + React 19 SPA** (not Next.js despite the directory name). Key branding elements:

| Aspect | Details |
|--------|---------|
| **Fonts** | Space Grotesk (body), Space Mono (code) — Google Fonts |
| **Colors** | oklch color space. Amber accent (`oklch(0.555 0.163 48.998)` light / `oklch(0.769 0.188 70.08)` dark). Zinc neutral base. |
| **Dark mode** | Default. `class="dark"` on HTML. Zinc-900 backgrounds. |
| **Component lib** | shadcn/ui (new-york style) + Radix UI primitives |
| **Styling** | Tailwind CSS v4 (CSS-first config in `globals.css`) |
| **Icons** | Lucide React |
| **Linter** | Biome |
| **Theme meta** | `#18181b` (zinc-900) |

**Status color system**: emerald (success/idle), amber (busy/active), red (failed), yellow (pending), blue (reviewing), zinc (offline/cancelled).

**Key design tokens** (from `new-ui/src/styles/globals.css`):
- Border radius: sm=6px, md=8px, lg=10px, xl=12px
- Card backgrounds: `oklch(0.21 0.006 285.885)` (dark)
- Border: `oklch(1 0 0 / 10%)` (white at 10% opacity, dark mode)

### 6. Existing Template Interpolation

The workflow engine has a simple `{{path.to.value}}` interpolation utility at `src/workflows/template.ts`. This could be reused if template files need variable substitution (e.g., `{{agent.name}}`, `{{agent.role}}`).

### 7. PM2 Ecosystem Generation (Existing Pattern)

The API already generates PM2 ecosystem configs dynamically via `GET /ecosystem` endpoint (`src/http/ecosystem.ts`). This pattern — reading from a DB/config and producing structured JSON — is analogous to what docker-compose generation would do.

## Template Config Schema (Proposed Structure)

Based on the 5 profile fields and agent metadata, a template's `config.json` would map files to agent fields:

```jsonc
{
  "name": "coder",
  "displayName": "Coder",
  "description": "Full-stack developer agent optimized for writing, reviewing, and shipping code",
  "version": "1.0.0",
  "category": "official",
  "icon": "code", // Lucide icon name
  "author": "desplega",
  "agentDefaults": {
    "role": "coder",
    "capabilities": ["typescript", "react", "node", "testing"],
    "maxTasks": 3
  },
  "files": {
    "CLAUDE.md": "claudeMd",
    "SOUL.md": "soulMd",
    "IDENTITY.md": "identityMd",
    "TOOLS.md": "toolsMd",
    "start-up.sh": "setupScript"
  }
}
```

Each file in the template directory maps to an agent profile field. The template directory:

```
templates/official/coder/
  config.json
  CLAUDE.md      -> agents.claudeMd
  SOUL.md        -> agents.soulMd
  IDENTITY.md    -> agents.identityMd
  TOOLS.md       -> agents.toolsMd
  start-up.sh    -> agents.setupScript
```

## Docker Compose Generation

A generated docker-compose would follow the existing `docker-compose.example.yml` pattern, with these additions per worker:

```yaml
worker-coder-1:
  image: ghcr.io/desplega-ai/agent-swarm-worker:latest
  environment:
    - AGENT_ROLE=worker
    - AGENT_ID=${CODER_1_AGENT_ID}  # Pre-generated UUID
    - AGENT_NAME=coder-1
    - TEMPLATE_ID=official/coder     # New: template reference
    - MCP_BASE_URL=http://api:3013
    # ... standard env vars from .env
  volumes:
    - swarm_logs:/logs
    - swarm_shared:/workspace/shared
    - swarm_coder_1:/workspace/personal
  ports:
    - "${CODER_1_PORT:-3021}:3000"
  depends_on:
    api:
      condition: service_healthy
```

The generator would need:
1. **Input**: Template selections (e.g., 1 lead, 2 coders, 1 researcher, 1 reviewer)
2. **Output**: `docker-compose.yml` + `.env` file with pre-generated UUIDs and port allocations
3. **Port allocation**: Starting from 3020 (lead), incrementing for each worker
4. **Volume naming**: `swarm_<role>_<index>` pattern

## Template Consumption Flow

Two possible consumption models:

### Model A: Build-time (docker-compose generation)
1. CLI/UI selects templates and count
2. Generator produces docker-compose + .env with `TEMPLATE_ID` per worker
3. On first boot, `docker-entrypoint.sh` or `runner.ts` fetches template from `templates.agent-swarm.dev/api/templates/{id}`
4. Template content used as initial profile instead of generic defaults
5. After first boot, agent evolves its profile independently

### Model B: API-seeded (registration-time)
1. CLI/UI selects templates and count
2. Generator produces docker-compose + .env (same as Model A)
3. Before starting workers, a setup script calls the agent-swarm API to pre-create agents with template content
4. Workers boot and find their profiles already populated — no template fetch needed

**Model A is simpler** — it requires only a `TEMPLATE_ID` env var and a fetch in the boot sequence. The template site serves a simple JSON API alongside the browsing UI.

## Templates Site Architecture

A standalone Next.js app at `templates.agent-swarm.dev`:

```
templates-ui/
  package.json
  next.config.js
  public/
    logo.png              # Same logo as new-ui
  src/
    app/
      layout.tsx          # Root layout with branding
      page.tsx            # Template gallery (grid of cards)
      [category]/
        [name]/
          page.tsx        # Template detail view
    components/
      template-card.tsx   # Gallery card component
      template-detail.tsx # Full template view with file previews
      compose-builder.tsx # Interactive docker-compose generator
      header.tsx
      footer.tsx
    lib/
      templates.ts        # Reads templates from filesystem at build time
  templates/              # Template data (or at repo root)
    official/
      lead/
        config.json
        CLAUDE.md
        SOUL.md
        IDENTITY.md
        TOOLS.md
        start-up.sh
      coder/
        ...
      researcher/
        ...
      reviewer/
        ...
      tester/
        ...
    community/
      ...
```

**Key decisions**:
- Static site generation (SSG) — templates are read at build time via `fs` in `getStaticProps`/server components
- No backend needed — template data lives in the repo
- API route (`/api/templates/[category]/[name]`) serves template JSON for worker consumption
- Branding matches new-ui: Space Grotesk/Mono fonts, amber accent, zinc base, dark mode default, shadcn/ui components

## API Endpoint for Template Consumption

The templates site would expose a simple API for workers to fetch templates:

```
GET /api/templates/official/coder
→ {
    "name": "coder",
    "displayName": "Coder",
    "version": "1.0.0",
    "agentDefaults": { "role": "coder", "capabilities": [...], "maxTasks": 3 },
    "files": {
      "claudeMd": "# Coder Agent\n...",
      "soulMd": "# Soul\n...",
      "identityMd": "# Identity\n...",
      "toolsMd": "# Tools\n...",
      "setupScript": "#!/bin/bash\n..."
    }
  }
```

## Integration Points in Existing Codebase

### 1. runner.ts — Template fetch at boot (Phase B.3)

Current code at `runner.ts:1900-1910`:
```typescript
if (!agentSoulMd || !agentIdentityMd || !agentToolsMd || !agentClaudeMd) {
  agentSoulMd = agentSoulMd || generateDefaultSoulMd(...);
  agentIdentityMd = agentIdentityMd || generateDefaultIdentityMd(...);
  agentToolsMd = agentToolsMd || generateDefaultToolsMd(...);
  agentClaudeMd = agentClaudeMd || generateDefaultClaudeMd(...);
}
```

Would become:
```typescript
if (!agentSoulMd || !agentIdentityMd || !agentToolsMd || !agentClaudeMd) {
  const templateId = process.env.TEMPLATE_ID;
  if (templateId) {
    const template = await fetchTemplate(templateId); // GET templates.agent-swarm.dev/api/templates/{id}
    agentSoulMd = agentSoulMd || template.files.soulMd;
    // ... etc
  } else {
    agentSoulMd = agentSoulMd || generateDefaultSoulMd(...);
    // ... etc (existing fallback)
  }
}
```

### 2. docker-compose.example.yml — Add TEMPLATE_ID

Each service would gain `TEMPLATE_ID` in its environment block.

### 3. Dockerfile.worker — Add TEMPLATE_REGISTRY_URL env default

```dockerfile
ENV TEMPLATE_REGISTRY_URL=https://templates.agent-swarm.dev
```

## Code References

| File | Lines | Relevance |
|------|-------|-----------|
| `src/types.ts` | 143-177 | AgentSchema — all profile fields |
| `src/types.ts` | 202-208 | VersionableFieldSchema — the 5 template-able fields |
| `src/be/db.ts` | 2107-2286 | `generateDefault*()` — current default generators |
| `src/be/db.ts` | 2296-2391 | `updateAgentProfile()` — how profiles are saved |
| `src/commands/runner.ts` | 1872-1947 | Profile fetch + default generation at boot |
| `src/commands/runner.ts` | 1949-2001 | Workspace file writing |
| `src/tools/join-swarm.ts` | 95-126 | Registration + default template generation |
| `src/tools/update-profile.ts` | 16-63 | All updatable profile fields |
| `src/hooks/hook.ts` | 660-736 | SessionStart — claudeMd injection |
| `src/hooks/hook.ts` | 310-330 | Stop — claudeMd sync back |
| `docker-entrypoint.sh` | 243-309 | Setup script composition from API |
| `docker-entrypoint.sh` | 314-404 | Startup script execution |
| `docker-compose.example.yml` | 1-72 | Current static compose structure |
| `ecosystem.config.cjs` | 1-68 | PM2 local dev config |
| `src/workflows/template.ts` | 1-15 | `{{var}}` interpolation utility |
| `src/http/ecosystem.ts` | 1-30 | Dynamic ecosystem generation pattern |
| `new-ui/src/styles/globals.css` | 1-88 | All design tokens for branding |
| `new-ui/index.html` | 16-19 | Font loading (Space Grotesk, Space Mono) |
| `new-ui/src/components/layout/app-sidebar.tsx` | 1-100 | Sidebar/nav pattern |

## Decisions (from review)

1. **Template variable interpolation**: Yes — templates support `{{agent.name}}` etc. via the existing `src/workflows/template.ts` interpolation utility. The API returns raw/plain content (interpolated). The UI can render placeholders more nicely (highlighted, with descriptions).
2. **Template versioning**: Both pinned and latest. Format: `<id>@<version>` (e.g., `official/coder@1.2.0`). If no version specified, use latest.
3. **Community template submission**: For now, `contact@agent-swarm.dev` + PR-based. Create a GitHub issue/PR template for community submissions.
4. **Template registry caching**: Yes — cache fetched templates locally if not too complex. Avoids network dependency on subsequent boots.
5. **Compose generation scope**: Both CLI tool and interactive builder in the templates UI.
