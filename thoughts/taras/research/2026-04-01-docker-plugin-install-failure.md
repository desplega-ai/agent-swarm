---
date: 2026-04-01T12:00:00+00:00
researcher: Claude
git_commit: 4a024c8
branch: main
repository: agent-swarm
topic: "Docker worker Claude plugins not available at runtime — marketplace registered but plugin install silently fails"
tags: [research, docker, plugins, claude-code, context-mode, agent-fs]
status: complete
autonomy: autopilot
last_updated: 2026-04-01
last_updated_by: Claude
---

# Research: Docker Worker Claude Plugins Not Available at Runtime

**Date**: 2026-04-01
**Researcher**: Claude
**Git Commit**: 4a024c8
**Branch**: main

## Research Question

Claude plugins installed in `Dockerfile.worker` are not available when running the claude command in workers. The marketplace is visible but the plugin itself is not loaded. Specifically, the context-mode MCP and agent-fs plugins are affected.

## Summary

The root cause is **wrong marketplace names in the `claude plugin install` commands** in `Dockerfile.worker`. When a marketplace is added via `claude plugin marketplace add <github-owner>/<repo>`, the marketplace gets a **local name** derived from the repo's `.claude-plugin/marketplace.json` `name` field — NOT from the GitHub repo name. The install commands in the Dockerfile use the GitHub repo name as the marketplace identifier, which doesn't match the registered local name, causing a silent failure (exit code 0 but "Plugin not found in marketplace" error).

Specifically:
- `claude plugin marketplace add mksglu/claude-context-mode` registers marketplace as **`context-mode`** (from its `marketplace.json` name), but the Dockerfile tries to install `context-mode@claude-context-mode` (wrong marketplace name).
- `claude plugin marketplace add desplega-ai/agent-fs` registers marketplace as **`agent-fs`** (from its `marketplace.json` name), but the Dockerfile tries to install `agent-fs@desplega-ai-agent-fs` (wrong marketplace name).

The `|| true` guards in the Dockerfile swallow the errors, making the failure invisible during build.

## Detailed Findings

### Plugin Installation Flow in Dockerfile (`Dockerfile.worker:106-117`)

The Dockerfile has a two-step process for each plugin:
1. `claude plugin marketplace add <github-owner>/<repo>` — clones the marketplace repo into `~/.claude/plugins/marketplaces/<marketplace-name>/`
2. `claude plugin install <plugin-name>@<marketplace-name> --scope user` — reads the marketplace's `marketplace.json`, finds the named plugin, and copies it to `~/.claude/plugins/cache/<marketplace-name>/<plugin-name>/<version>/`

The install step also registers the plugin in `~/.claude/plugins/installed_plugins.json`, which is what Claude Code reads at startup to know which plugins are active.

### Marketplace Name Resolution

When `claude plugin marketplace add` runs, the marketplace's local name comes from the `name` field in `.claude-plugin/marketplace.json` inside the cloned repo:

| GitHub repo | `marketplace.json` name | Registered as | Dockerfile uses |
|---|---|---|---|
| `desplega-ai/ai-toolbox` | `desplega-ai-toolbox` | `desplega-ai-toolbox` | `desplega-ai-toolbox` (correct) |
| `desplega-ai/qa-use` | `desplega.ai` | `desplega.ai` | `desplega.ai` (correct) |
| `mksglu/claude-context-mode` | `context-mode` | `context-mode` | `claude-context-mode` (WRONG) |
| `desplega-ai/agent-fs` | `agent-fs` | `agent-fs` | `desplega-ai-agent-fs` (WRONG) |

### Verification Inside Docker Container

Built the image locally and inspected:

**`known_marketplaces.json`** — All 4 marketplaces are registered correctly:
```json
{
  "desplega-ai-toolbox": { ... },
  "desplega.ai": { ... },
  "context-mode": { ... },   // <-- registered as "context-mode", NOT "claude-context-mode"
  "agent-fs": { ... }        // <-- registered as "agent-fs", NOT "desplega-ai-agent-fs"
}
```

**`installed_plugins.json`** — Only 3 of 5 plugins are installed (context-mode and agent-fs are missing):
```json
{
  "version": 2,
  "plugins": {
    "desplega@desplega-ai-toolbox": [ ... ],
    "wts@desplega-ai-toolbox": [ ... ],
    "qa-use@desplega.ai": [ ... ]
    // context-mode and agent-fs are ABSENT
  }
}
```

**Manual install test inside container** confirmed the wrong names fail and correct names succeed:
```
# FAILS:
claude plugin install context-mode@claude-context-mode --scope user
# -> "Plugin "context-mode" not found in marketplace "claude-context-mode""

# SUCCEEDS:
claude plugin install context-mode@context-mode --scope user
# -> "Successfully installed plugin: context-mode@context-mode"

# FAILS:
claude plugin install agent-fs@desplega-ai-agent-fs --scope user
# -> "Plugin "agent-fs" not found in marketplace "desplega-ai-agent-fs""

# SUCCEEDS:
claude plugin install agent-fs@agent-fs --scope user
# -> "Successfully installed plugin: agent-fs@agent-fs"
```

### Why the Error is Invisible

The `|| true` guards in `Dockerfile.worker:106-117` suppress all failures:

```dockerfile
RUN mkdir -p /home/worker/.claude \
    && claude plugin marketplace add mksglu/claude-context-mode || true \
    && claude plugin install context-mode@claude-context-mode --scope user || true \
    ...
```

Additionally, `claude plugin install` returns exit code 0 even on failure (the error is only printed to stderr/stdout).

### User-Switching (Not the Cause, but Verified)

The Dockerfile ends with `USER root`, and the entrypoint runs as root. The final `exec gosu worker /usr/local/bin/agent-swarm ...` drops to the `worker` user. Since plugins were installed as `worker` (the `USER worker` section runs the install commands), and `gosu worker` sets `HOME=/home/worker`, the HOME directory alignment is correct. This is NOT contributing to the bug.

## Code References

| File | Line | Description |
|------|------|-------------|
| `Dockerfile.worker` | 106-117 | Plugin marketplace add + install commands (contains the bugs) |
| `Dockerfile.worker` | 96 | Claude CLI installation as worker user |
| `Dockerfile.worker` | 127-142 | `.claude/settings.json` with `enabledMcpjsonServers: ["context-mode"]` reference |
| `docker-entrypoint.sh` | 738 | `exec gosu worker` — final user switch |

## Fix

Change lines 113 and 116 in `Dockerfile.worker`:

```dockerfile
# Before (wrong):
&& claude plugin install context-mode@claude-context-mode --scope user || true \
&& claude plugin install agent-fs@desplega-ai-agent-fs --scope user || true

# After (correct):
&& claude plugin install context-mode@context-mode --scope user || true \
&& claude plugin install agent-fs@agent-fs --scope user || true
```

## Open Questions

- Should the `|| true` guards be removed or replaced with proper error checking so plugin install failures don't go unnoticed in the future?
- The `claude plugin install` command returning exit code 0 on failure is arguably a bug in Claude Code itself — worth reporting?
