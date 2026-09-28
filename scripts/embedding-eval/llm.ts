// Minimal OpenRouter chat helper for query generation, chunk context, and judging.
const MODEL = process.env.EMBED_EVAL_LLM ?? "google/gemini-3-flash-preview";

export const llmUsage = { calls: 0, promptTokens: 0, completionTokens: 0, cost: 0 };

export async function chatJson<T>(system: string, user: string, model = MODEL): Promise<T | null> {
  const text = await chat(system, user, true, model);
  if (text === null) return null;
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")) as T;
  } catch {
    // Some models wrap the JSON in prose: take the last {...} object.
    const objects = text.match(/\{[^{}]*\}/g);
    if (!objects) return null;
    try {
      return JSON.parse(objects[objects.length - 1]!) as T;
    } catch {
      return null;
    }
  }
}

export async function chat(
  system: string,
  user: string,
  json = false,
  model = MODEL,
): Promise<string | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    let res: Response;
    try {
      res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: AbortSignal.timeout(120_000),
        headers: {
          authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          ...(json ? { response_format: { type: "json_object" } } : {}),
          usage: { include: true },
        }),
      });
    } catch {
      await Bun.sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await Bun.sleep(1000 * 2 ** attempt);
      continue;
    }
    const body = (await res.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    llmUsage.calls++;
    llmUsage.promptTokens += body.usage?.prompt_tokens ?? 0;
    llmUsage.completionTokens += body.usage?.completion_tokens ?? 0;
    llmUsage.cost += body.usage?.cost ?? 0;
    return body.choices?.[0]?.message?.content ?? null;
  }
  return null;
}
