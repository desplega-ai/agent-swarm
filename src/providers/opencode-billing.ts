/**
 * OpenRouter's billed cost for an OpenCode 2 session.
 *
 * OpenCode prices tokens from its model catalog, and the swarm pricing table
 * holds OpenRouter's model-level list price. Both are the cheapest endpoint's
 * rate, while OpenRouter bills the endpoint that served the request, which
 * can cost 100x more. OpenCode asks OpenRouter for `usage: { include: true }`,
 * so every response carries `usage.cost`, the USD OpenRouter charged. The
 * swarm plugin hands each OpenRouter response here, and the session reports
 * the sum as billed when every response carried one.
 */

/** The billed USD in an OpenRouter chat response (SSE or JSON), or null. */
export function parseOpenRouterBilledCost(body: string): number | null {
  const payloads = body.trimStart().startsWith("{")
    ? [body]
    : body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
  let cost: number | null = null;
  for (const payload of payloads) {
    if (!payload.includes('"cost"')) continue;
    let usage: { cost?: unknown; is_byok?: unknown } | undefined;
    try {
      usage = (JSON.parse(payload) as { usage?: typeof usage }).usage;
    } catch {
      continue;
    }
    // A BYOK `cost` is OpenRouter's fee only; the upstream bills the rest.
    if (usage?.is_byok === true) return null;
    if (typeof usage?.cost === "number" && Number.isFinite(usage.cost)) cost = usage.cost;
  }
  return cost;
}

export interface BilledCost {
  costUsd: number;
  /** True when every observed response reported what OpenRouter charged. */
  complete: boolean;
}

export class OpenRouterBilling {
  private requests = 0;
  private billed = 0;
  private costUsd = 0;
  private pending = new Set<Promise<void>>();

  /** Reads a copy of `response`; the caller keeps streaming the original. */
  observe(response: Response): void {
    this.requests++;
    // OpenRouter does not charge for a rejected request.
    if (!response.ok) {
      this.billed++;
      return;
    }
    const read = response
      .clone()
      .text()
      .then((body) => {
        const cost = parseOpenRouterBilledCost(body);
        if (cost === null) return;
        this.billed++;
        this.costUsd += cost;
      })
      .catch(() => {})
      .finally(() => this.pending.delete(read));
    this.pending.add(read);
  }

  /** Waits up to `timeoutMs` for in-flight responses, then reports. */
  async settle(timeoutMs: number): Promise<BilledCost | null> {
    if (this.pending.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(this.pending),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
    }
    if (this.requests === 0) return null;
    return { costUsd: this.costUsd, complete: this.billed === this.requests };
  }
}
