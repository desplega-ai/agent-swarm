/**
 * VCS Provider Adapter — shared types for GitHub/GitLab integration.
 *
 * Both providers implement VcsAdapter and emit NormalizedEvents so the rest
 * of the codebase (task creation, workflow engine, reactions) stays
 * provider-agnostic.
 */

export type VcsProvider = "github" | "gitlab";

/** Normalized event emitted by any VCS adapter after parsing a webhook. */
export interface NormalizedEvent {
  provider: VcsProvider;
  type: "pull_request" | "issue" | "comment" | "review" | "ci_status";
  action: string;
  repo: string;
  number?: number;
  author: string;
  url: string;
  body?: string;
  /** Original, provider-specific payload for when generic fields aren't enough. */
  raw: unknown;
}

/** Common interface every VCS provider adapter must implement. */
export interface VcsAdapter {
  readonly provider: VcsProvider;

  // ── Feature gating ──
  isEnabled(): boolean;

  // ── Webhook handling ──
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean;
  parseEvent(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): NormalizedEvent | null;

  // ── Reactions & comments ──
  addReaction(
    repo: string,
    entityType: "issue" | "mr",
    number: number,
    reaction: string,
  ): Promise<void>;
  postComment(
    repo: string,
    entityType: "issue" | "mr",
    number: number,
    body: string,
  ): Promise<void>;

  // ── Auth ──
  getToken(repo?: string): Promise<string>;
}
