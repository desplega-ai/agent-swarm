import { Type } from "typebox";
import { z } from "zod";
import { resolveTemplateAsync } from "../../prompts/resolver";
import "./../../prompts/internal-ai-templates";
import { completeStructured } from "./complete-structured";

const DEFAULT_CLASSIFY_TIMEOUT_MS = 3_000;

export const ClassificationResultSchema = z.object({
  label: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  reasoning: z.string().optional(),
});
export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;

export interface ClassifyOptions {
  timeoutMs?: number;
  /** Test injection point. */
  _completeStructured?: typeof completeStructured;
}

export async function classify(
  input: string | Record<string, unknown>,
  labels: string[],
  opts: ClassifyOptions = {},
): Promise<ClassificationResult | null> {
  if (labels.length === 0 || labels.some((label) => label.length === 0)) return null;

  const allowedLabels = new Set(labels);
  const resultSchema = ClassificationResultSchema.refine(
    (result) => allowedLabels.has(result.label),
    { message: "label must be one of the supplied labels", path: ["label"] },
  );
  const systemPrompt = await resolveTemplateAsync("system.internal_ai.classify", {});
  const userPrompt = await resolveTemplateAsync("task.internal_ai.classify", {
    labels: JSON.stringify(labels),
    input: typeof input === "string" ? input : JSON.stringify(input),
  });
  if (systemPrompt.skipped || userPrompt.skipped) return null;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_CLASSIFY_TIMEOUT_MS;
  const abortController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => {
      abortController.abort();
      resolve(null);
    }, timeoutMs);
  });

  try {
    const complete = opts._completeStructured ?? completeStructured;
    const completion = complete({
      zodSchema: resultSchema,
      toolSchema: Type.Object({
        label: Type.String({ description: `One of: ${labels.join(", ")}` }),
        confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        reasoning: Type.Optional(Type.String()),
      }),
      toolName: "record_classification",
      toolDescription: "Record the selected classification label and optional confidence.",
      systemPrompt: systemPrompt.text,
      userPrompt: userPrompt.text,
      retries: 1,
      signal: abortController.signal,
      callerTag: "routing-classify",
    });
    // The losing promise after an abort must not surface an unhandledRejection.
    completion.catch(() => {});
    return await Promise.race([completion, timeout]);
  } catch {
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
