/**
 * Built-in global scripts catalog — the one concrete {@link Seeder} wired into
 * the generic seeder framework (see `src/be/seed`).
 *
 * Each entry's runtime source is a real `.ts` file under `./catalog/`, imported
 * here as text so it ships embedded in the compiled binary. {@link scriptsSeeder}
 * mirrors the `/api/scripts/upsert` pipeline (import allowlist -> typecheck ->
 * signature + argsSchema extraction -> upsert at `global` scope). The framework
 * harness makes re-seeding version-aware: a pristine script updates when its
 * catalog source changes, a user-modified one is preserved.
 *
 * To add a script: drop a `<name>.ts` file in `./catalog/`, text-import it below,
 * and add a manifest entry to {@link SEED_SCRIPTS}. The `description` + `intent`
 * power `script-search` ranking — write them with the keywords an agent would
 * actually search for.
 */

import { extractScriptSignature } from "../../scripts-runtime/extract-signature";
import { validateScriptImports } from "../../scripts-runtime/import-allowlist";
import { computeContentHash } from "../db";
import { getScript, upsertScriptByName } from "../scripts/db";
import { extractArgsJsonSchema } from "../scripts/extract-schema";
import { typecheckScript } from "../scripts/typecheck";
import type { Seeder, SeederRunOptions, SeedItem } from "../seed/types";
import bootTriageSrc from "./catalog/boot-triage.inline.ts" with { type: "text" };
// @ts-expect-error Bun text imports synthesize a default string for this helper.
import catalogReportSrc from "./catalog/catalog-report.inline.ts" with { type: "text" };
import compoundInsightsSrc from "./catalog/compound-insights.inline.ts" with { type: "text" };
import dateResolveSrc from "./catalog/date-resolve.ts" with { type: "text" };
import fetchReadableSrc from "./catalog/fetch-readable.ts" with { type: "text" };
import ghPrSnapshotSrc from "./catalog/gh-pr-snapshot.ts" with { type: "text" };
import groupCountSrc from "./catalog/group-count.ts" with { type: "text" };
import jsonQuerySrc from "./catalog/json-query.ts" with { type: "text" };
import linearIssueSrc from "./catalog/linear-issue.ts" with { type: "text" };
import memoryDedupCheckSrc from "./catalog/memory-dedup-check.ts" with { type: "text" };
import memoryEvalSrc from "./catalog/memory-eval.ts" with { type: "text" };
import opsCatalogAuditSrc from "./catalog/ops-catalog-audit.inline.ts" with { type: "text" };
import scheduleHealthSrc from "./catalog/schedule-health.ts" with { type: "text" };
import slackThreadFlattenSrc from "./catalog/slack-thread-flatten.ts" with { type: "text" };
import smartRecallSrc from "./catalog/smart-recall.ts" with { type: "text" };
import taskContextGatheringSrc from "./catalog/task-context-gathering.ts" with { type: "text" };
import taskFailureAuditSrc from "./catalog/task-failure-audit.ts" with { type: "text" };
import textDiffSrc from "./catalog/text-diff.ts" with { type: "text" };
import toolUsageSrc from "./catalog/tool-usage.ts" with { type: "text" };

export type SeedScript = {
  name: string;
  description: string;
  intent: string;
  source: string;
};

// Text imports resolve to a string at runtime; TypeScript types them as the
// module's default export, so the cast restores the real shape.
const asText = (s: unknown): string => s as string;

const CATALOG_REPORT_IMPORT_RE = /^import\s+\{[^}]*\}\s+from "\.\/catalog-report";\n\n?/m;

function bundleCatalogReport(source: string): string {
  const helper = asText(catalogReportSrc);
  if (!CATALOG_REPORT_IMPORT_RE.test(source)) return source;
  return `${helper}\n\n${source.replace(CATALOG_REPORT_IMPORT_RE, "")}`;
}

export const SEED_SCRIPTS: SeedScript[] = [
  {
    name: "gh-pr-snapshot",
    description:
      "One-call GitHub pull request snapshot: title, state, draft, mergeable, CI check tallies (passed/failed/pending) and review tallies (approved/changes-requested/pending).",
    intent:
      "Triage a GitHub PR's status in a single call instead of running several gh pr view / gh pr checks / gh api invocations.",
    source: asText(ghPrSnapshotSrc),
  },
  {
    name: "fetch-readable",
    description:
      "Fetch a web page and extract clean readable article text — strips scripts, styles, nav, headers, footers, ads and HTML tags, and decodes entities.",
    intent:
      "Read the actual content of a URL without wading through raw HTML; readable-article / reader-mode extraction.",
    source: asText(fetchReadableSrc),
  },
  {
    name: "json-query",
    description:
      "Run a jq-style path/filter query over any JSON value: dot fields, [n] indexing, [] iteration, | pipes, and keys/values/length/type functions.",
    intent: "Extract a value from a JSON blob without shelling out to a curl | jq pipeline.",
    source: asText(jsonQuerySrc),
  },
  {
    name: "group-count",
    description:
      "Group an array of objects by a field (dotted paths supported), returning per-group counts sorted by frequency plus an optional numeric sum.",
    intent:
      "Aggregate or tally records — counts and sums by category — without writing ad-hoc reduce code.",
    source: asText(groupCountSrc),
  },
  {
    name: "date-resolve",
    description:
      "Resolve a natural-language date expression (yesterday, last week, Thursday, 7d ago, an ISO date) into an ISO timestamp or a {start,end} range.",
    intent:
      "Turn fuzzy human date phrases into concrete timestamps for filtering, querying or scheduling.",
    source: asText(dateResolveSrc),
  },
  {
    name: "text-diff",
    description:
      "Compare two strings line-by-line with an LCS diff and return a unified-diff summary plus added/removed/unchanged counts.",
    intent: "See exactly what changed between two versions of a text, config or document.",
    source: asText(textDiffSrc),
  },
  {
    name: "task-failure-audit",
    description:
      "Scan recently failed swarm tasks and cluster them by failure reason, agent or schedule to surface recurring problems.",
    intent:
      "Find patterns in swarm task failures — which agent, schedule or error keeps breaking — for a reliability review.",
    source: bundleCatalogReport(asText(taskFailureAuditSrc)),
  },
  {
    name: "memory-dedup-check",
    description:
      "Semantic-search existing swarm memories for near-duplicates of a candidate text and report matches above a similarity threshold.",
    intent:
      "Avoid writing a redundant memory — check whether something equivalent is already stored before saving.",
    source: asText(memoryDedupCheckSrc),
  },
  {
    name: "linear-issue",
    description:
      "Fetch a Linear issue by its identifier (e.g. DES-123): title, status, priority, assignee and comments.",
    intent:
      "Pull Linear ticket context into a task without leaving the swarm or opening a browser.",
    source: asText(linearIssueSrc),
  },
  {
    name: "slack-thread-flatten",
    description:
      "Fetch a Slack thread by channel + thread timestamp and flatten it into a readable chronological transcript.",
    intent: "Turn a Slack thread into plain text for summarizing or as task context.",
    source: asText(slackThreadFlattenSrc),
  },
  {
    name: "smart-recall",
    description:
      "Multi-query fan-out memory search with dedup and composite reranking (bestSimilarity + 0.05 * hitCount). Returns unique memories across all queries.",
    intent:
      "Recall relevant memories using multiple search angles — better coverage than a single query. Use for task onboarding, context gathering, or before writing new memories.",
    source: asText(smartRecallSrc),
  },
  {
    name: "task-context-gathering",
    description:
      "Get task details and recall relevant memories in one call — returns a slimmed task projection plus deduped and reranked memories from multi-query fan-out.",
    intent:
      "Task onboarding: one call instead of task_get plus multiple memory_search calls. Pass the task description split into 2-4 natural-language queries.",
    source: asText(taskContextGatheringSrc),
  },
  {
    name: "schedule-health",
    description:
      "Per-schedule failure rate check over recent tasks — flags schedules with failure rates above a configurable threshold.",
    intent:
      "Find unhealthy schedules that keep failing — for daily compounding, reliability reviews, or ops triage.",
    source: bundleCatalogReport(asText(scheduleHealthSrc)),
  },
  {
    name: "tool-usage",
    description:
      "Tool usage histogram from session_logs — top tools by call count over a time window, optionally filtered by agent.",
    intent:
      "See which MCP tools agents use most — for SDK gap analysis, optimization, or daily ops snapshots.",
    source: asText(toolUsageSrc),
  },
  {
    name: "compound-insights",
    description:
      "All-in-one swarm-wide daily ops snapshot: task completion/failure summary, real failure clusters (excludes superseded/cancelled bookkeeping), schedule health flags, tool usage top-25, memory health/pollution stats, seed-script candidate tool triplets, and a per-agent breakdown. Aggregates across ALL agents via direct read-only SQL.",
    intent:
      "Single-call daily compounding Phase 0 helper — replaces ~25 raw tool roundtrips with one compressed JSON result covering every agent. For daily evolution, self-scripting candidates, ops reviews, or heartbeat context.",
    source: bundleCatalogReport(asText(compoundInsightsSrc)),
  },
  {
    name: "memory-eval",
    description:
      "3-axis memory quality evaluation: carry-forward context (do follow-up tasks retrieve useful memories from prior tasks?), follow preferences (are CLAUDE.md/IDENTITY.md/SOUL.md/TOOLS.md memories retrieved and useful?), and stay current (what fraction of retrieved memories are fresh vs stale?). Outputs a baseline report to a swarm Page and the return value.",
    intent:
      "Measure memory system health across OpenAI Dreaming-inspired axes — before/after baseline for architecture changes, blog-post numbers, daily quality monitoring.",
    source: asText(memoryEvalSrc),
  },
  {
    name: "ops-catalog-audit",
    description:
      "Audit-as-code catalog check for schedules, workflows, and prompt/template drift. Clusters actionable findings by goal and can publish an authed HTML report page.",
    intent:
      "Re-run the ops inventory audit in one call: duplicate/dead schedules, code-work routing risks, enabled workflow fixtures, structured-output gate gaps, prompt registry drift, stale hosts, and systemDefault skill duplicates.",
    source: bundleCatalogReport(asText(opsCatalogAuditSrc)),
  },
  {
    name: "boot-triage",
    description:
      "Post-restart heartbeat triage snapshot: deploy restart PR context, recent real failures, stuck offline-agent work, orphaned tasks, and superseded tasks missing resume children.",
    intent:
      "Run immediately after a swarm restart to gather deterministic boot triage data in one read-only call before the Lead decides what to retry, cancel, or escalate.",
    source: asText(bootTriageSrc),
  },
];

/** A catalog entry resolved into a generic {@link SeedItem}. */
type ScriptSeedItem = SeedItem & { script: SeedScript };

/**
 * The one concrete {@link Seeder} wired up today: lands the built-in scripts
 * catalog at `global` scope.
 *
 * `key` is the script name. `contentHash` is the same SHA-256 of the source
 * that the `scripts` table stores in its `contentHash` column, so a pristine
 * upstream row hashes identically to its catalog source — letting the harness
 * detect "pristine vs user-modified" without any script-specific logic.
 */
export const scriptsSeeder: Seeder<ScriptSeedItem> = {
  kind: "script",

  items(): ScriptSeedItem[] {
    return SEED_SCRIPTS.map((script) => ({
      key: script.name,
      contentHash: computeContentHash(script.source),
      script,
    }));
  },

  upstreamHash(item): string | null {
    const existing = getScript({ name: item.key, scope: "global" });
    return existing ? existing.contentHash : null;
  },

  async apply(item, _action, opts?: SeederRunOptions): Promise<void> {
    const { script } = item;

    const imports = validateScriptImports(script.source);
    if (!imports.ok) throw new Error(`import check: ${imports.diagnostic}`);

    const typecheck = typecheckScript(script.source);
    if (!typecheck.ok) throw new Error(`typecheck: ${typecheck.diagnostics.join(" | ")}`);

    // upsertScriptByName handles both create and update (and bumps the
    // script_versions history), so a single path serves either action.
    const argsJsonSchema = await extractArgsJsonSchema(script.source);
    await upsertScriptByName({
      name: script.name,
      scope: "global",
      scopeId: null,
      source: script.source,
      description: script.description,
      intent: script.intent,
      signatureJson: JSON.stringify(extractScriptSignature(script.source)),
      argsJsonSchema,
      fsMode: "none",
      agentId: null,
      isScratch: false,
      typeChecked: true,
      changeReason: "Seeded from the built-in scripts catalog (src/be/seed-scripts)",
      embeddingMode: opts?.scriptEmbeddingMode ?? "sync",
    });
  },
};
