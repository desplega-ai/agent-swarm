---
date: 2026-02-24T06:50:00Z
topic: "Context Evals for Agent Identity Testing"
author: "Researcher (worker agent)"
status: "Draft"
repo: "desplega-ai/agent-swarm"
prior_work:
  - "CDLC Analysis (task e210caf9)"
  - "Agent Self-Improvement Research (PR #76)"
---

# Research: Context Evals for Agent Identity Testing

---

## Executive Summary

We currently edit agent identity files (SOUL.md, IDENTITY.md) by "feel" with no measurement of whether changes actually improve agent behavior. This is the single biggest gap identified in our [CDLC analysis](https://tessl.io/blog/context-development-lifecycle-better-context-for-ai-coding-agents/) — we have no "Evaluate" stage in our context lifecycle.

This research explores what to eval, how to eval it, what tooling exists, and what a minimal viable eval system would look like for our swarm. The conclusion: **we can build a useful V1 in ~1 week using LLM-as-judge scoring over synthetic task replays, integrated into our existing task/memory infrastructure.**

---

## Table of Contents

1. [The Problem](#1-the-problem)
2. [What Should We Eval?](#2-what-should-we-eval)
3. [How to Eval Context Changes](#3-how-to-eval-context-changes)
4. [Establishing a Baseline](#4-establishing-a-baseline)
5. [Tooling Options](#5-tooling-options)
6. [Practical Design: Minimal Viable Eval System](#6-practical-design-minimal-viable-eval-system)
7. [Prior Art](#7-prior-art)
8. [Cost and Effort Estimate](#8-cost-and-effort-estimate)
9. [Recommendations](#9-recommendations)

---

## 1. The Problem

### Current State

Our agents have a 4-file identity system:

| File | Role | Injected Into System Prompt? |
|------|------|------------------------------|
| **SOUL.md** | Persona, behavioral directives, values | Yes |
| **IDENTITY.md** | Expertise, working style, track record | Yes |
| **TOOLS.md** | Environment knowledge (repos, services) | No (read on demand) |
| **CLAUDE.md** | Personal operational notes | No (written to `~/.claude/CLAUDE.md`) |

SOUL.md and IDENTITY.md are injected directly into every agent's system prompt via `base-prompt.ts`. Changes to these files directly shape agent behavior on every task. Yet we have:

- **Zero measurement** of whether edits improve or degrade performance
- **No regression testing** — a "helpful" SOUL.md tweak might break task completion quality
- **No comparison mechanism** — we can't A/B test two identity configs
- **No scoring rubric** — we don't have a shared definition of "good agent behavior"

### Why This Matters

Identity files are the highest-leverage configuration in the system. They affect every interaction, every task, every decision an agent makes. Changing a single line in SOUL.md can alter an agent's approach to every task it encounters. Without evals, we're making these changes blind.

The CDLC framework calls this the "Evaluate" stage: *"TDD for context. Run evals to verify agent output reflects specified constraints. When evaluations fail, blame the context, not the agent."*

---

## 2. What Should We Eval?

### Behavioral Dimensions

Agent behavior isn't one-dimensional. We need to identify which dimensions matter most for our swarm and build targeted evals for each.

#### Tier 1: Core Competence (must eval)

| Dimension | What It Means | Example |
|-----------|--------------|---------|
| **Task Completion Quality** | Does the agent complete tasks correctly and thoroughly? | Given a research task, does the output cover all required topics? |
| **Instruction Following** | Does the agent follow specific instructions from the task? | If told to "use wts to create a PR", does it actually use wts? |
| **Tool Usage Accuracy** | Does the agent use the right tools in the right way? | Does it use `store-progress` with proper status/output when completing? |
| **Output Format Compliance** | Does output match expected format and structure? | Research docs have proper headers, plans have proper phases |

#### Tier 2: Behavioral Quality (should eval)

| Dimension | What It Means | Example |
|-----------|--------------|---------|
| **Communication Style** | Tone, verbosity, professionalism in Slack/channel messages | Concise updates vs. wall-of-text spam |
| **Self-Sufficiency** | Does the agent try to solve problems before asking for help? | Reads files before asking what's in them |
| **Progress Reporting** | Quality and frequency of `store-progress` calls | Regular meaningful updates vs. silence |
| **Error Handling** | How the agent responds to failures and blockers | Graceful degradation vs. giving up immediately |

#### Tier 3: Swarm-Level (could eval later)

| Dimension | What It Means | Example |
|-----------|--------------|---------|
| **Routing Accuracy** | Does the lead assign tasks to the right worker? | Research tasks go to Researcher, not Picateclas |
| **Cross-Agent Coordination** | Do agents collaborate effectively? | Proper use of shared memory, channel communication |
| **Knowledge Retention** | Do agents use memories and past context effectively? | Searches memory before starting related tasks |
| **Identity Coherence** | Does agent behavior match its SOUL.md/IDENTITY.md? | Researcher doesn't write production code |

### Recommended Starting Point

**Start with Tier 1.** Task completion quality and instruction following are the most concrete, measurable, and directly impacted by identity file changes. They also have the clearest ground truth — you can define what a "correct" task completion looks like.

---

## 3. How to Eval Context Changes

### Methodology Overview

| Approach | How It Works | Pros | Cons |
|----------|-------------|------|------|
| **Synthetic Task Replay** | Run the same task with different identity configs, compare outputs | Controlled, reproducible, fast | Synthetic != real; doesn't capture emergent behavior |
| **Before/After Scoring** | Score real task outputs before and after an identity change | Uses real work; no extra cost | Confounded by task difficulty; slow feedback loop |
| **A/B Testing** | Run two agents with different configs on similar real tasks | Gold standard for causality | Requires sufficient task volume; operationally complex |
| **Regression Suite** | Known-good task/output pairs; re-run after changes | Fast; catches regressions | Brittle; doesn't test new capabilities |
| **LLM-as-Judge** | Use a separate LLM to score agent outputs against rubrics | Scalable; handles nuance | Judge bias; requires calibration |

### Recommended: Synthetic Task Replay + LLM-as-Judge

This is the most practical approach for our swarm. Here's why:

1. **Synthetic tasks are controllable.** We define the task, the expected behavior, and the scoring rubric. No confounding variables.
2. **LLM-as-judge scales.** We can't manually review every eval run, but Claude/GPT can score outputs against rubrics reliably.
3. **It's cheap.** A replay task using Haiku costs ~$0.01-0.05. A judge call costs similar. An eval suite of 20 tasks costs ~$1-3.
4. **It integrates with what we have.** We already have task infrastructure, identity file injection, and session management.

### How LLM-as-Judge Works (Best Practices)

The LLM-as-judge pattern is now well-established in the eval community. Key principles from current research:

1. **Use a stronger model as judge.** If agents run on Sonnet, judge with Opus (or at minimum, a different Sonnet instance). Never use the same model instance to both generate and judge.

2. **Structured rubrics outperform open-ended scoring.** Instead of "rate this output 1-10", provide specific criteria:
   ```
   Score each dimension 0-3:
   - Completeness: Are all required sections present? (0=none, 1=some, 2=most, 3=all)
   - Accuracy: Are claims factually correct? (0=major errors, 1=some errors, 2=minor issues, 3=accurate)
   - Instruction following: Did the agent follow all task instructions? (0=ignored, 1=partially, 2=mostly, 3=fully)
   ```

3. **Pairwise comparison > absolute scoring.** Asking "is output A or B better?" is more reliable than "rate this 1-10". This is ideal for A/B testing identity configs.

4. **Include reasoning.** Require the judge to explain its scores. This lets humans audit the judge and catches hallucinated evaluations.

5. **Calibrate with human agreement.** Run the judge on examples where you know the right answer. Measure agreement rate. Adjust rubric if agreement is low.

6. **Known pitfalls to avoid:**
   - **Position bias:** Judges prefer the first option in pairwise comparisons. Randomize order.
   - **Verbosity bias:** Judges prefer longer outputs. Control for length in rubric.
   - **Self-enhancement bias:** Models rate their own outputs higher. Use a different model family or different instance.

---

## 4. Establishing a Baseline

Before we can measure improvement, we need to know where we are now.

### What We Already Track

Our system already captures data that can serve as baseline signals:

| Data Source | What It Tells Us | Location |
|-------------|-----------------|----------|
| **Task completion rate** | % of tasks completed vs. failed | `agent_tasks.status` |
| **Task output quality** | Free-text summary of what was accomplished | `agent_tasks.output` |
| **Task duration** | Time from assignment to completion | `createdAt` to `finishedAt` |
| **Cost per task** | Token usage and $ spent | `session_costs` table |
| **Memory accumulation** | Are agents learning and writing memories? | `agent_memory` count by agent |
| **Identity evolution** | Have agents updated their identity files? | `agents.soulMd` / `identityMd` change history (currently not tracked) |

### What's Missing for a Proper Baseline

1. **No quality scores on existing tasks.** We have completion status but not a quality rating. We'd need to retroactively score a sample of past task outputs using LLM-as-judge.

2. **No identity version history.** When SOUL.md changes, the old version is overwritten. We can't correlate performance changes with identity changes. (This is addressed in a separate research task on context versioning.)

3. **No task difficulty normalization.** A 100% completion rate on trivial tasks != 100% on hard tasks. We need difficulty-tagged eval tasks.

### Practical Baseline Strategy

**Step 1: Create a golden eval set.** Define 10-20 synthetic tasks spanning different difficulty levels and agent types (research, code review, implementation planning). Run each task with current identity configs. Score the outputs. This is your baseline.

**Step 2: Retroactive scoring.** Take a sample of 20-30 real completed tasks from the past month. Run them through the LLM judge with the same rubric. This gives a "real-world" baseline alongside the synthetic one.

**Step 3: Track going forward.** After any identity file change, re-run the golden eval set. Compare scores to baseline.

---

## 5. Tooling Options

### Existing Eval Frameworks

| Framework | Type | Good For | Not Good For | Our Fit |
|-----------|------|----------|--------------|---------|
| **[PromptFoo](https://github.com/promptfoo/promptfoo)** | Open-source CLI/lib | Prompt comparison, regression testing, CI/CD integration | Agent-level (multi-turn) evals | **High** — supports custom providers, LLM grading, assertions |
| **[Inspect AI](https://inspect.aisi.org.uk/)** | Open-source (UK AISI) | Agent task evals, tool-use scoring, sandboxed execution | Quick iteration; somewhat academic | **Medium** — purpose-built for agent evals but heavy |
| **[Braintrust](https://www.braintrust.dev/)** | Commercial SaaS | A/B testing prompts, online scoring, experiment tracking | Self-hosted; cost | **Low** — good but adds external dependency |
| **[DeepEval](https://github.com/confident-ai/deepeval)** | Open-source Python | LLM-as-judge metrics, CI integration, dataset management | TypeScript/Bun ecosystem | **Medium** — good patterns but wrong language |
| **[Ragas](https://docs.ragas.io/)** | Open-source Python | RAG evaluation specifically | General agent evals | **Low** — too RAG-specific |
| **Custom Harness** | Build our own | Perfect fit for our infra; full control | Dev time; maintenance | **Highest** — integrates with existing task/memory system |

### Recommendation: Custom Harness (Inspired by PromptFoo)

PromptFoo's architecture is the closest match to what we need, but our system is TypeScript/Bun-native and already has task infrastructure. Building a custom harness that borrows PromptFoo's patterns (YAML test definitions, assertion types, LLM-graded scoring) will give us:

1. **Native integration** with our task system, memory, and identity files
2. **No new dependencies** — runs in Bun, uses our existing OpenAI client
3. **Full control** over eval scenarios that involve multi-turn agent sessions
4. **Reuse of existing infra** — eval tasks can use the same `store-progress`, memory, and session lifecycle

That said, PromptFoo could be used as a **complementary tool** for quick prompt-level A/B tests before committing to full agent-level evals.

---

## 6. Practical Design: Minimal Viable Eval System

### Architecture Overview

```
+-----------------------------------------------------+
|                    Eval Runner                       |
|  (CLI command: `bun run eval` or scheduled task)     |
+-----------------------------------------------------+
|                                                     |
|  1. Load eval suite (YAML/JSON definitions)         |
|  2. For each eval case:                             |
|     a. Load identity config (SOUL.md + IDENTITY.md) |
|     b. Build system prompt via getBasePrompt()       |
|     c. Execute task (Claude API call or session)     |
|     d. Capture output                               |
|  3. Score outputs (LLM-as-judge + assertions)       |
|  4. Generate report (pass/fail + scores + diffs)    |
|  5. Store results in eval_results table             |
|                                                     |
+-----------------------------------------------------+
```

### Component Design

#### 6.1 Eval Suite Definition

Eval cases defined in YAML, stored in `evals/` directory in the repo:

```yaml
# evals/suites/researcher.yaml
name: "Researcher Agent Evals"
description: "Eval suite for Researcher identity config"
targetAgent: "researcher"
identityConfig:
  soulMd: "default"  # or path to specific version
  identityMd: "default"

cases:
  - id: "research-basic"
    name: "Basic research task"
    description: "Can the agent produce a structured research document?"
    task: |
      Research the differences between WebSockets and Server-Sent Events.
      Produce a structured markdown document with: summary, comparison table,
      and recommendation for a real-time notification system.
    assertions:
      - type: "contains"
        value: "## Summary"
      - type: "contains"
        value: "WebSocket"
      - type: "contains"
        value: "Server-Sent Events"
    scoring:
      - dimension: "completeness"
        rubric: |
          Score 0-3: Does the output contain all three required sections
          (summary, comparison table, recommendation)?
          0=none, 1=one section, 2=two sections, 3=all three
      - dimension: "accuracy"
        rubric: |
          Score 0-3: Are the technical claims about WebSockets and SSE correct?
          0=major errors, 1=some errors, 2=minor issues, 3=accurate
      - dimension: "instruction_following"
        rubric: |
          Score 0-3: Did the agent follow the specific format requested?
          0=ignored format, 1=partially followed, 2=mostly followed, 3=exact match

  - id: "research-with-tools"
    name: "Research task requiring tool use"
    description: "Can the agent properly use web search and produce findings?"
    task: |
      Research the latest changes in Bun v1.2. Use web search to find
      the changelog and summarize the top 5 most impactful changes.
    assertions:
      - type: "llm-judge"
        rubric: "Output must reference specific Bun version numbers and concrete features"
    scoring:
      - dimension: "tool_usage"
        rubric: |
          Score 0-3: Did the agent use web search tools to find current information
          rather than relying on training data?
          0=no search, 1=searched but poorly, 2=good search, 3=thorough search
      - dimension: "specificity"
        rubric: |
          Score 0-3: Does the output contain specific version numbers,
          feature names, and concrete details (not vague summaries)?
          0=vague, 1=somewhat specific, 2=mostly specific, 3=very specific

  - id: "communication-style"
    name: "Slack progress update style"
    description: "Does the agent communicate in the expected style?"
    task: |
      You are working on a complex task. Write a progress update for Slack
      that would be posted via slack-reply. The update should communicate
      that you've completed the research phase and are starting implementation.
    scoring:
      - dimension: "conciseness"
        rubric: |
          Score 0-3: Is the message concise and appropriate for Slack?
          0=wall of text, 1=too long, 2=reasonable length, 3=perfectly concise
      - dimension: "tone"
        rubric: |
          Score 0-3: Does the tone match the agent's SOUL.md personality?
          Check against: genuine helpfulness, skip pleasantries, just help.
          0=generic/chatty, 1=somewhat aligned, 2=mostly aligned, 3=perfectly aligned
```

#### 6.2 Eval Execution

Two execution modes:

**Mode A: Single-turn (fast, cheap)**
For evals that test output quality given a task prompt. Uses a single Claude API call with the agent's system prompt + task as user message. No session, no tools.

```typescript
// Pseudocode
async function runSingleTurnEval(evalCase: EvalCase, config: IdentityConfig) {
  const systemPrompt = getBasePrompt({
    role: config.role,
    agentId: config.agentId,
    soulMd: config.soulMd,
    identityMd: config.identityMd,
  });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    system: systemPrompt,
    messages: [{ role: "user", content: evalCase.task }],
    max_tokens: 4096,
  });

  return response.content[0].text;
}
```

**Mode B: Full session (realistic, expensive)**
For evals that test tool usage, multi-turn behavior, and task lifecycle compliance. Spawns a real Claude Code session with the agent's identity, lets it run the task, captures output via `store-progress`.

```typescript
// Pseudocode - uses existing runner infrastructure
async function runSessionEval(evalCase: EvalCase, config: IdentityConfig) {
  const task = await createTask({
    task: evalCase.task,
    agentId: config.agentId,
    tags: ["eval"],
  });

  const process = await spawnClaudeSession({
    systemPrompt: buildEvalSystemPrompt(config),
    taskId: task.id,
  });

  await waitForTaskCompletion(task.id, { timeout: 300_000 });
  return getTask(task.id).output;
}
```

#### 6.3 Scoring Engine

```typescript
interface EvalScore {
  dimension: string;     // e.g., "completeness", "accuracy"
  score: number;         // 0-3
  maxScore: number;      // 3
  reasoning: string;     // Judge's explanation
}

interface EvalResult {
  caseId: string;
  configHash: string;    // Hash of SOUL.md + IDENTITY.md for tracking
  timestamp: string;
  output: string;
  assertions: { name: string; passed: boolean }[];
  scores: EvalScore[];
  totalScore: number;    // Sum of all dimension scores
  maxTotalScore: number; // Sum of all max scores
  percentage: number;    // totalScore / maxTotalScore
  judgeModel: string;    // Which model scored this
  cost: number;          // $ cost of this eval run
}
```

**Judge prompt template:**

```
You are evaluating an AI agent's output. The agent was given the following task:

<task>
{task_description}
</task>

The agent produced this output:

<output>
{agent_output}
</output>

Score the output on the following dimension:

**{dimension_name}**
{rubric}

Respond with JSON:
{
  "score": <0-3>,
  "reasoning": "<1-2 sentence explanation>"
}
```

#### 6.4 Results Storage

New SQLite table:

```sql
CREATE TABLE IF NOT EXISTS eval_results (
  id TEXT PRIMARY KEY,
  suiteId TEXT NOT NULL,
  caseId TEXT NOT NULL,
  configHash TEXT NOT NULL,
  soulMdSnapshot TEXT,
  identityMdSnapshot TEXT,
  output TEXT NOT NULL,
  assertions TEXT NOT NULL,       -- JSON array of assertion results
  scores TEXT NOT NULL,           -- JSON array of EvalScore objects
  totalScore REAL NOT NULL,
  maxTotalScore REAL NOT NULL,
  percentage REAL NOT NULL,
  judgeModel TEXT NOT NULL,
  executionMode TEXT NOT NULL,    -- "single-turn" or "session"
  costUsd REAL,
  durationMs INTEGER,
  createdAt TEXT NOT NULL
);

CREATE INDEX idx_eval_results_suite ON eval_results(suiteId);
CREATE INDEX idx_eval_results_config ON eval_results(configHash);
CREATE INDEX idx_eval_results_created ON eval_results(createdAt);
```

#### 6.5 Reporting

The eval runner outputs a report:

```
== Researcher Agent Eval Report ==
Config: SOUL.md (hash: abc123...) + IDENTITY.md (hash: def456...)
Date: 2026-02-24
Judge: claude-sonnet-4-20250514

Case: research-basic
  Assertions: 3/3 passed
  Scores:
    completeness:         3/3  "All three sections present"
    accuracy:             2/3  "Minor inaccuracy about SSE max connections"
    instruction_following: 3/3  "Exact format match"
  Total: 8/9 (89%)

Case: research-with-tools
  Assertions: 1/1 passed
  Scores:
    tool_usage:           2/3  "Used web search but only one query"
    specificity:          3/3  "Referenced Bun 1.2.1 specific features"
  Total: 5/6 (83%)

Case: communication-style
  Scores:
    conciseness:          3/3  "Two sentences, clear and actionable"
    tone:                 2/3  "Slightly formal, SOUL.md says skip pleasantries"
  Total: 5/6 (83%)

== Suite Total: 18/21 (86%) ==
== Previous run: 16/21 (76%) -> +10% improvement ==
```

#### 6.6 Integration with Existing Systems

**Trigger: Identity file changes.**
When the PostToolUse hook detects a Write/Edit to SOUL.md or IDENTITY.md (already tracked in `hook.ts:823-841`), it could trigger an eval run. However, running evals during a live session would be too slow. Instead:

- **Option A:** Queue an eval task (using our scheduled tasks system) that runs the suite asynchronously after the session ends.
- **Option B:** Add a CI-like check — when a PR touches identity-related files, run evals before merge.
- **Option C:** Manual trigger via CLI: `bun run eval --suite researcher`

**Recommended: Option C for V1**, with Option A as a V2 enhancement.

**Memory integration.**
Eval results should be indexed into agent memory so agents can search "how did my last identity change affect my eval scores?" This is a natural extension of our existing `agent_memory` system.

---

## 7. Prior Art

### 7.1 CDLC "Evaluate" Stage (Tessl)

The Context Development Lifecycle framework explicitly names context evaluation as a stage:

> *"Evaluations for context work differently than traditional software tests. Context is inherently statistical -- the same prompt might produce different outputs each time. Evaluations verify that the overall quality distribution shifts in the right direction."*

Key principles we can adopt:
- **Statistical, not deterministic.** Run evals multiple times and measure distribution.
- **Blame the context, not the agent.** When evals fail, the fix is to improve the identity config, not retrain the model.
- **Eval before distribute.** Test identity changes before pushing them to production agents.

Tessl has also published a separate [Proposed Evaluation Framework for Coding Agents](https://tessl.io/blog/proposed-evaluation-framework-for-coding-agents/) which proposes 5 evaluation categories for coding agents: correctness, efficiency, adherence to conventions, documentation, and testing quality.

### 7.2 PersonaGym (arXiv 2407.18416)

Academic framework specifically for evaluating persona-conditioned LLMs. Relevant to our agent identity system:

- Proposes 6 evaluation dimensions for personas: toxicity, persona adherence, conversation quality, linguistic diversity, emotional intelligence, factual accuracy.
- Uses automated evaluation with GPT-4 as judge across 200 personas and 10K questions.
- **Takeaway for us:** Persona adherence (does the agent behave according to its SOUL.md?) is a measurable dimension. Their rubric approach maps directly to our LLM-as-judge design.

### 7.3 Hamel Husain's Eval Framework

Hamel Husain (former GitHub ML engineer) has published extensively on practical LLM evals. Key insights:

1. **Start with examples, not metrics.** Look at 50 real outputs before designing rubrics. Our task outputs in `agent_tasks.output` are the starting point.
2. **Domain experts > automated metrics.** For V1, have Taras (or the lead agent) manually score 20 outputs. Use these scores to calibrate the LLM judge.
3. **Evals are a product, not a project.** They need ongoing maintenance. Budget for rubric refinement.

### 7.4 AWS Agent Evaluation Patterns

Amazon published their internal patterns for evaluating agentic systems (2025). Key patterns:

- **Trajectory evaluation:** Score not just the final output but the sequence of actions (tool calls, retries, decisions). Maps to our session transcripts.
- **Grounded evaluation:** Compare agent outputs to known-correct reference answers. Maps to our assertion system.
- **Capability-specific eval:** Separate evals for separate capabilities. Maps to our per-agent suite design.

### 7.5 PromptFoo's Coding Agent Eval Guide

PromptFoo published a guide specifically for evaluating coding agents. Relevant patterns:

- **Deterministic checks first:** Before LLM judging, run regex/contains assertions. Cheap and reliable.
- **Composite scoring:** Combine deterministic assertions (binary pass/fail) with LLM-graded scores (0-3 rubrics) into a single composite score.
- **CI integration:** Run eval suite on every prompt/config change in CI pipeline.

### 7.6 Beyond Task Completion (arXiv 2512.12791)

Academic paper proposing an assessment framework for agentic AI that goes beyond simple task completion. Identifies dimensions: planning quality, adaptability, error recovery, resource efficiency, and collaboration effectiveness. Directly relevant to our Tier 2 and Tier 3 behavioral dimensions.

---

## 8. Cost and Effort Estimate

### V1: Minimal Viable Eval System

**Scope:** CLI command that runs a YAML-defined eval suite against current identity configs, scores with LLM-as-judge, outputs a report.

| Component | Effort | Notes |
|-----------|--------|-------|
| YAML eval case parser | 0.5 day | Schema definition + loader |
| Single-turn eval executor | 0.5 day | Reuse `getBasePrompt()` + Claude API |
| Assertion engine | 0.5 day | `contains`, `regex`, `llm-judge` types |
| LLM-as-judge scorer | 1 day | Prompt template, structured output parsing, multi-dimension |
| Report generator | 0.5 day | CLI output + markdown file |
| Eval results DB table | 0.5 day | Schema + CRUD |
| Initial eval suite (10-15 cases) | 1 day | Researcher + Lead + Picateclas scenarios |
| **Total V1** | **~4-5 days** | |

**Per-run cost:** ~$1-3 for a 15-case suite (Sonnet for agent, Sonnet/Opus for judge).

### V2: Full Session Evals + CI Integration

| Component | Effort | Notes |
|-----------|--------|-------|
| Full session executor | 2 days | Spawn Claude process, capture output, handle timeouts |
| CI/scheduled trigger | 1 day | Run evals on identity file changes |
| Historical comparison | 0.5 day | Compare current run to previous baseline |
| Memory integration | 0.5 day | Index eval results into agent memory |
| Dashboard/visualization | 1 day | Simple web view of eval history |
| **Total V2** | **~5 days** | Builds on V1 |

**Per-run cost:** ~$5-15 for session-mode evals (full Claude sessions are expensive).

### V3: Advanced Features (Future)

- Pairwise A/B comparison of identity configs
- Automatic identity optimization (hill-climbing on eval scores)
- Multi-agent coordination evals
- Regression alerting (eval scores drop -> Slack notification)

Estimated effort: 2-3 weeks. Should only be pursued after V1 proves useful.

---

## 9. Recommendations

### Immediate Next Steps

1. **Build V1 eval harness** (~1 week). The custom approach is the right call -- our TypeScript/Bun stack and existing infrastructure make it straightforward. Start with single-turn evals and LLM-as-judge scoring.

2. **Create initial eval suite** for Researcher agent first (it's the most well-defined role). 10-15 cases covering research quality, tool usage, and communication style.

3. **Baseline current performance.** Run the suite against current SOUL.md/IDENTITY.md. Store results. This is your comparison point for all future changes.

4. **Iterate on rubrics.** Have Taras manually score 10-15 real task outputs. Compare his scores to the LLM judge's scores. Adjust rubrics until agreement is >80%.

### Design Decisions to Make

| Decision | Options | Recommendation |
|----------|---------|----------------|
| Where to store eval definitions? | `evals/` in repo vs. DB | **Repo** -- version-controlled, reviewable in PRs |
| Which model for judging? | Haiku (cheap) vs. Sonnet (better) vs. Opus (best) | **Sonnet** -- best cost/quality balance for judging |
| Single-turn vs. session evals for V1? | Single-turn only vs. both | **Single-turn only** -- 10x cheaper, sufficient for identity eval |
| How to trigger evals? | Manual CLI vs. automatic on identity changes | **Manual CLI for V1** -- add automation in V2 |
| Eval results visibility? | CLI output only vs. DB + dashboard | **CLI + DB storage** -- enables historical comparison |

### What NOT to Build

- **Don't build a general-purpose eval framework.** We're evaluating identity config impact, not building PromptFoo. Keep scope tight.
- **Don't eval everything at once.** Start with one agent (Researcher), one eval type (single-turn), one scoring method (LLM-as-judge). Expand after proving value.
- **Don't try to automate identity optimization in V1.** The goal is measurement, not automation. Humans should still decide what identity changes to make.

---

## Appendix A: Example Eval Case for Lead Agent

```yaml
# evals/suites/lead.yaml
cases:
  - id: "task-routing"
    name: "Task routing accuracy"
    description: "Does the lead route tasks to the right worker?"
    task: |
      You have three workers available:
      - Researcher: Research & analysis specialist
      - Picateclas: Implementation specialist, writes production code
      - Reviewer: Code review specialist

      Route this incoming request: "I need someone to investigate why our
      scheduled tasks are sometimes firing twice on startup."

      Respond with: the worker you'd assign to, and a brief task description.
    scoring:
      - dimension: "routing_accuracy"
        rubric: |
          Score 0-3: Did the lead assign to the correct worker?
          The task is an investigation/research task -> should go to Researcher.
          0=wrong worker, 1=debatable choice, 2=reasonable choice, 3=optimal choice
      - dimension: "task_description_quality"
        rubric: |
          Score 0-3: Is the task description clear and actionable for the worker?
          0=vague/unhelpful, 1=basic, 2=clear, 3=detailed with context
```

## Appendix B: Relationship to Other Work

| Related Work | How Context Evals Connects |
|---|---|
| **PR #76: Agent Self-Improvement** | Evals measure whether self-improvement changes actually improve anything |
| **Context Versioning** (separate research task) | Version history enables "which version performed best?" analysis |
| **CDLC Analysis** (task e210caf9) | This research directly addresses the "Evaluate" gap identified there |
| **P5: Post-Task Reflection** (from PR #76 plan) | Reflection quality is an eval-able dimension |
| **P7: Memory-Informed Prompting** (from PR #76 plan) | Memory usage effectiveness can be eval'd in session-mode |

## Appendix C: Sources

### Eval Frameworks
- [PromptFoo](https://github.com/promptfoo/promptfoo) -- Open-source prompt testing & evaluation
- [PromptFoo: Evaluate Coding Agents](https://www.promptfoo.dev/docs/guides/evaluate-coding-agents/)
- [Inspect AI](https://inspect.aisi.org.uk/) -- UK AISI agent evaluation framework
- [DeepEval](https://github.com/confident-ai/deepeval) -- Open-source LLM evaluation
- [Braintrust](https://www.braintrust.dev/) -- Commercial LLM eval platform
- [Ragas](https://docs.ragas.io/) -- RAG evaluation framework

### LLM-as-Judge
- [Evidently AI: LLM-as-a-Judge Complete Guide](https://www.evidentlyai.com/llm-guide/llm-as-a-judge)
- [Monte Carlo: 7 Best Practices for LLM-as-Judge](https://www.montecarlodata.com/blog-llm-as-judge/)
- [Hamel Husain: Using LLM-as-a-Judge](https://hamel.dev/blog/posts/llm-judge/)
- [Confident AI: LLM-as-a-Judge Explained](https://www.confident-ai.com/blog/why-llm-as-a-judge-is-the-best-llm-evaluation-method)

### Agent Evaluation
- [AWS: Evaluating AI Agents at Amazon](https://aws.amazon.com/blogs/machine-learning/evaluating-ai-agents-real-world-lessons-from-building-agentic-systems-at-amazon/)
- [Beyond Task Completion: Assessment Framework for Agentic AI](https://arxiv.org/abs/2512.12791)
- [PersonaGym: Evaluating Persona Agents](https://arxiv.org/abs/2407.18416)
- [IntellAgent: Multi-Agent Evaluation Framework](https://medium.com/@nirdiamant21/intellagent-the-multi-agent-framework-to-evaluate-your-conversational-agents-69354273ac31)

### Context Engineering
- [Tessl: Context Development Lifecycle](https://tessl.io/blog/context-development-lifecycle-better-context-for-ai-coding-agents/)
- [Tessl: Proposed Evaluation Framework for Coding Agents](https://tessl.io/blog/proposed-evaluation-framework-for-coding-agents/)
- [Hamel Husain: Your AI Product Needs Evals](https://hamel.dev/blog/posts/evals/)
- [Pragmatic Engineer: Guide to LLM Evals](https://newsletter.pragmaticengineer.com/p/evals)

### Golden Datasets & Regression Testing
- [Statsig: Prompt Regression Testing](https://www.statsig.com/perspectives/slug-prompt-regression-testing)
- [Statsig: Golden Datasets Evaluation Standards](https://www.statsig.com/perspectives/golden-datasets-evaluation-standards)
- [Maxim AI: Building a Golden Dataset](https://www.getmaxim.ai/articles/building-a-golden-dataset-for-ai-evaluation-a-step-by-step-guide/)
