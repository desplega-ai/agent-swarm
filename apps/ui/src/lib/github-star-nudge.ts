/**
 * The GitHub star nudge: after the user's 5th successful prompt (a new task,
 * a chat message or a follow-up sent from this UI), one small notice asks for
 * a star. Closing it or clicking "Star on GitHub" hides it for good.
 *
 * State lives in this browser's localStorage, per API URL (the same
 * `swarm:v1:<apiUrl>:<key>` namespace as `useDismissibleCard`), so each swarm
 * the UI points at counts on its own. Pure on purpose: storage is injected,
 * and the toast lives in `github-star-nudge-toast.tsx`.
 */

import { deriveStorageKey } from "../hooks/use-dismissible-card-key";

export const GITHUB_REPO_URL = "https://github.com/desplega-ai/agent-swarm";
export const STAR_NUDGE_PROMPT_THRESHOLD = 5;

const COUNT_KEY = "github-star-nudge:prompts";
const DONE_KEY = "github-star-nudge:done";

type NudgeStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Counts one successful send and returns true when the notice should show:
 * from the 5th send on, until the user closes it or clicks the button.
 * Storage errors (privacy mode, quota) never break a send: no notice.
 */
export function recordPromptSent(apiUrl: string, storage: NudgeStorage): boolean {
  try {
    if (storage.getItem(deriveStorageKey(apiUrl, DONE_KEY)) === "1") return false;
    const key = deriveStorageKey(apiUrl, COUNT_KEY);
    const stored = Number.parseInt(storage.getItem(key) ?? "", 10);
    const count = (Number.isFinite(stored) && stored > 0 ? stored : 0) + 1;
    storage.setItem(key, String(count));
    return count >= STAR_NUDGE_PROMPT_THRESHOLD;
  } catch {
    return false;
  }
}

/** The user closed the notice or clicked "Star on GitHub": never show it again. */
export function markStarNudgeDone(apiUrl: string, storage: NudgeStorage): void {
  try {
    storage.setItem(deriveStorageKey(apiUrl, DONE_KEY), "1");
  } catch {
    // Unavailable storage: the notice may come back on a later send.
  }
}
