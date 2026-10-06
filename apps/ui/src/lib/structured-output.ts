/** Structured output JSON (`{ status, output, summary }`), or null for plain text. */
export function parseStructuredOutput(raw: string): { output?: string; summary?: string } | null {
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      ("output" in parsed || "summary" in parsed)
    )
      return parsed as { output?: string; summary?: string };
  } catch {
    // Not JSON, fall through.
  }
  return null;
}
