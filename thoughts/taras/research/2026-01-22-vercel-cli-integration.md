---
date: 2026-01-22T12:00:00-08:00
researcher: Claude
git_commit: 579d9bf009619656b8a487889e4c93d55e24e7d2
branch: main
repository: agent-swarm
topic: "Integrating Vercel CLI into agent-swarm workers and lead"
tags: [research, codebase, vercel, deployment, cli-integration]
status: complete
autonomy: verbose
last_updated: 2026-01-22
last_updated_by: Claude
---

# Research: Integrating Vercel CLI into Agent-Swarm Workers and Lead

**Date**: 2026-01-22
**Researcher**: Claude
**Git Commit**: 579d9bf
**Branch**: main

## Research Question

How to integrate the Vercel CLI into agent-swarm workers and lead automatically, so agents can deploy their projects. Focus on CLI wrapper approach (similar to `gh`) with a shared single token.

## Summary

The agent-swarm already has a well-established pattern for CLI tool integration, demonstrated by the GitHub CLI (`gh`) setup. The pattern involves: (1) installing the CLI in Docker images, (2) configuring authentication via environment variables in the entrypoint script, and (3) providing plugin commands that document usage patterns for Claude agents to follow.

For Vercel integration, the same pattern applies: install `vercel` CLI in worker images, set `VERCEL_TOKEN` environment variable for authentication, and create plugin command documentation. The Vercel CLI supports fully non-interactive operation via `--yes` and `--token` flags, with deployment URLs returned to stdout for easy capture.

Key commands for the full workflow: `vercel link` (project setup), `vercel deploy` (preview/production deployments), `vercel logs` (monitoring), `vercel env` (environment variables), and `vercel promote/rollback` (production management). All commands support `--token` for CI/CD authentication without interactive login.

## Detailed Findings

### 1. Existing gh CLI Integration Pattern

The GitHub CLI integration serves as the reference pattern for adding Vercel CLI support.

**Installation** (`Dockerfile.worker:54-60`):
```dockerfile
# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh
```

**Authentication Configuration** (`docker-entrypoint.sh:121-142`):
```bash
if [ -n "$GITHUB_TOKEN" ]; then
    echo "Configuring GitHub authentication..."
    gh auth setup-git
    # ...
fi
```

**Agent Awareness** (`src/prompts/base-prompt.ts:214-220`):
```typescript
const BASE_PROMPT_SYSTEM = `
### System packages available
You have a full Ubuntu environment with some packages pre-installed: node, bun, python3, curl, wget, git, gh, jq, etc.
`;
```

**Plugin Commands**: Workflow documentation in `plugin/commands/` (review-pr.md, create-pr.md, etc.) that agents follow.

### 2. Vercel CLI Capabilities for Automation

The Vercel CLI fully supports non-interactive/automated usage.

**Authentication**:
- Uses `VERCEL_TOKEN` environment variable automatically
- Can also pass `--token <token>` to any command
- Tokens created at https://vercel.com/account/tokens
- No interactive `vercel login` required for CI/CD

**Key Commands for Full Workflow**:

| Command | Purpose | Key Flags |
|---------|---------|-----------|
| `vercel link` | Connect directory to project | `--yes`, `--project <name>` |
| `vercel deploy` | Deploy to preview | `--yes`, `--token` |
| `vercel --prod` | Deploy to production | `--yes`, `--prod` |
| `vercel logs <url>` | View runtime logs | `--json` (for parsing) |
| `vercel inspect <url>` | Check deployment status | `--wait`, `--timeout` |
| `vercel env add <name>` | Add environment variable | `--environment`, stdin for value |
| `vercel env pull` | Download env vars locally | `--environment` |
| `vercel promote <url>` | Promote to production | `--yes` |
| `vercel rollback <url>` | Rollback production | `--timeout` |

**Deployment Output**:
- `vercel deploy` outputs the deployment URL to stdout
- Easy to capture: `DEPLOYMENT_URL=$(vercel --prod --yes)`

**JSON Support**:
- `vercel logs --json` returns structured JSON
- Other commands return human-readable text
- For structured data, REST API is recommended

### 3. Proposed Vercel CLI Installation

**For Dockerfile.worker** (npm-based installation):
```dockerfile
# Install Vercel CLI
RUN npm install -g vercel
```

**Alternative** (standalone binary, faster):
```dockerfile
# Install Vercel CLI via script
RUN curl -fsSL https://vercel.com/install.sh | bash
```

### 4. Proposed Entrypoint Configuration

**For docker-entrypoint.sh**:
```bash
# Configure Vercel authentication if token is provided
echo ""
echo "=== Vercel Authentication ==="
if [ -n "$VERCEL_TOKEN" ]; then
    echo "Vercel authentication configured via VERCEL_TOKEN"
    echo "Token is set and will be used automatically by vercel CLI"
else
    echo "WARNING: VERCEL_TOKEN not set - vercel deploy operations will fail"
fi
```

Note: Unlike `gh`, the Vercel CLI doesn't require a setup command - it automatically uses `VERCEL_TOKEN` from the environment.

### 5. Proposed Environment Variables

**For .env.example**:
```bash
# Vercel
VERCEL_TOKEN=                    # API token from https://vercel.com/account/tokens
VERCEL_ORG_ID=                   # Optional: default organization/team ID
VERCEL_PROJECT_ID=               # Optional: default project ID
VERCEL_DISABLE=false             # Optional: disable Vercel CLI availability
```

### 6. Proposed Plugin Command Structure

Create `plugin/commands/vercel-deploy.md`:

```markdown
# Vercel Deploy Command

## When to Use
When you need to deploy a project to Vercel.

## Prerequisites
- Project must have `vercel.json` or be a supported framework
- `VERCEL_TOKEN` must be set in the environment

## Workflow

### 1. Link Project (First Time Only)
```bash
cd /path/to/project

# Check if already linked
if [ ! -f ".vercel/project.json" ]; then
    vercel link --yes
fi
```

### 2. Deploy to Preview
```bash
DEPLOYMENT_URL=$(vercel --yes)
echo "Preview deployed to: $DEPLOYMENT_URL"
```

### 3. Deploy to Production
```bash
DEPLOYMENT_URL=$(vercel --prod --yes)
echo "Production deployed to: $DEPLOYMENT_URL"
```

### 4. Check Deployment Status
```bash
vercel inspect $DEPLOYMENT_URL --wait --timeout=5m
```

### 5. View Logs
```bash
vercel logs $DEPLOYMENT_URL --json | head -100
```
```

Additional commands to create:
- `plugin/commands/vercel-env.md` - Environment variable management
- `plugin/commands/vercel-rollback.md` - Production rollback procedures
- `plugin/commands/vercel-logs.md` - Log viewing and debugging

### 7. Updating Base Prompt

**Modify `src/prompts/base-prompt.ts`**:
```typescript
const BASE_PROMPT_SYSTEM = `
### System packages available
You have a full Ubuntu environment with some packages pre-installed: node, bun, python3, curl, wget, git, gh, vercel, jq, etc.
`;
```

### 8. Security Considerations (Single Token)

With a shared `VERCEL_TOKEN`:
- All agents deploy to the same Vercel account/team
- Token should have appropriate scope (team-level recommended)
- Token expires after 10 days of inactivity
- Consider using deployment protection rules in Vercel dashboard

**Token Scoping Options**:
- Full account access (default)
- Team-scoped tokens (recommended for shared use)
- Project-specific tokens (most restrictive)

### 9. Alternative: Vercel MCP Server Integration

While not the primary focus, there are existing MCP servers:

| Option | Type | Capabilities |
|--------|------|--------------|
| Official `https://mcp.vercel.com` | Read-only | Docs search, deployment info, logs |
| `Quegenx/vercel-mcp-server` | Full access | All API operations as MCP tools |

These could complement CLI usage for specific scenarios requiring structured responses.

## Code References

| File | Line | Description |
|------|------|-------------|
| `Dockerfile.worker` | 54-60 | GitHub CLI installation pattern |
| `docker-entrypoint.sh` | 121-142 | GitHub auth configuration pattern |
| `src/prompts/base-prompt.ts` | 214-220 | Available system packages documentation |
| `plugin/commands/review-pr.md` | 23-216 | gh CLI usage examples for agents |
| `plugin/commands/create-pr.md` | 39-86 | PR creation workflow example |
| `.env.example` | 1-50 | Environment variable template |
| `DEPLOYMENT.md` | 359-361 | GitHub env var documentation |

## Architecture Documentation

**CLI Integration Pattern**:
1. **Docker Installation**: Install CLI in `Dockerfile.worker`
2. **Entrypoint Configuration**: Set up auth in `docker-entrypoint.sh`
3. **Base Prompt**: Document availability in `src/prompts/base-prompt.ts`
4. **Plugin Commands**: Create workflow documentation in `plugin/commands/`
5. **Environment Variables**: Add to `.env.example` and `DEPLOYMENT.md`

**Key Design Decisions**:
- CLI tools are used via bash by Claude agents, not invoked from TypeScript
- Server-side operations use REST APIs directly (see `src/github/app.ts`)
- Authentication via environment variables, not interactive login
- Plugin commands serve as templates, not executable code

## Historical Context (from thoughts/)

No existing Vercel-related research or plans found in the thoughts/ directory. This is the first investigation into Vercel integration.

## Related Research

- No related research documents found

## Open Questions

1. **Error Handling**: How should agents handle deployment failures (retry, escalate, etc.)? → *Should be addressed in implementation*

## Decisions Made

1. **Project Linking Strategy**: Workers should link to projects dynamically based on task context (not pre-linked)
2. **Deployment Notifications**: Not initially - can be added later if needed
3. **Cost Monitoring**: Not for now - revisit if issues arise

## Implementation Checklist

- [ ] Add Vercel CLI installation to `Dockerfile.worker`
- [ ] Add `VERCEL_TOKEN` configuration to `docker-entrypoint.sh`
- [ ] Add Vercel env vars to `.env.example`
- [ ] Update `src/prompts/base-prompt.ts` to list `vercel`
- [ ] Create `plugin/commands/vercel-deploy.md`
- [ ] Create `plugin/commands/vercel-env.md`
- [ ] Create `plugin/commands/vercel-logs.md`
- [ ] Update `DEPLOYMENT.md` with Vercel configuration
- [ ] Test deployment workflow with worker agent
