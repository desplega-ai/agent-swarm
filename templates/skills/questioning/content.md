# Questioning

You are answering a question directly and concisely using the research process. No documents are created by default — the answer is the deliverable.

## When to Use

This skill activates when:
- User invokes `/question` command
- Another skill references `desplega:questioning`
- User asks a focused question that doesn't need a full research document

## Philosophy

This is the fastest path from question to answer. Unlike `/research` (which documents comprehensively) or `/brainstorm` (which explores interactively), `/question` gets straight to the point:

1. Hear the question
2. Investigate as needed
3. Answer inline
4. Offer next steps

**No ceremony** — no autonomy prompts, no preference setup, no working agreement. Just answer the question.

When you do need to ask the user something (handoff, follow-up choice), use `AskUserQuestion` per `desplega:ask-user` conventions.

## Process

### Step 1: Analyze the Question

Classify the question to determine what investigation is needed:

| Question Type | Investigation Needed | Example |
|---------------|---------------------|---------|
| **Factual/locational** | Quick codebase search | "Where is the auth middleware defined?" |
| **Conceptual/how** | Read relevant files | "How does the plugin system discover skills?" |
| **Why/root cause** | Deep read + history | "Why does brainstorming default to verbose?" |
| **Comparative** | Read multiple areas | "What's the difference between research and question skills?" |
| **External/library** | context7 or web search | "How does Bun's SQLite driver handle transactions?" |

### Step 2: Investigate

Based on the question type, use the appropriate tools. **Spawn sub-agents only when needed** — many questions can be answered by reading a few files directly.

**For codebase questions:**
- Read directly mentioned files first (use Read tool WITHOUT limit/offset)
- Use **codebase-locator** agent if you need to find WHERE something lives
- Use **codebase-analyzer** agent if you need to understand HOW something works
- Use **codebase-pattern-finder** agent if you need examples of a pattern

**For library/framework questions:**
- Use context7 MCP to fetch documentation (`resolve-library-id` → `query-docs`)

**For external/web questions:**
- Use **web-search-researcher** agent for documentation or examples

**Efficiency rule**: If you can answer by reading 1-3 files, just read them. Don't spawn sub-agents for simple lookups.

### Step 3: Answer

Present the answer as **inline text** (not a document). Structure it naturally based on the question:

- **Short answers**: 1-3 sentences with a file:line reference
- **Medium answers**: A paragraph or two with key references
- **Detailed answers**: Structured with headings if needed, but keep it focused

**Unlike research, you MAY:**
- Suggest improvements if the question implies a problem
- Perform root cause analysis if the question asks "why"
- Give opinions when asked ("which approach is better?")
- Be direct and opinionated rather than exhaustively neutral

**Always include**:
- Specific `file:line` references for any claims about the codebase
- Code snippets when they clarify the answer (keep them short)

### Step 4: Handoff

After answering, use **AskUserQuestion** with:

| Question | Options |
|----------|---------|
| "What would you like to do next?" | 1. Ask another question, 2. Save this answer to thoughts, 3. Start a brainstorm from this topic (→ `/brainstorm`), 4. Start research from this topic (→ `/research`), 5. Done |

Based on the answer:

- **Ask another question**: Use AskUserQuestion to ask "What's your next question?" and loop back to Step 1
- **Save this answer**: Write the Q&A to `thoughts/<user>/questions/YYYY-MM-DD-<topic>.md` using the template at `template.md`. Path selection: use the user's name if known, fall back to `thoughts/shared/questions/`
- **Brainstorm**: Suggest `/brainstorm <topic>` with the question's topic as context
- **Research**: Suggest `/research <topic>` with the question's topic as context
- **Done**: No further action

## Looping Behavior

When the user selects "Ask another question," the skill loops:
1. Ask for the next question via AskUserQuestion
2. Investigate and answer (Steps 1-3)
3. Present handoff options again (Step 4)

Each iteration is independent — no state accumulates between questions unless the user explicitly connects them.

## Learning Capture

**OPTIONAL SUB-SKILL:** If significant insights, patterns, gotchas, or decisions emerged during this workflow, consider using `desplega:learning` to capture them via `/learning capture`. Focus on learnings that would help someone else in a future session.

## What This Skill is NOT

- **Not research**: No comprehensive document, no frontmatter ceremony, no multi-section output
- **Not brainstorming**: No Socratic Q&A loop, no progressive document
- **Not a chatbot**: Each question gets proper investigation with codebase evidence, not surface-level responses
