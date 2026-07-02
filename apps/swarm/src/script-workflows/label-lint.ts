export type LabelLintError = {
  label: string;
  lineNumber: number | null;
  detail: string;
};

export type LabelLintResult = { ok: true } | { ok: false; errors: LabelLintError[] };

const CTX_STEP_LITERAL_LABEL_PATTERN = /ctx\.step\.\w+\(\s*"([^"]+)"/g;
const LOOP_PATTERNS = [
  /\bfor\s*\(/,
  /\bwhile\s*\(/,
  /\.map\s*\(/,
  /\.forEach\s*\(/,
  /\.reduce\s*\(/,
  /\.flatMap\s*\(/,
];

export function lintWorkflowLabels(source: string): LabelLintResult {
  const errors: LabelLintError[] = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    CTX_STEP_LITERAL_LABEL_PATTERN.lastIndex = 0;
    let match = CTX_STEP_LITERAL_LABEL_PATTERN.exec(line);
    while (match !== null) {
      const label = match[1];
      if (!label) {
        match = CTX_STEP_LITERAL_LABEL_PATTERN.exec(line);
        continue;
      }
      const windowStart = Math.max(0, i - 10);
      const context = lines.slice(windowStart, i + 1).join("\n");
      if (!LOOP_PATTERNS.some((pattern) => pattern.test(context))) {
        match = CTX_STEP_LITERAL_LABEL_PATTERN.exec(line);
        continue;
      }
      errors.push({
        label,
        lineNumber: i + 1,
        detail:
          `Literal string label "${label}" at line ${i + 1} appears inside a loop. ` +
          "Labels must be unique per run; use a template literal that includes the loop variable.",
      });
      match = CTX_STEP_LITERAL_LABEL_PATTERN.exec(line);
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
