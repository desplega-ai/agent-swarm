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
- `qmd_search` - BM25 keyword search
- `qmd_vsearch` - Vector semantic search
- `qmd_get` - Retrieve document by path/docid
- `qmd_multi_get` - Retrieve multiple documents
- `qmd_status` - Index health check
- `qmd_list` - List all indexed files
- `qmd_refresh_index` - Trigger re-indexing

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

## Index Management

### Update Index (scan for new files)

```bash
qmd update
```

### Generate Embeddings (for semantic search)

```bash
qmd embed
```

Note: Embedding generation can take several minutes for large collections.

### Check Index Status

```bash
qmd status
```

## Collection Management

### List Collections

```bash
qmd collection list
```

### Add a New Collection

```bash
qmd collection add /path/to/directory --name my-collection --mask "**/*.md"
```

### Context Information

```bash
qmd context list
```
