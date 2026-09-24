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
});
export const TaskCitationSchema = CitationInputSchema.extend({
  label: z.string().nullable().optional(),
  quote: z.string().nullable().optional(),
  resolvedUrl: z.string().nullable(),
  verified: z.enum(["true", "false", "unchecked"]),
});
type CitationInput = z.infer<typeof CitationInputSchema>;

export function buildCitationUrl(citation: CitationInput): string | null {
  try {
    const { kind, ref } = citation;
    if (kind === "url") return citationHttpUrl(ref);
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
    if (kind === "github") {
      const match = ref.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
      return match ? `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}` : null;
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
      (task_id, citation_index, kind, ref, label, quote, resolved_url, verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, citation_index) DO UPDATE SET
        kind=excluded.kind, ref=excluded.ref, label=excluded.label, quote=excluded.quote,
        resolved_url=excluded.resolved_url, verified=excluded.verified,
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
      ],
    );
  }
}

export async function getTaskCitations(taskId: string): Promise<TaskCitation[]> {
  return getDbClient().query<TaskCitation>(
    `SELECT citation_index AS "index", kind, ref, label, quote,
    resolved_url AS resolvedUrl, verified FROM task_citations WHERE task_id = ? ORDER BY citation_index`,
    [taskId],
  );
}
