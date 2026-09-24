/** Browser-safe citation presentation shared by Slack and the dashboard. */
export interface TaskCitation {
  index: number;
  kind: "task" | "memory" | "github" | "slack" | "agent-fs" | "page" | "script-run" | "url";
  ref: string;
  label?: string | null;
  quote?: string | null;
  resolvedUrl: string | null;
  verified: "true" | "false" | "unchecked";
}

export function citationHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function isRenderableCitation(citation: TaskCitation): boolean {
  return (
    citation.verified !== "false" &&
    (citation.resolvedUrl === null
      ? ["memory", "script-run", "slack"].includes(citation.kind)
      : citationHttpUrl(citation.resolvedUrl) !== null)
  );
}

export function stripInvalidTaskCitations(
  text: string,
  citations: readonly TaskCitation[],
): string {
  const valid = citations.filter(isRenderableCitation);
  // Remove runs of invalid markers together, cleaning only the adjacent whitespace.
  // Preserve line breaks, indentation elsewhere, and spacing around valid citations.
  return text.replace(
    /[ \t]*\[citation:\d+\](?:[ \t]*\[citation:\d+\])*[ \t]*/g,
    (run, offset: number) => {
      const rendered = run.replace(/\[citation:(\d+)\]/g, (match: string, index: string) =>
        valid.some((entry) => entry.index === Number(index)) ? match : "",
      );
      if (rendered === run) return run;
      const cleaned = rendered.replace(/[ \t]+/g, " ");
      const before = text[offset - 1];
      const after = text[offset + run.length];
      return cleaned
        .replace(/^[ \t]+/, before && before !== "\n" ? " " : "")
        .replace(/[ \t]+$/, after && !/[\n.,;:!?)}\]]/.test(after) ? " " : "");
    },
  );
}

export function renderTaskCitations(
  text: string,
  citations: readonly TaskCitation[],
  format: "slack" | "markdown" = "slack",
  appendSources = true,
): string {
  const valid = citations.filter(isRenderableCitation);
  const marker = (index: number) => {
    const citation = valid.find((entry) => entry.index === index);
    if (!citation) return "";
    const url = citation.resolvedUrl ? citationHttpUrl(citation.resolvedUrl) : null;
    if (!url) return `[${index}]`;
    const destination = url.replace(/[<>|()\\]/g, encodeURIComponent);
    return format === "slack" ? `<${destination}|[${index}]>` : `[[${index}]](${destination})`;
  };
  const stripped = stripInvalidTaskCitations(text, valid);
  const body = stripped.replace(/\[citation:(\d+)\]/g, (_, index) => marker(Number(index)));
  if (!appendSources || !valid.length) return body;
  const sources = [...valid]
    .sort((a, b) => a.index - b.index)
    .map((citation) => {
      const label = (citation.label || citation.kind).replace(/\s+/g, " ").trim();
      const escaped =
        format === "slack"
          ? label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          : label.replace(/[\\`*_{}[\]()<>!#|]/g, "\\$&");
      return `${marker(citation.index)} ${escaped}`;
    });
  return `${body}\n\nSources: ${sources.join(" · ")}`;
}

export function taskCitationWarnings(text: string, citations: readonly TaskCitation[]): string[] {
  const used = new Set([...text.matchAll(/\[citation:(\d+)\]/g)].map((match) => Number(match[1])));
  return [
    ...[...used]
      .filter((index) => !citations.some((entry) => entry.index === index))
      .map(
        (index) =>
          `WARNING: [citation:${index}] has no citation entry; its marker is removed from rendered output.`,
      ),
    ...citations
      .filter((entry) => !isRenderableCitation(entry))
      .map(
        (entry) =>
          `WARNING: citation ${entry.index} failed validation; its marker and source are removed from rendered output.`,
      ),
    ...citations
      .filter((entry) => !used.has(entry.index))
      .map((entry) => `WARNING: citation ${entry.index} is not referenced in output.`),
  ];
}
