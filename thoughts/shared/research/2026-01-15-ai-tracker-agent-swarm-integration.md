---
date: 2026-01-15T13:15:00Z
topic: "ai-tracker Integration for Agent-Swarm Workers"
researcher: "Agent 16990304-76e4-4017-b991-f3e37b34cf73 (Researcher)"
status: "complete"
---

# Research: Integrating ai-tracker into Agent-Swarm Workers

## Executive Summary

This research investigates integrating `ai-tracker` from the `desplega-ai/ai-toolbox` repository into agent-swarm workers. Agent-swarm workers are Docker containers running Claude Code CLI in headless mode, which means ai-tracker's Claude Code hooks are directly applicable. The key requirement is adding environment variable support to ai-tracker for configurable database paths to enable per-agent tracking in a shared location.

---

## 1. ai-tracker Overview

### 1.1 What is ai-tracker?

**Source**: [desplega-ai/ai-toolbox/ai-tracker](https://github.com/desplega-ai/ai-toolbox/tree/main/ai-tracker)
**Package Name**: `cc-ai-tracker` (PyPI)
**License**: MIT
**Python Support**: 3.11, 3.12, 3.13

**Purpose**: Track what percentage of code changes in git repos are AI-generated (via Claude Code) versus human-made.

### 1.2 Installation Methods

```bash
# Option 1: uvx (no install needed)
uvx cc-ai-tracker install

# Option 2: Local install with uv
uv tool install cc-ai-tracker
ai-tracker install
```

### 1.3 How It Works

ai-tracker operates through three integrated components:

| Component | Function |
|-----------|----------|
| **Claude Code Hooks** | PreToolUse/PostToolUse hooks capture Edit/Write operations with line counts |
| **Git Post-commit Hook** | Attributes committed changes to AI or human based on the edit log |
| **CLI Statistics** | Queries SQLite database and displays formatted results |

**Data Flow:**
```
Claude Code Edit/Write → PostToolUse Hook → SQLite (edits table)
                                               ↓
Git Commit → Post-commit Hook → SQLite (commits table with AI/human attribution)
```

### 1.4 Database and Configuration

| Setting | Current Value |
|---------|---------------|
| **Database** | `~/.config/ai-tracker/tracker.db` (SQLite with WAL) |
| **Config Dir** | `~/.config/ai-tracker/` |
| **Git Hooks** | `~/.config/ai-tracker/git-hooks/` |
| **Claude Settings** | `~/.claude/settings.json` |

### 1.5 Claude Code Hooks (from setup.py)

The `install` command adds these hooks to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{"type": "command", "command": "ai-tracker hook-post-tool"}]
    }],
    "PreToolUse": [{
      "matcher": "Write",
      "hooks": [{"type": "command", "command": "ai-tracker hook-pre-tool"}]
    }]
  }
}
```

### 1.6 CLI Commands

```bash
ai-tracker install       # Install Claude Code + git hooks
ai-tracker uninstall     # Remove all hooks
ai-tracker stats         # Show all-time statistics
ai-tracker stats --graph # Stats + chart for last 7 days
ai-tracker stats --repo my-project  # Filter by repository
```

---

## 2. Agent-Swarm Worker Architecture

### 2.1 Overview

Agent-swarm workers are **Docker containers running Claude Code CLI in headless loop mode**. Each worker:
- Runs as a non-root `worker` user
- Has Claude Code CLI installed via official installer
- Uses MCP (Model Context Protocol) to communicate with the swarm server
- Has hooks configured in `~/.claude/settings.json`

### 2.2 Key Files in agent-swarm

| File | Purpose |
|------|---------|
| `Dockerfile.worker` | Worker container build (Ubuntu 24.04 base) |
| `docker-entrypoint.sh` | Container startup script |
| `src/cli.tsx` | Compiled agent-swarm binary |
| `plugin/` | Claude Code commands, agents, and skills |

### 2.3 Current Worker Hooks Configuration (Dockerfile.worker:89-101)

```json
{
  "permissions": { "allow": ["mcp__agent-swarm__*"] },
  "hooks": {
    "SessionStart": [{"matcher": "*", "hooks": [{"type": "command", "command": "/usr/local/bin/agent-swarm hook"}]}],
    "UserPromptSubmit": [{"matcher": "*", "hooks": [{"type": "command", "command": "/usr/local/bin/agent-swarm hook"}]}],
    "PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "/usr/local/bin/agent-swarm hook"}]}],
    "PostToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "/usr/local/bin/agent-swarm hook"}]}]
  }
}
```

### 2.4 Worker Environment Variables

| Variable | Purpose |
|----------|---------|
| `AGENT_ID` | UUID identifying the agent |
| `AGENT_ROLE` | "worker" or "lead" |
| `MCP_BASE_URL` | URL to MCP server |
| `API_KEY` | Authentication for MCP |
| `GITHUB_TOKEN` | Git operations authentication |

### 2.5 Container Initialization (docker-entrypoint.sh)

The entrypoint script:
1. Validates required env vars (CLAUDE_CODE_OAUTH_TOKEN, API_KEY)
2. Starts PM2 for background service management
3. Creates `/workspace/.mcp.json` for MCP configuration
4. Sets up git authentication if GITHUB_TOKEN provided
5. Installs plugins from desplega-ai marketplace
6. Executes optional `/workspace/start-up.*` script
7. Runs `/usr/local/bin/agent-swarm <role>` to start Claude Code

---

## 3. Integration Plan

### 3.1 Required Changes to ai-tracker

**Issue**: ai-tracker has a **hardcoded database path** in `config.py`:
```python
def get_db_path() -> Path:
    return get_config_dir() / "tracker.db"  # Fixed to ~/.config/ai-tracker/

def get_config_dir() -> Path:
    config_dir = Path.home() / ".config" / "ai-tracker"
    config_dir.mkdir(parents=True, exist_ok=True)
    return config_dir
```

**Proposed Fix**: Add environment variable support:
```python
def get_db_path() -> Path:
    if custom_path := os.environ.get("AI_TRACKER_DB_PATH"):
        path = Path(custom_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        return path
    return get_config_dir() / "tracker.db"

def get_config_dir() -> Path:
    if custom_dir := os.environ.get("AI_TRACKER_CONFIG_DIR"):
        config_dir = Path(custom_dir)
    else:
        config_dir = Path.home() / ".config" / "ai-tracker"
    config_dir.mkdir(parents=True, exist_ok=True)
    return config_dir
```

**GitHub Issue Required**: Create issue in `desplega-ai/ai-toolbox` repo requesting this feature.

### 3.2 Docker Integration

**Step 1: Install ai-tracker in Dockerfile.worker**

Add after the Claude CLI installation (around line 80):
```dockerfile
# Install uv for Python package management
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/home/worker/.local/bin:$PATH"

# Install ai-tracker
RUN uv tool install cc-ai-tracker
```

**Step 2: Add hooks to settings.json template**

Modify the settings.json in Dockerfile.worker to include ai-tracker hooks:
```json
{
  "permissions": { "allow": ["mcp__agent-swarm__*"] },
  "hooks": {
    "PreToolUse": [
      {"matcher": "*", "hooks": [{"type": "command", "command": "/usr/local/bin/agent-swarm hook"}]},
      {"matcher": "Write", "hooks": [{"type": "command", "command": "ai-tracker hook-pre-tool"}]}
    ],
    "PostToolUse": [
      {"matcher": "*", "hooks": [{"type": "command", "command": "/usr/local/bin/agent-swarm hook"}]},
      {"matcher": "Edit|Write", "hooks": [{"type": "command", "command": "ai-tracker hook-post-tool"}]}
    ]
  }
}
```

**Step 3: Configure per-agent database in docker-entrypoint.sh**

Add after the workspace initialization section:
```bash
# Configure ai-tracker for per-agent database
echo ""
echo "=== AI Tracker Configuration ==="
if [ -n "$AGENT_ID" ]; then
    TRACKER_DIR="/workspace/shared/tracking"
    mkdir -p "$TRACKER_DIR"
    export AI_TRACKER_DB_PATH="${TRACKER_DIR}/${AGENT_ID}.db"
    echo "AI Tracker DB: $AI_TRACKER_DB_PATH"

    # Install git hooks for this agent
    ai-tracker git-install --global 2>/dev/null || true
else
    echo "AGENT_ID not set, using default ai-tracker path"
fi
echo "================================"
```

### 3.3 Per-Agent Database Structure

```
/workspace/shared/tracking/
├── 16990304-76e4-4017-b991-f3e37b34cf73.db   # Worker 1
├── d454d1a5-4df9-49bd-8a89-e58d6a657dc3.db   # Lead Agent
├── 38d36438-58a0-45b5-8602-a5d52b07c2f1.db   # Worker 2
└── .gitkeep
```

Benefits:
- Each agent has isolated tracking data
- Shared volume allows aggregation/analysis
- No SQLite concurrency issues between agents

---

## 4. Implementation Steps

### 4.1 Phase 1: ai-tracker Enhancement

1. **Create GitHub Issue** in `desplega-ai/ai-toolbox`:
   - Title: "Add environment variable support for configurable database path"
   - Request: `AI_TRACKER_DB_PATH` and `AI_TRACKER_CONFIG_DIR` env vars
   - Use case: Multi-agent environments where each agent needs its own database

2. **Implement the change** (or wait for issue to be addressed):
   - Modify `config.py` to check environment variables
   - Update README with new configuration options

### 4.2 Phase 2: Dockerfile.worker Updates

1. Add `uv` installation for Python tool management
2. Install `cc-ai-tracker` via `uv tool install`
3. Update `settings.json` template with ai-tracker hooks

### 4.3 Phase 3: docker-entrypoint.sh Updates

1. Add tracking directory creation
2. Set `AI_TRACKER_DB_PATH` environment variable
3. Run `ai-tracker git-install` at startup

### 4.4 Phase 4: Testing

1. Build updated worker image
2. Start multiple workers with different AGENT_IDs
3. Verify each worker creates its own database
4. Run some Edit/Write operations and git commits
5. Check `ai-tracker stats` shows correct data per agent

---

## 5. Alternative Approaches

### 5.1 Use uvx at Runtime (No Install Required)

Instead of installing ai-tracker in the image, use uvx in hooks:

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{"type": "command", "command": "AI_TRACKER_DB_PATH=/workspace/shared/tracking/${AGENT_ID}.db uvx cc-ai-tracker hook-post-tool"}]
    }]
  }
}
```

**Pros**: No image rebuild needed
**Cons**: Slower (uvx fetches package each time), env var interpolation may not work in JSON

### 5.2 Shared Single Database

Instead of per-agent databases, use a single shared database with agent_id column:

**Pros**: Easier aggregation
**Cons**: SQLite concurrency issues, needs schema changes in ai-tracker

### 5.3 External Tracking Service

Send tracking data to a centralized service instead of local SQLite:

**Pros**: Real-time aggregation, no storage management
**Cons**: Requires new service, network dependency

---

## 6. Recommendations

### 6.1 Recommended Approach

**Use per-agent databases with environment variable configuration:**

1. Create issue in ai-toolbox for env var support
2. Update Dockerfile.worker to install ai-tracker
3. Update docker-entrypoint.sh to set per-agent paths
4. Update settings.json to include ai-tracker hooks

This approach:
- Works with ai-tracker's existing architecture
- Minimal changes required
- Maintains agent isolation
- Allows easy aggregation later

### 6.2 Action Items

| Priority | Action | Owner |
|----------|--------|-------|
| 1 | Create GitHub issue in ai-toolbox | Swarm Lead |
| 2 | Implement env var support in ai-tracker | ai-toolbox maintainer |
| 3 | Update Dockerfile.worker | agent-swarm PR |
| 4 | Update docker-entrypoint.sh | agent-swarm PR |
| 5 | Test multi-agent tracking | QA |

---

## 7. Appendix

### 7.1 ai-tracker Source Files Reviewed

| File | Purpose |
|------|---------|
| `src/ai_tracker/config.py` | Path configuration (needs env var support) |
| `src/ai_tracker/setup.py` | Claude Code hook installation |
| `src/ai_tracker/cli.py` | CLI commands (install, stats, etc.) |
| `src/ai_tracker/git/install.py` | Git hook installation |
| `src/ai_tracker/hooks/log_claude_edit.py` | PostToolUse hook handler |
| `src/ai_tracker/hooks/capture_before_write.py` | PreToolUse hook handler |

### 7.2 agent-swarm Files Reviewed

| File | Purpose |
|------|---------|
| `Dockerfile.worker` | Worker container build |
| `docker-entrypoint.sh` | Container startup script |
| `DEPLOYMENT.md` | Deployment documentation |
