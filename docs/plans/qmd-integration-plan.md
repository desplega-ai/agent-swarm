# QMD Knowledge Base Integration - Implementation Plan

**Date**: 2026-01-16
**Author**: Researcher Agent (16990304-76e4-4017-b991-f3e37b34cf73)
**Status**: Implemented
**Research Reference**: [QMD Knowledge Base Integration Research](https://github.com/desplega-ai/agent-swarm/blob/main/thoughts/shared/research/2026-01-15-qmd-knowledge-base-integration.md)

## Overview

This plan describes integrating [QMD (Quick Markdown Search)](https://github.com/tobi/qmd) into the agent-swarm worker environment. QMD provides hybrid search (BM25 + vector + LLM re-ranking) for markdown documents, with native MCP server support for Claude Code integration.

### Key Decisions (from stakeholder feedback)

| Question | Decision |
|----------|----------|
| Multi-Agent Concurrent Access | Accept SQLite write locks for <10 agents (writes may queue but won't fail) |
| Model Download | Pre-download ~1.6GB models in Docker build (not first-use) |
| Index Size | Not a concern (2TB disk available) |

---

## Phase 1: Docker Build Modifications

**Goal**: Install QMD and pre-download models during Docker image build.

### Files to Modify

#### `Dockerfile.worker`

Add QMD installation after Bun installation (around line 80):

```dockerfile
# Install QMD globally (after Bun installation for worker user)
RUN HOME=/home/worker bun install -g https://github.com/tobi/qmd

# Pre-download QMD models (~1.6GB) to avoid first-use delay
# Models: EmbeddingGemma-300M (~300MB), Qwen3-Reranker-0.6B (~640MB), Qwen3-0.6B (~640MB)
RUN mkdir -p /home/worker/.cache/qmd/models && \
    HOME=/home/worker qmd embed --help || true
```

**Note**: The `qmd embed --help` triggers model downloads. The `|| true` prevents build failure if models haven't been cached yet (they download on first actual use if this fails).

### Verification

```bash
# After building, verify in container:
qmd --version
ls -la ~/.cache/qmd/models/
```

---

## Phase 2: MCP Server Configuration

**Goal**: Add QMD as an MCP server for Claude Code integration.

### Files to Modify

#### `docker-entrypoint.sh`

Modify the MCP config creation section (around line 89-118) to include QMD:

**Current** (lines 91-103):
```bash
cat > /workspace/.mcp.json << EOF
{
  "mcpServers": {
    "agent-swarm": {
      ...
    }
  }
}
EOF
```

**New**:
```bash
cat > /workspace/.mcp.json << EOF
{
  "mcpServers": {
    "agent-swarm": {
      "type": "http",
      "url": "${MCP_URL}/mcp",
      "headers": {
        "Authorization": "Bearer ${API_KEY}",
        "X-Agent-ID": "${AGENT_ID}"
      }
    },
    "qmd": {
      "command": "qmd",
      "args": ["mcp"]
    }
  }
}
EOF
```

### MCP Tools Exposed

Once configured, Claude Code will have access to these QMD tools:

| Tool | Description |
|------|-------------|
| `qmd_search` | BM25 keyword search |
| `qmd_vsearch` | Vector semantic search |
| `qmd_query` | Hybrid search with re-ranking (recommended) |
| `qmd_get` | Retrieve document by path/docid |
| `qmd_multi_get` | Retrieve multiple documents |
| `qmd_status` | Index health check |
| `qmd_list` | List all indexed files |
| `qmd_refresh_index` | Trigger re-indexing |

---

## Phase 3: Collection Setup at Startup

**Goal**: Automatically configure QMD to index the shared workspace on container startup.

### Files to Modify

#### `docker-entrypoint.sh`

Add a new section after "Workspace Initialization" (around line 340):

```bash
echo ""
echo "=== QMD Knowledge Base Setup ==="

if command -v qmd >/dev/null 2>&1; then
    echo "Initializing QMD knowledge base..."

    # Add shared workspace as a collection (if not already added)
    if ! qmd collection list 2>/dev/null | grep -q "shared-kb"; then
        echo "Adding /workspace/shared as 'shared-kb' collection..."
        qmd collection add /workspace/shared --name shared-kb --mask "**/*.md" || true
        qmd context add qmd://shared-kb "Shared knowledge base for AI agent swarm" || true
    else
        echo "Collection 'shared-kb' already exists"
    fi

    # Update index (scan for new files)
    echo "Updating QMD index..."
    qmd update || true

    # Note: Embedding generation is expensive, skip on startup
    # Agents can run 'qmd embed' manually when needed
    echo "QMD setup complete (run 'qmd embed' to generate embeddings)"
else
    echo "QMD not found, skipping knowledge base setup"
fi
echo "================================"
```

### Collection Configuration

| Collection | Path | Mask | Context |
|------------|------|------|---------|
| `shared-kb` | `/workspace/shared` | `**/*.md` | "Shared knowledge base for AI agent swarm" |

---

## Phase 4: Usage Documentation

**Goal**: Document how agents should use QMD for knowledge sharing.

### Create New File: `docs/QMD.md`

```markdown
# QMD Knowledge Base

QMD (Quick Markdown Search) provides hybrid search over the shared workspace.

## Quick Start

### Search Commands

```bash
# Hybrid search (recommended - best quality)
qmd query "authentication patterns" -n 5

# Fast keyword search
qmd search "OAuth2"

# Semantic vector search
qmd vsearch "how to handle errors"
```

### MCP Tools (in Claude Code)

Use these tools directly in your Claude session:

- `qmd_query` - Hybrid search with re-ranking
- `qmd_get` - Retrieve specific document
- `qmd_status` - Check index health

### Workflow

1. **Before starting a task**: Search for relevant prior research
   ```bash
   qmd query "topic keywords" -n 5
   ```

2. **After completing research**: Update the index
   ```bash
   qmd update && qmd embed
   ```

### Indexed Collections

| Name | Path | Description |
|------|------|-------------|
| `shared-kb` | `/workspace/shared` | All markdown files in shared workspace |

### Score Interpretation

| Score | Meaning |
|-------|---------|
| 0.8-1.0 | Highly relevant |
| 0.5-0.8 | Moderately relevant |
| 0.2-0.5 | Somewhat relevant |
| 0.0-0.2 | Low relevance |
```

---

## Implementation Summary

### Files Changed

| File | Change Type | Description |
|------|-------------|-------------|
| `Dockerfile.worker` | Modify | Add QMD installation + model pre-download |
| `docker-entrypoint.sh` | Modify | Add QMD to MCP config + collection setup |
| `docs/QMD.md` | New | Usage documentation |

### Estimated Lines of Code

- `Dockerfile.worker`: +5 lines
- `docker-entrypoint.sh`: +25 lines (MCP config) + +20 lines (collection setup)
- `docs/QMD.md`: ~80 lines (new file)

**Total**: ~130 lines added/modified

---

## Testing Checklist

- [ ] Build Docker image with QMD installed
- [ ] Verify QMD binary is available in container
- [ ] Verify models are pre-downloaded (~1.6GB in `~/.cache/qmd/models/`)
- [ ] Verify MCP config includes QMD server
- [ ] Verify collection is created on container startup
- [ ] Test `qmd query` returns results for existing documents
- [ ] Test QMD MCP tools work in Claude Code session

---

## Rollout Plan

1. **PR Review**: This plan for approval
2. **Implementation**: Apply changes to `Dockerfile.worker` and `docker-entrypoint.sh`
3. **Local Testing**: Build and test Docker image locally
4. **Staging Deploy**: Test with staging agent swarm
5. **Production Deploy**: Roll out to production workers

---

## Open Considerations

### Future Enhancements (Not in Scope)

- Scheduled index maintenance (cron job for `qmd update && qmd embed`)
- Per-agent collections (currently all agents share one collection)
- Custom Claude Code skill/command for easier QMD access
- Monitoring/alerting for index health

### Potential Issues

1. **First embedding generation**: Takes time (~minutes for large collections). Consider running `qmd embed` as a background task or scheduled job.

2. **Concurrent write conflicts**: SQLite may queue writes with multiple agents. Acceptable for <10 agents per decision above.

3. **Model download reliability**: If model download fails during build, it will retry on first use. May cause initial delay for first agent.
