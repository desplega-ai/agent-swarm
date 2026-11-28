import { z } from "zod";

// Defaults measured on 2026-11-27. similarityMin, repeatMinCount and lookbackDays come
// from 1,977 person asks (Apr-Nov 2026) on one install, scored with askTokens/jaccard
// below and hand-labeled; the maturity pair comes from telemetry of 69 self-hosted
// installs. Derivations: the PR that added this script.
export const argsSchema = z.object({
  taskId: z.string().min(1).describe("The Lead task that holds the person's ask"),
  similarityMin: z
    .number()
    .min(0)
    .max(1)
    .default(0.35)
    .describe(
      "Word Jaccard at or above which two asks are the same kind of work. 0.35: 25% of sampled pairs below it were repeats, 7/10 at 0.35-0.4 and 10/10 at 0.6+",
    ),
  repeatMinCount: z
    .number()
    .int()
    .min(2)
    .default(3)
    .describe(
      "Asks (one per day, this one included) that make a pattern. 3: 6/8 sampled groups of 3 were recurring work, 4/8 of 2",
    ),
  lookbackDays: z
    .number()
    .int()
    .positive()
    .max(366)
    .default(166)
    .describe("Days of earlier asks to compare. 166: p90 span of 3 similar asks"),
  maturityMinWorkflows: z
    .number()
    .int()
    .min(0)
    .default(2)
    .describe(
      "User-made workflows that ran in the last 7 days for the install to count as mature. 2: the minimum among installs in the high-usage cluster",
    ),
  maturityMinRunsPerWeek: z
    .number()
    .int()
    .min(0)
    .default(133)
    .describe(
      "Runs of user-made workflows in the last 7 days for the install to count as mature. 133: lower edge of the high-usage cluster (next lower install: 43)",
    ),
});

/** Sources where a task is a person's ask (the same set as the checklist nudge). */
const PERSON_SOURCES = "('ui', 'slack', 'chat', 'comb')";
/** Asks with fewer content words were chat ("wdyt", "ping", "how you doing?") in the measured sample. */
const MIN_TOKENS = 3;
const PAGE_ROWS = 1000;
// shortcut: reads at most 5 pages (5,000 asks) of one requester's history, raise it when a requester outgrows that inside lookbackDays.
const MAX_PAGES = 5;
const LEDGER_NS = "workflow-suggest";

const STOPWORDS = new Set(
  "the and for you your are was were with that this these those from have has had not but can could would should will just also into onto about what when where which who why how all any our ours its it's they them their then than there here out get got make made like want need needs use using let lets let's plz pls please thanks thank yes yeah okay sure now new one more some very much really still too via per each every same other another tbh btw".split(
    " ",
  ),
);

/** Strip the scaffolding clients add around an ask, then return its content-word set. */
export function askTokens(text: string): Set<string> {
  const cleaned = text
    .replace(/<thread_context>[\s\S]*?<\/thread_context>/g, " ")
    // shortcut: everything after the first "---" line is UI or browser context the client appends; an ask that itself contains a "---" line loses its tail.
    .replace(/\n---\n[\s\S]*$/, " ")
    .replace(/^\s*\[Thread follow-up[^\]]*\]/, " ")
    .replace(/^\s*\[chat\][^\n]*\n/, " ")
    .replace(/\[User is viewing[^\]]*\]/g, " ")
    .replace(/\s*Note: a prod deploy started[^\n]*/g, " ")
    .replace(/\[File:[^\]]*\]/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .toLowerCase();
  return new Set(
    cleaned.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Page-feedback relays are generated text, not a typed ask; the thresholds were measured without them. */
function isGeneratedAsk(text: string): boolean {
  return text.startsWith('Feedback on the page "');
}

export type Ask = { id: string; createdAt: string; task: string };

export type Pattern = {
  id: string;
  count: number;
  firstAt: string;
  taskIds: string[];
  sample: string;
  /** Median days between the asks' days. */
  cadence: number;
};

/**
 * This ask plus the earlier asks similar to it, one per calendar day (UTC), so a retry
 * or a duplicate on the same day counts once. Null below `repeatMinCount` days.
 */
export function findPattern(
  current: Ask,
  history: readonly Ask[],
  similarityMin: number,
  repeatMinCount: number,
): Pattern | null {
  const tokens = askTokens(current.task);
  if (tokens.size < MIN_TOKENS) return null;
  const byDay = new Map<string, Ask>([[current.createdAt.slice(0, 10), current]]);
  for (const ask of history) {
    if (ask.id === current.id || isGeneratedAsk(ask.task)) continue;
    const other = askTokens(ask.task);
    if (other.size < MIN_TOKENS || jaccard(tokens, other) < similarityMin) continue;
    const day = ask.createdAt.slice(0, 10);
    const kept = byDay.get(day);
    if (!kept || ask.createdAt < kept.createdAt) byDay.set(day, ask);
  }
  if (byDay.size < repeatMinCount) return null;
  const group = [...byDay.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const days = group.map((ask) => Date.parse(ask.createdAt.slice(0, 10)) / 864e5);
  const gaps = days.slice(1).map((day, i) => day - (days[i] ?? day));
  const first = group[0] as Ask;
  return {
    id: first.id,
    count: group.length,
    firstAt: first.createdAt,
    taskIds: group.map((ask) => ask.id).reverse(),
    sample: cleanSample(current.task),
    cadence: median(gaps),
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function cleanSample(text: string): string {
  return text
    .replace(/<thread_context>[\s\S]*?<\/thread_context>/g, " ")
    .replace(/\n---\n[\s\S]*$/, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

type LedgerRecord = { key: string; value: Record<string, unknown> };

/** Any ledger record for this pattern, by group overlap or by a similar sample. */
export function isAlreadyOffered(
  records: readonly LedgerRecord[],
  current: Ask,
  pattern: Pattern | null,
  similarityMin: number,
): boolean {
  const tokens = askTokens(current.task);
  const ids = new Set(pattern?.taskIds ?? [current.id]);
  return records.some(({ key, value }) => {
    if (pattern && key.endsWith(`/p/${pattern.id}`)) return true;
    const taskIds = Array.isArray(value.taskIds) ? value.taskIds : [];
    if (taskIds.some((id) => ids.has(String(id)))) return true;
    return (
      typeof value.sample === "string" && jaccard(tokens, askTokens(value.sample)) >= similarityMin
    );
  });
}

const truthy = (value: unknown) => value === true || value === 1 || value === "1" || value === "true";

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Read-only signal for the `workflow-suggestion` skill: repeats, ledger, workflows, integrations, maturity. */
export default async function workflowSuggestScan(args: any, ctx: any) {
  const a = argsSchema.parse(args ?? {});
  const q = (sql: string, params: unknown[] = []) => ctx.db.query(sql, params) as Promise<any[]>;
  const now = Date.now();
  const errors: string[] = [];

  const [task] = await q(
    `SELECT id, "requestedByUserId", "contextKey", source, substr(task, 1, 4000) AS task, "createdAt"
       FROM agent_tasks WHERE id = $1`,
    [a.taskId],
  );
  if (!task) throw new Error(`TASK_NOT_FOUND: ${JSON.stringify({ taskId: a.taskId })}`);
  const requesterUserId: string | null = task.requestedByUserId ?? null;
  const threadRef: string = task.contextKey ?? task.id;
  const current: Ask = { id: task.id, createdAt: String(task.createdAt), task: String(task.task ?? "") };

  // Sequential reads: db_query caps concurrent queries per caller.
  const history: Ask[] = [];
  if (requesterUserId) {
    const since = new Date(now - a.lookbackDays * 864e5).toISOString();
    let cursor = new Date(now + 1000).toISOString();
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await q(
        `SELECT id, "createdAt", substr(task, 1, 4000) AS task FROM agent_tasks
          WHERE "requestedByUserId" = $1 AND "parentTaskId" IS NULL AND NOT "isHumanFree"
            AND source IN ${PERSON_SOURCES} AND "createdAt" >= $2 AND "createdAt" < $3
          ORDER BY "createdAt" DESC LIMIT ${PAGE_ROWS}`,
        [requesterUserId, since, cursor],
      );
      for (const row of rows) {
        history.push({ id: row.id, createdAt: String(row.createdAt), task: String(row.task ?? "") });
      }
      if (rows.length < PAGE_ROWS) break;
      cursor = String(rows[rows.length - 1].createdAt);
    }
  }
  const signalValid = history.some((ask) => ask.id !== current.id);
  const pattern =
    signalValid && !isGeneratedAsk(current.task)
      ? findPattern(current, history, a.similarityMin, a.repeatMinCount)
      : null;

  let records: LedgerRecord[] = [];
  let optedOut = false;
  if (requesterUserId) {
    const res: any = await ctx.swarm.kv_list({
      namespace: LEDGER_NS,
      prefix: `u/${requesterUserId}/`,
      limit: 1000,
    });
    if (res?.success === false) errors.push(`ledger: ${String(res?.data?.error ?? res?.message ?? "kv_list failed").slice(0, 200)}`);
    for (const entry of res?.data?.entries ?? res?.entries ?? []) {
      const value = parseJson(entry.value);
      if (entry.key === `u/${requesterUserId}/optout`) optedOut = true;
      else if (value && typeof value === "object") records.push({ key: entry.key, value: value as Record<string, unknown> });
    }
  }
  records = records.filter(({ key }) => key.includes("/p/"));
  const alreadyOffered = isAlreadyOffered(records, current, pattern, a.similarityMin);
  const pending = records.find(
    ({ value }) => value.state === "offered" && value.thread === threadRef,
  );

  const weekAgo = new Date(now - 7 * 864e5).toISOString();
  const [usage] = await q(
    `SELECT COUNT(DISTINCT r."workflowId") AS workflows, COUNT(*) AS runs
       FROM workflow_runs r JOIN workflows w ON w.id = r."workflowId"
      WHERE r."startedAt" >= $1
        AND NOT EXISTS (SELECT 1 FROM seed_state s WHERE s.kind = 'workflow' AND s.key = w.name)`,
    [weekAgo],
  );
  // shortcut: a seeded workflow the operator edited still counts as seeded, compare seed_state."seededHash" when that matters.
  const userWorkflows7d = Number(usage?.workflows ?? 0);
  const userRuns7d = Number(usage?.runs ?? 0);
  const mature = userWorkflows7d >= a.maturityMinWorkflows && userRuns7d >= a.maturityMinRunsPerWeek;

  const tokens = askTokens(current.task);
  const all = await q(
    `SELECT w.id, w.name, w.description, w.enabled, w.triggers, w.requires,
            (SELECT COUNT(*) FROM seed_state s WHERE s.kind = 'workflow' AND s.key = w.name) AS seeded
       FROM workflows w LIMIT 1000`,
  );
  const ranked = all
    .map((w) => {
      const own = askTokens(`${String(w.name).replace(/[-_]/g, " ")} ${w.description ?? ""}`);
      let shared = 0;
      for (const word of own) if (tokens.has(word)) shared++;
      return { w, fit: own.size ? shared / own.size : 0 };
    })
    .filter(({ fit }) => fit > 0)
    .sort((x, y) => y.fit - x.fit)
    .slice(0, 5);
  const workflows = [];
  for (const { w, fit } of ranked) {
    // SQLite binds an array to `$N` placeholders in order of first appearance, not by N,
    // so `$1` must be the first placeholder in the text for both engines to agree.
    const [runs] = await q(
      `SELECT (SELECT r2.status FROM workflow_runs r2 WHERE r2."workflowId" = $1 ORDER BY r2."startedAt" DESC LIMIT 1) AS "lastStatus",
              (SELECT COUNT(*) FROM scheduled_tasks st WHERE st."targetType" = 'workflow' AND st."workflowId" = $1) AS schedules,
              COUNT(*) AS total,
              SUM(CASE WHEN "startedAt" >= $2 THEN 1 ELSE 0 END) AS week
         FROM workflow_runs WHERE "workflowId" = $1`,
      [w.id, weekAgo],
    );
    const triggers = parseJson(w.triggers);
    const requires = parseJson(w.requires);
    workflows.push({
      id: w.id,
      name: w.name,
      description: w.description ?? null,
      fit: Math.round(fit * 100) / 100,
      enabled: truthy(w.enabled),
      seeded: Number(w.seeded) > 0,
      triggers: Array.isArray(triggers) ? triggers.length : 0,
      schedules: Number(runs?.schedules ?? 0),
      runsTotal: Number(runs?.total ?? 0),
      runs7d: Number(runs?.week ?? 0),
      lastRunStatus: runs?.lastStatus ?? null,
      requires: Array.isArray(requires) ? requires : [],
    });
  }
  const best = workflows[0];
  const diagnosis = !best
    ? { kind: "never-created", workflowIds: [] as string[] }
    : {
        kind:
          best.runsTotal === 0
            ? "created-never-triggered"
            : best.lastRunStatus === "failed"
              ? "runs-failed"
              : "healthy",
        workflowIds: [best.id],
      };

  let integrations: unknown = null;
  try {
    const res: any = await ctx.swarm.integration_status({});
    const data = res?.data ?? res;
    integrations = { ...(data?.integrations ?? {}), connections: data?.connections ?? [] };
  } catch (err) {
    errors.push(`integrations: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
  }

  return {
    signalValid,
    historyCount: history.filter((ask) => ask.id !== current.id).length,
    requesterUserId,
    threadRef,
    optedOut,
    mature,
    maturity: { userWorkflows7d, userRuns7d },
    pattern,
    alreadyOffered,
    pendingOffer: pending ? { key: pending.key, ...pending.value } : null,
    workflowCount: workflows.length,
    workflows,
    diagnosis,
    integrations,
    thresholds: {
      similarityMin: a.similarityMin,
      repeatMinCount: a.repeatMinCount,
      lookbackDays: a.lookbackDays,
      maturityMinWorkflows: a.maturityMinWorkflows,
      maturityMinRunsPerWeek: a.maturityMinRunsPerWeek,
    },
    errors,
  };
}
