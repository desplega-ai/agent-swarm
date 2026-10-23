# Learning

You are managing institutional knowledge — capturing insights, searching prior learnings, and promoting important patterns into CLAUDE.md for permanent reference.

## When to Use

This skill activates when:
- User invokes `/learning` command
- Another skill references `desplega:learning`
- User says "let's capture this," "what did we learn about X," or similar knowledge-management phrases

## Subcommand Routing

Parse the first argument to determine the flow:

| Argument | Flow |
|----------|------|
| *(no args)* or `status` | Setup / Status |
| `capture [insight]` | Capture |
| `recall <topic>` | Recall |
| `promote [id-or-topic]` | Promote |
| `review` | Review |

---

## Setup / Status (`/learning` with no args)

1. **Check for config**: Read `~/.agentic-learnings.json`
2. **If not found** (first run):
   - Explain the learning system briefly: "The learning skill captures, searches, and promotes institutional knowledge across sessions and projects. It stores learnings as markdown files with structured frontmatter."
   - Create `~/.agentic-learnings.json` with the default schema (see Config File Schema below), using the local backend
   - Use **AskUserQuestion**: "Would you like to configure additional backends? (qmd for semantic search, agent-fs for remote team storage)" with options: `["Local only (default)", "Configure qmd", "Configure agent-fs", "Configure both"]`
   - If qmd selected:
     - Check if qmd MCP tools are available (try `mcp__qmd__status`). Note this in config as `"accessMode": "mcp"` or `"cli"`.
     - Use **AskUserQuestion**: "Which qmd collections should be searched for learnings? (enter comma-separated names, e.g., 'ai-toolbox, my-notes')"
   - If agent-fs selected, walk through configuration step by step:
     - Use **AskUserQuestion**: "Do you have an agent-fs API key configured?" with options: `["Yes, it's set in my environment (AGENT_FS_API_KEY)", "Yes, I'll provide it now", "No, I need to set one up first"]`
     - If providing now: use **AskUserQuestion**: "Enter your agent-fs API key"
     - If needs setup: explain how to get one and pause
     - Use **AskUserQuestion**: "Which agent-fs organization should learnings be stored in?" with options: `["Use existing org (I'll provide the name)", "Create a new org for learnings"]`
     - If existing: use **AskUserQuestion**: "Enter the organization name"
     - If new: use **AskUserQuestion**: "What should the new organization be called?" — then run `agent-fs org create <name>` via Bash
     - Use **AskUserQuestion**: "Which drive should learnings be stored in?" with options: `["Use existing drive (I'll provide the name)", "Create a new 'learnings' drive"]`
     - If existing: use **AskUserQuestion**: "Enter the drive name"
     - If new: run `agent-fs drive create learnings --org <org>` via Bash
   - **CLAUDE.md Bootstrap**: After config creation, use **AskUserQuestion**: "Would you like me to add a Learning System section to your project CLAUDE.md so future sessions know about the learning system?" with options: `["Yes, add to project CLAUDE.md", "Yes, add to global ~/.claude/CLAUDE.md", "No, skip"]`
   - If yes, append the following section to the chosen CLAUDE.md:
     ```markdown
     ## Learning System
     Use `/learning recall <topic>` before research/planning to check for prior learnings.
     Use `/learning capture` to record significant insights, decisions, and gotchas.
     Config: `~/.agentic-learnings.json`
     ```
3. **If found** (returning user):
   - Show configured backends and their status (enabled/disabled)
   - Count learnings per backend (local: Glob count, agent-fs: `agent-fs ls` count)
   - Show 5 most recent learnings (filename + topic from frontmatter)

---

## Capture (`/learning capture`)

### Step 1: Get the Insight

- If invoked with inline text (e.g., `/learning capture "qmd requires manual update"`): use that as the insight
- If no text provided: use **AskUserQuestion**: "What insight or learning would you like to capture?"

### Step 2: Significance Check

Before proceeding, evaluate using these default heuristics:

1. Would this help someone else in a future session? (primary test)
2. Is this already documented in CLAUDE.md or code comments? (skip if yes)
3. Did the user correct the agent's approach? (always capture)
4. Was something surprisingly difficult or broken? (usually capture)

**Override**: If a `## Learning Capture Rules` section exists in project or global CLAUDE.md, those rules take precedence over the defaults above.

If the insight doesn't pass the significance threshold, mention this to the user but still offer to capture it — the user has final say.

### Step 3: Categorize

Use **AskUserQuestion**: "What category best fits this learning?" with options:
- `product-decisions` — architectural choices, trade-offs, why we chose X over Y
- `technical-gotchas` — bugs, footguns, surprising behavior, workarounds
- `human-nudges` — user corrections, workflow preferences, communication style
- `patterns` — reusable approaches, conventions, best practices discovered
- `mistakes` — things that went wrong and what to do differently

### Step 4: Scope

Use **AskUserQuestion**: "Should this learning be personal or shared?" with options:
- `Personal` — saved to `thoughts/{user}/learnings/`, visible only in this user's context
- `Shared` — saved to `thoughts/shared/learnings/`, git-tracked, visible to all collaborators (human and agent)

### Step 5: Write the Learning

1. Generate filename: `YYYY-MM-DD-<slug>.md`
   - Slug: derive from topic, lowercase, hyphens, max 50 chars
   - When capturing to shared scope, include author name in slug to avoid multi-user conflicts (e.g., `2026-03-19-taras-qmd-indexing.md`)
2. Fill the template from `template.md` with the collected information
3. Write using the **Write** tool to the appropriate path
4. **Sync backends**:
   - If qmd backend enabled: run `qmd update` via Bash
   - If agent-fs backend enabled: run `agent-fs write /learnings/<filename> --content "<content>"` via Bash
5. Confirm capture with file path

---

## Recall (`/learning recall`)

### Step 1: Get the Topic

- If invoked with a topic (e.g., `/learning recall qmd indexing`): use that
- If no topic: use **AskUserQuestion**: "What topic would you like to search for?"

### Step 2: Search All Configured Backends in Parallel

Query all enabled backends simultaneously:

- **Local**: Grep for the topic in `thoughts/{user}/learnings/` and `thoughts/shared/learnings/`
- **qmd**: Use `mcp__qmd__query` with `[{type:'lex', query:'<topic>'}, {type:'vec', query:'<topic>'}]`, scoped to configured collections
- **agent-fs**: Run `agent-fs search --query "<topic>"` or `agent-fs fts --query "<topic>"` via Bash

### Step 3: Present Results

- Rank results by relevance (exact matches first, semantic matches second)
- Show each result with: date, category, topic, and a 1-line summary
- Include `file:line` references for local results
- Offer to read the full learning or take action (promote, archive)

---

## Promote (`/learning promote`)

### Step 1: Select a Learning

- If given a file path: read that learning directly
- If given a topic: run recall first, then let the user select which learning to promote
- If no argument: run recall with no topic (list recent), let user select

### Step 2: Choose Target

Use **AskUserQuestion**: "Where should this learning be promoted to?" with options:
- `Project CLAUDE.md` — add to the current project's CLAUDE.md
- `Global ~/.claude/CLAUDE.md` — add to the global CLAUDE.md

### Step 3: Format and Append

1. Read the full learning file
2. Format it as a concise rule (1-3 lines) suitable for CLAUDE.md
3. Use **AskUserQuestion** to confirm the formatted rule before writing
4. Append to the chosen CLAUDE.md under an appropriate section (create a section if needed)
5. Update the learning file's frontmatter: set `promoted_to:` to the target path (e.g., `promoted_to: "CLAUDE.md"` or `promoted_to: "~/.claude/CLAUDE.md"`)

---

## Review (`/learning review`)

### Step 1: List All Learnings

- List all learnings from the default backend (most recent first)
- Show 1-line summaries: date, category, topic, promoted status
- Use local backend: Glob `thoughts/{user}/learnings/*.md` + `thoughts/shared/learnings/*.md`

### Step 2: Select for Review

Use **AskUserQuestion** (multiSelect): "Which learnings would you like to review?" with the list of learnings

### Step 3: Process Each Selected Learning

For each selected learning:
1. Show the full content
2. Use **AskUserQuestion**: "What would you like to do with this learning?" with options:
   - `Keep` — no changes
   - `Promote` — run the Promote flow for this learning
   - `Archive` — move to `thoughts/{user}/learnings/archive/` (or shared equivalent)
   - `Delete` — remove the file entirely

### Step 4: Alternative — File Review

If `file-review` is available (check if the command exists), offer it as an alternative for batch review:
- "Would you like to use file-review for a visual batch review instead?"
- If yes: create a temporary summary file and launch file-review

### Step 5: Report

After processing all selected learnings, report: "Kept N, promoted N, archived N, deleted N."

---

## Backend Adapter Reference

All backends support 4 operations: **write**, **search**, **list**, **delete**.

### Local Backend

| Operation | Implementation |
|-----------|---------------|
| **write** | Write tool to `thoughts/{user}/learnings/` or `thoughts/shared/learnings/` |
| **search** | Grep/Glob for topic across both personal and shared learnings directories |
| **list** | `Glob thoughts/{user}/learnings/*.md` + `Glob thoughts/shared/learnings/*.md` |
| **delete** | `Bash rm <path>` (learning file is just a local file) |

### qmd Backend

**qmd** is a local search engine over markdown documents. It can be accessed via MCP tools (if configured as an MCP server) or via CLI.

- **Install**: `npm install -g @tobilu/qmd` (or `bun install -g @tobilu/qmd`) — [github.com/tobi/qmd](https://github.com/tobi/qmd)
- **MCP access**: Use `mcp__qmd__query`, `mcp__qmd__get`, `mcp__qmd__multi_get` tools (available when qmd MCP server is configured)
- **CLI access**: Run `qmd query`, `qmd get`, `qmd update` via Bash (always available if installed)

| Operation | Implementation |
|-----------|---------------|
| **write** | Same as local (qmd indexes local files), then `qmd update` via Bash to re-index |
| **search** | MCP: `mcp__qmd__query` with lex+vec sub-queries, scoped to configured collections. CLI: `qmd query --collection <name> "<topic>"` via Bash |
| **list** | MCP: `mcp__qmd__multi_get` with glob pattern (e.g., `learnings/*.md`). CLI: `qmd get "learnings/*.md"` via Bash |
| **delete** | Delete local file + `qmd update` via Bash (qmd re-indexes, removing the entry) |

Prefer MCP tools when available (richer output, no shell escaping). Fall back to CLI if MCP is not configured.

### agent-fs Backend

**agent-fs** provides remote, team-wide file storage with semantic search. Accessed via CLI only.

- **Install**: `bun add -g @desplega.ai/agent-fs` — [github.com/desplega-ai/agent-fs](https://github.com/desplega-ai/agent-fs)
- **CLI access**: All operations use `agent-fs <command>` via Bash

| Operation | Implementation |
|-----------|---------------|
| **write** | `agent-fs write /learnings/<filename> --content "<content>"` via Bash |
| **search** | `agent-fs search --query "<topic>"` (semantic) or `agent-fs fts --query "<topic>"` (keyword) via Bash |
| **list** | `agent-fs ls /learnings/` via Bash |
| **delete** | `agent-fs rm /learnings/<filename>` via Bash |

---

## Config File Schema

The config file lives at `~/.agentic-learnings.json`:

```json
{
  "defaultBackend": "local",
  "backends": {
    "local": { "enabled": true, "basePath": "thoughts/{user}/learnings/" },
    "qmd": { "enabled": false, "accessMode": "mcp", "collections": [] },
    "agentFs": { "enabled": false, "apiKey": "", "org": "", "drive": "" }
  }
}
```

- `defaultBackend`: which backend to use for writes (always "local" initially)
- `backends.local.basePath`: path template — `{user}` is replaced at runtime with the current user's name
- `backends.qmd.accessMode`: `"mcp"` (preferred, uses MCP tools) or `"cli"` (fallback, uses qmd CLI via Bash)
- `backends.qmd.collections`: list of qmd collection names to search
- `backends.agentFs`: agent-fs connection details (only needed if using remote team storage)
- `backends.agentFs.apiKey`: API key — can be set here or via `AGENT_FS_API_KEY` env var

## What This Skill is NOT

- **Not a chatbot memory** — learnings are deliberate, curated knowledge, not conversation history
- **Not automatic** — the agent doesn't auto-capture; it nudges via sub-skill references and the user/agent decides
- **Not a replacement for CLAUDE.md** — learnings are the staging area; important ones get promoted to CLAUDE.md
- **Not brain** — brain is a separate personal knowledge tool; this skill is for project/team institutional knowledge
