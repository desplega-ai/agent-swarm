import type { ApprovalQuestion } from "../api/types";

function hasRequiredResponse(question: ApprovalQuestion, response: unknown): boolean {
  switch (question.type) {
    case "approval":
      return (
        typeof response === "object" &&
        response !== null &&
        typeof (response as { approved?: unknown }).approved === "boolean"
      );
    case "text":
      return typeof response === "string" && response.trim().length > 0;
    case "single-select":
      return (
        typeof response === "string" &&
        response.length > 0 &&
        (!question.options || question.options.some((option) => option.value === response))
      );
    case "multi-select": {
      if (!Array.isArray(response)) return false;
      const minimum = Math.max(1, question.minSelections ?? 0);
      if (response.length < minimum) return false;
      if (question.maxSelections !== undefined && response.length > question.maxSelections) {
        return false;
      }
      return response.every(
        (value) =>
          typeof value === "string" &&
          (!question.options || question.options.some((option) => option.value === value)),
      );
    }
    case "boolean":
      return typeof response === "boolean";
  }
}

export function missingRequiredResponseIds(
  questions: ApprovalQuestion[],
  responses: Record<string, unknown>,
): string[] {
  return questions
    .filter(
      (question) => question.required && !hasRequiredResponse(question, responses[question.id]),
    )
    .map((question) => question.id);
}
