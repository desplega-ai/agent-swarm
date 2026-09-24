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

export function renderTaskCitations(
  text: string,
  citations: readonly TaskCitation[],
  format: "slack" | "markdown" = "slack",
  appendSources = true,
): string {
  const marker = (index: number) => {
    const citation = citations.find((entry) => entry.index === index);
    const url =
      citation?.verified !== "false" && citation?.resolvedUrl
        ? citationHttpUrl(citation.resolvedUrl)
        : null;
    if (!url) return `[${index}]`;
    const destination = url.replace(/[<>|()\\]/g, encodeURIComponent);
    return format === "slack" ? `<${destination}|[${index}]>` : `[[${index}]](${destination})`;
  };
  const body = text.replace(/\[citation:(\d+)\]/g, (_, index) => marker(Number(index)));
  if (!appendSources || !citations.length) return body;
  const sources = [...citations]
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
      .map((index) => `WARNING: [citation:${index}] has no citation entry.`),
    ...citations
      .filter((entry) => !used.has(entry.index))
      .map((entry) => `WARNING: citation ${entry.index} is not referenced in output.`),
  ];
}
