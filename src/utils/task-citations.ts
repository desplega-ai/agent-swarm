/** Browser-safe citation presentation shared by Slack and the dashboard. */
export interface TaskCitation {
  index: number;
  kind: "task" | "memory" | "github" | "slack" | "agent-fs" | "page" | "script-run" | "url";
  ref: string;
  label?: string | null;
  quote?: string | null;
  resolvedUrl: string | null;
  verified: "true" | "false" | "unchecked";
  /** Backs the whole answer rather than one claim; may stay unreferenced in the text. */
  general?: boolean;
}

const CITATION_MARKER = /\[citation:(\d+)\]/g;

/** Indices referenced by `[citation:N]` markers in `text`. */
export function citedIndices(text: string): Set<number> {
  return new Set([...text.matchAll(CITATION_MARKER)].map((match) => Number(match[1])));
}

export function citationHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

const EXPECTED_REF: Record<TaskCitation["kind"], string> = {
  task: "a task UUID",
  memory: "a memory UUID",
  github: "owner/repo#N, owner/repo@<sha>, or a github.com pull, issues, or commit URL",
  slack: "a Slack permalink or channel/ts",
  "agent-fs": "an agent-fs file path",
  page: "a page id",
  "script-run": "a script run id",
  url: "an http(s) URL",
};

/**
 * Why a citation is dropped from rendered output, or null when it renders.
 * The dashboard shows this reason next to dropped citations.
 */
export function citationDropReason(citation: TaskCitation): string | null {
  if (citation.verified === "false") {
    return citation.kind === "memory" && citation.quote
      ? "memory not found, or the quote does not appear in it"
      : `${citation.kind} "${citation.ref}" was not found`;
  }
  if (citation.resolvedUrl === null) {
    return ["memory", "script-run", "slack"].includes(citation.kind)
      ? null
      : `ref does not resolve to a link; expected ${EXPECTED_REF[citation.kind]}`;
  }
  return citationHttpUrl(citation.resolvedUrl) === null ? "resolved URL is not http(s)" : null;
}

function isRenderableCitation(citation: TaskCitation): boolean {
  return citationDropReason(citation) === null;
}

export interface TaskCitationIssues {
  /** `[citation:N]` markers with no citation entry. */
  missingEntries: number[];
  /** Citations dropped from rendered output. */
  invalid: { index: number; reason: string }[];
  /** Renderable, non-general citations that no marker references. */
  unreferenced: number[];
}

export function taskCitationIssues(
  text: string,
  citations: readonly TaskCitation[],
): TaskCitationIssues {
  const used = citedIndices(text);
  const invalid = citations.flatMap((entry) => {
    const reason = citationDropReason(entry);
    return reason ? [{ index: entry.index, reason }] : [];
  });
  return {
    missingEntries: [...used].filter((index) => !citations.some((entry) => entry.index === index)),
    invalid,
    unreferenced: citations
      .filter(
        (entry) =>
          !entry.general &&
          !used.has(entry.index) &&
          !invalid.some((problem) => problem.index === entry.index),
      )
      .map((entry) => entry.index),
  };
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

function citationMarker(
  index: number,
  valid: readonly TaskCitation[],
  format: "slack" | "markdown",
): string {
  const citation = valid.find((entry) => entry.index === index);
  if (!citation) return "";
  const url = citation.resolvedUrl ? citationHttpUrl(citation.resolvedUrl) : null;
  if (!url) return `[${index}]`;
  const destination = url.replace(/[<>|()\\]/g, encodeURIComponent);
  return format === "slack" ? `<${destination}|[${index}]>` : `[[${index}]](${destination})`;
}

export interface TaskCitationSourceGroup {
  heading: "Sources" | "General sources";
  /** One rendered `[N] label` entry per citation, in index order. */
  items: string[];
}

/**
 * Renderable citations grouped for display. Citations referenced in
 * `referenceText` go under "Sources"; the rest (general, or never referenced)
 * go under "General sources" so they never read as inline-cited.
 */
export function taskCitationSourceGroups(
  referenceText: string,
  citations: readonly TaskCitation[],
  format: "slack" | "markdown" = "slack",
): TaskCitationSourceGroup[] {
  const valid = citations.filter(isRenderableCitation).sort((a, b) => a.index - b.index);
  const used = citedIndices(referenceText);
  const items = (group: TaskCitation[]) =>
    group.map((citation) => {
      const label = (citation.label || citation.kind).replace(/\s+/g, " ").trim();
      const escaped =
        format === "slack"
          ? label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          : label.replace(/[\\`*_{}[\]()<>!#|]/g, "\\$&");
      return `${citationMarker(citation.index, valid, format)} ${escaped}`;
    });
  const cited = valid.filter((citation) => used.has(citation.index));
  const general = valid.filter((citation) => !used.has(citation.index));
  return [
    ...(cited.length ? [{ heading: "Sources" as const, items: items(cited) }] : []),
    ...(general.length ? [{ heading: "General sources" as const, items: items(general) }] : []),
  ];
}

/** Source lines for renderable citations; see `taskCitationSourceGroups`. */
export function renderTaskCitationSources(
  referenceText: string,
  citations: readonly TaskCitation[],
  format: "slack" | "markdown" = "slack",
): string {
  return taskCitationSourceGroups(referenceText, citations, format)
    .map((group) => `${group.heading}: ${group.items.join(" · ")}`)
    .join(format === "slack" ? "\n" : "\n\n");
}

export function renderTaskCitations(
  text: string,
  citations: readonly TaskCitation[],
  format: "slack" | "markdown" = "slack",
  appendSources = true,
): string {
  const valid = citations.filter(isRenderableCitation);
  const stripped = stripInvalidTaskCitations(text, valid);
  const body = stripped.replace(CITATION_MARKER, (_, index) =>
    citationMarker(Number(index), valid, format),
  );
  const sources = appendSources ? renderTaskCitationSources(text, valid, format) : "";
  return sources ? `${body}\n\n${sources}` : body;
}

export function taskCitationWarnings(text: string, citations: readonly TaskCitation[]): string[] {
  const issues = taskCitationIssues(text, citations);
  return [
    ...issues.missingEntries.map(
      (index) =>
        `WARNING: [citation:${index}] has no citation entry; its marker is removed from rendered output.`,
    ),
    ...issues.invalid.map(
      ({ index, reason }) =>
        `WARNING: citation ${index} failed validation (${reason}); its marker and source are removed from rendered output.`,
    ),
    ...issues.unreferenced.map(
      (index) =>
        `WARNING: citation ${index} is not referenced in output; it renders under "General sources".`,
    ),
  ];
}
