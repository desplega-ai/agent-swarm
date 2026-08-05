# Brainstorming

You are facilitating interactive exploration of ideas through Socratic Q&A. The goal is understanding before implementation — documents grow progressively during the session and end as lightweight pre-PRDs that feed into `/research` or `/create-plan`.

## Working Agreement

Brainstorming is interactive by design — Q&A is the whole point. Use `AskUserQuestion` for every prompt, **one question at a time** (see Step 3 for the loop). This skill intentionally does *not* follow the `desplega:ask-user` batching convention — Socratic exploration needs single, focused questions.

File-review is on by default — invoke it on the brainstorm doc after synthesis.

## When to Use

This skill activates when:
- User invokes `/brainstorm` command
- Another skill references `**REQUIRED SUB-SKILL:** Use desplega:brainstorming`
- User wants to explore an idea before committing to research or planning
- User isn't ready for formal research yet

## Autonomy Mode

Brainstorming is inherently interactive, so only two modes are supported:

| Mode | Behavior |
|------|----------|
| **Verbose** (Default) | Full Socratic exploration, ask one question at a time, rich discussion |
| **Critical** | Fewer questions, focus on the most impactful areas, reach synthesis faster |

**Autopilot is not supported** — brainstorming requires human input by design. If Autopilot is requested, fall back to Critical with a note explaining why.

The autonomy mode is passed by the invoking command. If not specified, default to **Verbose**.

## Process Steps

### Step 1: Initialize Document

Create `thoughts/<username|shared>/brainstorms/YYYY-MM-DD-<topic>.md` using the template at `template.md`.

**Path selection:** Use the user's name (e.g., `thoughts/taras/brainstorms/`) if known from context. Fall back to `thoughts/shared/brainstorms/` when unclear.

Fill in the frontmatter and the Context section with whatever is known: the topic, any context provided, initial thoughts. Write what we know so far.

### Prior Learning Recall

**OPTIONAL SUB-SKILL:** If `~/.agentic-learnings.json` exists, run `/learning recall <current topic>` to check for relevant prior learnings before proceeding.

### Step 2: Assess Phase

Understand the shape of the exploration. Use **AskUserQuestion** with:

| Question | Options |
|----------|---------|
| "What kind of exploration is this?" | 1. Problem to solve, 2. Idea to develop, 3. Comparison to make, 4. Workflow to improve, 5. Other (describe) |

Update the document's `exploration_type` frontmatter and Context section with the exploration framing.

### Step 3: Explore Phase

Socratic Q&A loop. The goal is to systematically uncover requirements, constraints, and insights.

**Rules:**
- Ask **ONE question at a time** via AskUserQuestion
- **Every question ships with a recommended answer** — make your recommendation the first option, labeled "(Recommended)", with the reasoning in its description. Never ask open-endedly what you can propose a default for; the user confirms or overrides.
- **Facts vs decisions**: never ask the user something you can look up. What the code does, what a library supports, what the current behavior is — those are *facts*: spawn a quick background sub-agent (Haiku locate / Sonnet analyze, per `desplega:delegate-work`) mid-session and record the answer as an insight. Only genuine *decisions* — trade-offs, preferences, scope calls — go to the user.
- **Track the frontier**: maintain the set of unresolved decision branches (a short TodoWrite list works). Each answer may close a branch and open new ones. The exploration is done when the frontier is empty — every branch resolved or explicitly deferred, nothing left silently assumed.
- After each answer, append a new section to the document under `## Exploration`:
  ```markdown
  ### Q: [Your question]
  [User's answer]

  **Insights:** [Any observations, implications, or connections you noticed]
  ```
- Identify the next most important question to narrow scope or deepen understanding
- Continue until the user signals they're satisfied or natural saturation is reached

**Question strategy:**
- Start broad: understand the problem space and goals
- Narrow progressively: constraints, existing solutions, non-functional requirements
- Probe edges: "What would make this fail?", "What's the simplest version?", "What are you NOT trying to solve?"

### YAGNI Principle

**CRITICAL**: Resist premature solutions during the Explore phase. The goal is understanding, not implementation. If the user starts solutioning too early:
- Acknowledge the idea briefly
- Redirect to requirements: "That's an interesting approach. Before we commit to it, let's make sure we understand [relevant constraint/requirement]. [Follow-up question]"
- Solutions belong in the Synthesis or in a subsequent `/create-plan`

### Step 4: Synthesize Phase

When exploration is complete (the frontier is empty, or the user signals done), append a `## Synthesis` section:

```markdown
## Synthesis

### Key Decisions
- [Decision 1]
- [Decision 2]
- [Deferred: <decision> — defaulting to <recommended answer> unless revisited]

### Open Questions
- [FACT-shaped question only — answerable by /research, tagged as its input]

### Constraints Identified
- [Constraint 1]
- [Constraint 2]

### Core Requirements
- [Requirement 1 — lightweight PRD-style]
- [Requirement 2]
```

**A brainstorm that ends with undecided decisions is incomplete.** Open Questions may only contain *fact-shaped* items — things `/research` can answer from the codebase or docs. Decision-shaped questions must be either resolved in Key Decisions or recorded there as "Deferred, defaulting to X" with your recommendation written down. If the user cut the session short with decisions still open, ask once (batched) for a default on each before synthesizing — or record your own recommendation as the default, clearly marked.

### Learning Capture

**OPTIONAL SUB-SKILL:** If significant insights, patterns, gotchas, or decisions emerged during this workflow, consider using `desplega:learning` to capture them via `/learning capture`. Focus on learnings that would help someone else in a future session.

### Step 5: Handoff Phase

Before handoff, offer to run `/review` on the brainstorm document to identify unexplored areas.

Then use **AskUserQuestion** with:

| Question | Options |
|----------|---------|
| "What's the next step?" | 1. Start research based on this brainstorm (→ `/research`), 2. Create a plan directly (→ `/create-plan`), 3. Done for now (park the brainstorm) |

Based on the answer:
- **Research**: Suggest the `/research` command with the brainstorm file as input context
- **Plan**: Suggest the `/create-plan` command with the brainstorm file as input context
- **Done**: Set the document's `status` to `parked` or `complete` as appropriate

## Document Evolution

The brainstorm document is a living artifact during the session. It starts rough and gains structure through the Q&A process. By the end, it should be readable as a standalone context document that someone else could pick up and understand.

## Review Integration

File-review is on by default:
- After synthesis, invoke `/file-review:file-review <path>` for inline human comments
- Process feedback with the `file-review:process-review` skill
