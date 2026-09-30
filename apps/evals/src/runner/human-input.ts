/**
 * Canned human for `request-human-input` (swarm-evals plan v2, Phase 8,
 * human-in-loop). A scenario with `humanInput` gets a responder that answers
 * every pending approval request of the attempt with the scenario's reply. The
 * swarm API creates the requester's `hitl-follow-up` task on the answer, so the
 * work resumes exactly as it would after a real human replied.
 *
 * The reply is the same whatever was asked. What the scenario grades is WHAT
 * the agent asked (a judge reads the stored questions) and whether the work that
 * followed used the answer; a responder that tailored its answer to the
 * question would make the two runs incomparable.
 */

import type { ApprovalQuestionJson, ApprovalRequestJson } from "../swarm/client.ts";
import type { HumanInputSpec } from "../types.ts";

/** Who the runner signs its answers as (`resolvedBy` on the request). */
export const CANNED_HUMAN = "eval-canned-human";

/** True when `word` appears in `text` as a whole word, case-insensitive. */
function namesWord(text: string, word: string): boolean {
  if (!word.trim()) return false;
  const escaped = word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

/** Options whose value or label the reply names as a whole word ("us" is not in "customers"). */
function optionsNamedIn(q: ApprovalQuestionJson, reply: string): string[] {
  return (q.options ?? [])
    .filter((o) => namesWord(reply, o.value) || namesWord(reply, o.label))
    .map((o) => o.value);
}

/**
 * The response for one question, in the shape the respond route validates:
 * text -> the reply; approval -> approved with the reply as comment; boolean ->
 * true; single-select -> the first option the reply names, else the first
 * option; multi-select -> every option the reply names (at least the first,
 * trimmed to maxSelections).
 */
export function cannedAnswer(q: ApprovalQuestionJson, reply: string): unknown {
  switch (q.type) {
    case "approval":
      return { approved: true, comment: reply };
    case "boolean":
      return true;
    case "single-select": {
      const named = optionsNamedIn(q, reply);
      return named[0] ?? q.options?.[0]?.value ?? reply;
    }
    case "multi-select": {
      const named = optionsNamedIn(q, reply);
      const picked = named.length > 0 ? named : q.options?.[0] ? [q.options[0].value] : [];
      return q.maxSelections !== undefined ? picked.slice(0, q.maxSelections) : picked;
    }
    default:
      return reply;
  }
}

export function cannedResponses(
  request: Pick<ApprovalRequestJson, "questions">,
  reply: string,
): Record<string, unknown> {
  return Object.fromEntries(request.questions.map((q) => [q.id, cannedAnswer(q, reply)]));
}

/** One answered request, persisted as the `human-input.json` artifact. */
export interface AnsweredRequest {
  id: string;
  title: string;
  sourceTaskId: string | null;
  questions: ApprovalQuestionJson[];
  responses: Record<string, unknown>;
  askedAt: string;
  answeredAt: string;
  error: string | null;
}

export interface HumanInputClient {
  listApprovalRequests(status?: string): Promise<ApprovalRequestJson[]>;
  respondApprovalRequest(
    id: string,
    responses: Record<string, unknown>,
    respondedBy: string,
  ): Promise<void>;
}

export class HumanResponder {
  readonly answered: AnsweredRequest[] = [];
  private loop: Promise<void> | null = null;
  private stopped = false;
  /** Serializes answerPending so the background loop and a settle pass never answer twice. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: HumanInputClient,
    private readonly spec: HumanInputSpec,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /**
   * Answer every pending request once. Returns how many were answered. A list
   * failure counts as none answered; a respond failure is recorded and the
   * request is not retried (a 409 means someone already resolved it).
   */
  answerPending(): Promise<number> {
    const run = this.chain.then(() => this.answerPendingOnce());
    this.chain = run.catch(() => {});
    return run;
  }

  private async answerPendingOnce(): Promise<number> {
    let pending: ApprovalRequestJson[];
    try {
      pending = await this.client.listApprovalRequests("pending");
    } catch (err) {
      this.log(`[human] listing approval requests failed: ${errText(err)}`);
      return 0;
    }
    let count = 0;
    for (const request of pending) {
      if (this.answered.some((a) => a.id === request.id)) continue;
      const responses = cannedResponses(request, this.spec.reply);
      let error: string | null = null;
      try {
        await this.client.respondApprovalRequest(request.id, responses, CANNED_HUMAN);
        count++;
        this.log(`[human] answered "${request.title}" (${request.questions.length} question(s))`);
      } catch (err) {
        error = errText(err);
        this.log(`[human] answering ${request.id} failed: ${error}`);
      }
      this.answered.push({
        id: request.id,
        title: request.title,
        sourceTaskId: request.sourceTaskId,
        questions: request.questions,
        responses,
        askedAt: request.createdAt,
        answeredAt: new Date().toISOString(),
        error,
      });
    }
    return count;
  }

  /** Poll in the background until {@link stop}. */
  start(intervalMs = 3_000, signal?: AbortSignal): void {
    if (this.loop) return;
    this.loop = (async () => {
      while (!this.stopped && !signal?.aborted) {
        await this.answerPending();
        await Bun.sleep(intervalMs);
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}

/**
 * Settle an attempt that may be waiting on a human: wait for quiescence, answer
 * whatever is pending, and repeat while answers keep creating follow-up work.
 * Quiescence alone is not enough: a lead that asked and then ended its task
 * leaves no open task, so the attempt would be graded before the answer landed.
 */
export async function settleWithHumanInput(opts: {
  responder: HumanResponder;
  waitForQuiescence: () => Promise<{ open: string[] }>;
  deadline: number;
}): Promise<{ open: string[] }> {
  while (true) {
    // Anything answered since this pass began (here or by the background loop)
    // created follow-up work the quiescence check may not have seen yet.
    const before = opts.responder.answered.length;
    const result = await opts.waitForQuiescence();
    if (result.open.length > 0 || Date.now() >= opts.deadline) return result;
    await opts.responder.answerPending();
    if (opts.responder.answered.length === before) return result;
  }
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
