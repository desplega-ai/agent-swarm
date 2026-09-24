import * as z from "zod";
import type { TaskAttachment } from "../types";
import { getAppUrl } from "../utils/constants";
import { taskAttachmentDisplayUrl } from "../utils/task-attachment-links";
import { citationHttpUrl, type TaskCitation } from "../utils/task-citations";
import { getDbClient } from "./db";

export const MAX_TASK_CITATIONS = 50;

export const CitationInputSchema = z.object({
  index: z.number().int().min(1),
  kind: z.enum(["task", "memory", "github", "slack", "agent-fs", "page", "script-run", "url"]),
  ref: z.string().max(2048),
  label: z.string().max(200).optional(),
  quote: z.string().max(300).optional(),
  general: z.boolean().optional(),
});
export const TaskCitationSchema = CitationInputSchema.extend({
  label: z.string().nullable().optional(),
  quote: z.string().nullable().optional(),
  resolvedUrl: z.string().nullable(),
  verified: z.enum(["true", "false", "unchecked"]),
});
type CitationInput = z.infer<typeof CitationInputSchema>;

/** Canonical github.com URL for `owner/repo#N`, `owner/repo@sha`, or a pull/issues/commit URL. */
export function githubCitationUrl(ref: string): string | null {
  const repo = "([\\w.-]+)\\/([\\w.-]+)";
  const short = ref.trim().match(new RegExp(`^${repo}(?:#(\\d+)|@([0-9a-f]{7,40}))$`, "i"));
  if (short) {
    return short[3]
      ? `https://github.com/${short[1]}/${short[2]}/issues/${short[3]}`
      : `https://github.com/${short[1]}/${short[2]}/commit/${short[4]!.toLowerCase()}`;
  }
  const full = ref
    .trim()
    .match(
      new RegExp(
        `^https?:\\/\\/(?:www\\.)?github\\.com\\/${repo}\\/(?:(pull|issues)\\/(\\d+)|commit\\/([0-9a-f]{7,40}))(?:[/?#].*)?$`,
        "i",
      ),
    );
  if (!full) return null;
  return full[3]
    ? `https://github.com/${full[1]}/${full[2]}/${full[3].toLowerCase()}/${full[4]}`
    : `https://github.com/${full[1]}/${full[2]}/commit/${full[5]!.toLowerCase()}`;
}

export function buildCitationUrl(citation: CitationInput): string | null {
  try {
    const { kind, ref } = citation;
    if (kind === "url") return citationHttpUrl(ref);
    if (kind === "github") return githubCitationUrl(ref);
    // Typed refs are identifiers, never arbitrary URLs.
    if (!ref.trim() || /:\/\//.test(ref)) return null;
    if (kind === "task") return citationHttpUrl(`${getAppUrl()}/tasks/${encodeURIComponent(ref)}`);
    if (kind === "page" || kind === "agent-fs") {
      return citationHttpUrl(
        taskAttachmentDisplayUrl({
          kind,
          pageId: kind === "page" ? encodeURIComponent(ref) : undefined,
          path: kind === "agent-fs" ? ref : undefined,
        } as TaskAttachment),
      );
    }
    // Memory/run routes and Slack workspace permalinks have no canonical builder here.
    return null;
  } catch {
    // Malformed refs (including invalid Unicode) must never block task completion.
    return null;
  }
}

export function memoryQuoteMatches(body: string, quote: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  return normalize(body).includes(normalize(quote));
}

export async function upsertTaskCitations(
  taskId: string,
  citations: CitationInput[],
): Promise<void> {
  const db = getDbClient();
  const indices = new Set((await getTaskCitations(taskId)).map((entry) => entry.index));
  for (const citation of citations.slice(0, MAX_TASK_CITATIONS)) {
    if (!CitationInputSchema.safeParse(citation).success) continue;
    if (!indices.has(citation.index) && indices.size >= MAX_TASK_CITATIONS) continue;
    indices.add(citation.index);
    let verified: TaskCitation["verified"] = "unchecked";
    const tables = {
      task: "agent_tasks",
      memory: "agent_memory",
      page: "pages",
      "script-run": "script_runs",
    };
    if (citation.kind in tables) {
      const table = tables[citation.kind as keyof typeof tables];
      try {
        const row = await db.get<{ content?: string }>(
          `SELECT ${citation.kind === "memory" ? "content" : "id"} FROM ${table} WHERE id = ?`,
          [citation.ref],
        );
        verified =
          row &&
          (citation.kind !== "memory" ||
            citation.quote === undefined ||
            memoryQuoteMatches(row.content ?? "", citation.quote))
            ? "true"
            : "false";
      } catch {
        // Verification is advisory; transient lookup errors must not block completion.
        verified = "unchecked";
      }
    }
    await db.run(
      `INSERT INTO task_citations
      (task_id, citation_index, kind, ref, label, quote, resolved_url, verified, general)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, citation_index) DO UPDATE SET
        kind=excluded.kind, ref=excluded.ref, label=excluded.label, quote=excluded.quote,
        resolved_url=excluded.resolved_url, verified=excluded.verified, general=excluded.general,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      [
        taskId,
        citation.index,
        citation.kind,
        citation.ref,
        citation.label ?? null,
        citation.quote ?? null,
        buildCitationUrl(citation),
        verified,
        citation.general ? 1 : 0,
      ],
    );
  }
}

export async function getTaskCitations(taskId: string): Promise<TaskCitation[]> {
  const rows = await getDbClient().query<Omit<TaskCitation, "general"> & { general: number }>(
    `SELECT citation_index AS "index", kind, ref, label, quote,
    resolved_url AS resolvedUrl, verified, general FROM task_citations
    WHERE task_id = ? ORDER BY citation_index`,
    [taskId],
  );
  return rows.map((row) => ({ ...row, general: row.general === 1 }));
}

/**
 * The completion citation check refuses at most once per task. The refusal
 * is an `agent_log` row, so it also shows in the task's activity timeline.
 */
export async function hasTaskCitationCheckRefusal(taskId: string): Promise<boolean> {
  return Boolean(
    await getDbClient().get<{ id: string }>(
      "SELECT id FROM agent_log WHERE taskId = ? AND eventType = 'task_citation_check_refused' LIMIT 1",
      [taskId],
    ),
  );
}
