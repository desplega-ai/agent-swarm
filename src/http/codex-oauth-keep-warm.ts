/**
 * Locked keep-warm refresh sweep for the Codex OAuth pool.
 *
 * The 2026-06-19 policy ("no active background refresh") was a reaction to
 * an UNLOCKED refresher racing the runner's rotation — not a ban on
 * background refresh itself. The correct policy is "no *unlocked* active
 * refresh": a keep-warm job that goes through the same locked
 * `getValidCodexOAuth` path (re-read/persist/quarantine discipline
 * unchanged) is race-free by construction.
 *
 * With the live-verified 10-day access-token TTL, a slot only gets refreshed
 * when a task happens to draw it within `REFRESH_SKEW_MS` of expiry — which
 * for an idle/rarely-drawn slot can be never, letting its refresh token sit
 * unexercised well past OpenAI's ~8-day session-staleness guidance. This
 * sweep calls the SAME `getValidCodexOAuth` with `opts.maxAgeMs` ≈ 7 days so
 * every slot refreshes on a roughly-weekly cadence regardless of task draw
 * frequency — zero logic duplication, all lock/persist/quarantine behavior
 * reused verbatim (see storage.ts doc comment; hand-rolling a refresher here
 * would re-create the 2026-06-19 race).
 *
 * The scheduled trigger (a swarm-script calling this endpoint on a daily
 * cadence) ships separately after this endpoint deploys and bakes.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getKv } from "../be/db";
import { deriveCodexKeySuffix } from "../providers/codex-oauth/auth-json.js";
import { getValidCodexOAuth, loadAllCodexOAuthSlots } from "../providers/codex-oauth/storage.js";
import { getApiKey } from "../utils/api-key";
import { route } from "./route-def";
import { deriveApiBaseUrl, json } from "./utils";

/** ~weekly refresh cadence, comfortably inside OpenAI's ~8-day staleness window given the 10-day TTL. */
const KEEP_WARM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Matches the `codex-auth-watch` KV namespace the `codex-auth-expiry-watch` script benches slots into. */
const AUTH_WATCH_NAMESPACE = "codex-auth-watch";

type SlotOutcome =
  | { slot: number; keySuffix: string; outcome: "warm" | "refreshed" }
  | { slot: number; keySuffix: string; outcome: "skipped-benched" }
  | { slot: number; outcome: "no-credentials" }
  | { slot: number; keySuffix: string; outcome: "failed"; reason: string };

const keepWarmRoute = route({
  method: "post",
  path: "/api/oauth/keep-warm/codex",
  pattern: ["api", "oauth", "keep-warm", "codex"],
  summary: "Locked keep-warm refresh sweep across all Codex OAuth pool slots",
  description:
    "Enumerates codex_oauth_* slots and refreshes any older than ~7 days through the same locked getValidCodexOAuth path used at task time. Skips slots already benched by codex-auth-expiry-watch.",
  tags: ["OAuth"],
  responses: {
    200: { description: "Per-slot keep-warm outcomes" },
  },
});

export async function handleCodexOAuthKeepWarm(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
): Promise<boolean> {
  if (!keepWarmRoute.match(req.method, pathSegments)) return false;
  const parsed = await keepWarmRoute.parse(req, res, pathSegments, new URLSearchParams());
  if (!parsed) return true;

  const apiUrl = deriveApiBaseUrl(req);
  const apiKey = getApiKey();
  const slots = await loadAllCodexOAuthSlots(apiUrl, apiKey);
  const results: SlotOutcome[] = [];

  for (const { slot, creds } of slots) {
    const keySuffix = deriveCodexKeySuffix(creds.access, creds.accountId);

    if (getKv(AUTH_WATCH_NAMESPACE, `bench:${keySuffix}`)) {
      results.push({ slot, keySuffix, outcome: "skipped-benched" });
      continue;
    }

    try {
      const beforeAccess = creds.access;
      const refreshed = await getValidCodexOAuth(apiUrl, apiKey, slot, {
        maxAgeMs: KEEP_WARM_MAX_AGE_MS,
      });
      if (!refreshed) {
        results.push({ slot, outcome: "no-credentials" });
      } else {
        results.push({
          slot,
          keySuffix,
          outcome: refreshed.access === beforeAccess ? "warm" : "refreshed",
        });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      results.push({ slot, keySuffix, outcome: "failed", reason });
    }

    // Small jitter between slots — avoids a thundering herd against
    // OpenAI's token endpoint even though a dozen slots is trivially fast
    // to sweep sequentially.
    await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200));
  }

  json(res, { results });
  return true;
}
