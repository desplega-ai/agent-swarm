/**
 * Built-in global scripts catalog — seeded into the `scripts` table at API boot.
 *
 * Each entry's runtime source is a real `.ts` file under `./catalog/`, imported
 * here as text so it ships embedded in the compiled binary. The seed mirrors the
 * `/api/scripts/upsert` pipeline (import allowlist -> typecheck -> signature +
 * argsSchema extraction -> upsert) and is idempotent: scripts whose content hash
 * is unchanged are skipped, so steady-state boots do no extra work.
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
import dateResolveSrc from "./catalog/date-resolve.ts" with { type: "text" };
import fetchReadableSrc from "./catalog/fetch-readable.ts" with { type: "text" };
import ghPrSnapshotSrc from "./catalog/gh-pr-snapshot.ts" with { type: "text" };
import groupCountSrc from "./catalog/group-count.ts" with { type: "text" };
import jsonQuerySrc from "./catalog/json-query.ts" with { type: "text" };
import linearIssueSrc from "./catalog/linear-issue.ts" with { type: "text" };
import memoryDedupCheckSrc from "./catalog/memory-dedup-check.ts" with { type: "text" };
import slackThreadFlattenSrc from "./catalog/slack-thread-flatten.ts" with { type: "text" };
import taskFailureAuditSrc from "./catalog/task-failure-audit.ts" with { type: "text" };
import textDiffSrc from "./catalog/text-diff.ts" with { type: "text" };

export type SeedScript = {
  name: string;
  description: string;
  intent: string;
  source: string;
};

// Text imports resolve to a string at runtime; TypeScript types them as the
// module's default export, so the cast restores the real shape.
const asText = (s: unknown): string => s as string;

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
    source: asText(taskFailureAuditSrc),
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
];

export type SeedScriptsResult = {
  seeded: number;
  updated: number;
  skipped: number;
  failed: Array<{ name: string; error: string }>;
};

/**
 * Seed the built-in scripts into the catalog at `global` scope. Idempotent and
 * safe to call on every boot — unchanged scripts are skipped before the
 * (relatively expensive) typecheck + schema-extraction pipeline runs.
 */
export async function seedGlobalScripts(opts?: { quiet?: boolean }): Promise<SeedScriptsResult> {
  const result: SeedScriptsResult = { seeded: 0, updated: 0, skipped: 0, failed: [] };

  for (const script of SEED_SCRIPTS) {
    try {
      const existing = getScript({ name: script.name, scope: "global" });
      if (existing && existing.contentHash === computeContentHash(script.source)) {
        result.skipped += 1;
        continue;
      }

      const imports = validateScriptImports(script.source);
      if (!imports.ok) {
        result.failed.push({ name: script.name, error: `import check: ${imports.diagnostic}` });
        continue;
      }

      const typecheck = typecheckScript(script.source);
      if (!typecheck.ok) {
        result.failed.push({
          name: script.name,
          error: `typecheck: ${typecheck.diagnostics.join(" | ")}`,
        });
        continue;
      }

      const argsJsonSchema = await extractArgsJsonSchema(script.source);
      const upserted = await upsertScriptByName({
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
      });

      if (upserted.isNew) result.seeded += 1;
      else result.updated += 1;
    } catch (err) {
      result.failed.push({
        name: script.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!opts?.quiet) {
    console.log(
      `[seed-scripts] seeded=${result.seeded} updated=${result.updated} ` +
        `skipped=${result.skipped} failed=${result.failed.length}`,
    );
    for (const f of result.failed) {
      console.error(`[seed-scripts] FAILED ${f.name}: ${f.error}`);
    }
  }

  return result;
}
