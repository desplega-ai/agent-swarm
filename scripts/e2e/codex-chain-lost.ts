/**
 * Marks the codex leg failed in a harness result file after the Actions cache did not keep its
 * auth chain. The run step writes its result before the cache save runs, and the nightly report
 * reads only result files. Without this rewrite, a lost chain behind a passing task reports
 * green, and the next night restores a refresh token this run already spent.
 *
 * Usage: bun scripts/e2e/codex-chain-lost.ts <e2e-results.json>
 */
import type { E2eResult, HarnessResult } from "./report";

export const CODEX_CHAIN_NOT_SAVED =
  "codex auth chain was not saved to the Actions cache; the next run would restore a spent refresh token";

function failLeg<T extends { status: string; error?: string; failureKind?: string }>(entry: T): T {
  return {
    ...entry,
    status: "fail",
    error: entry.error ? `${entry.error}; ${CODEX_CHAIN_NOT_SAVED}` : CODEX_CHAIN_NOT_SAVED,
    failureKind: "auth-chain",
  };
}

/** The result with every codex leg, and its final attempt, failed as `auth-chain`. */
export function markCodexChainLost(result: E2eResult): E2eResult {
  let marked = false;
  const harness = result.harness.map((leg): HarnessResult => {
    if (leg.provider !== "codex") return leg;
    marked = true;
    const attempts = [...leg.attempts];
    const last = attempts.pop();
    return failLeg({ ...leg, attempts: last ? [...attempts, failLeg(last)] : attempts });
  });
  return marked ? { ...result, harness, ok: false } : result;
}

/** Rewrites the file in place. A missing file needs nothing: the report flags the leg as missing. */
export async function markCodexChainLostFile(path: string): Promise<boolean> {
  const file = Bun.file(path);
  if (!(await file.exists())) return false;
  const marked = markCodexChainLost((await file.json()) as E2eResult);
  await Bun.write(path, `${JSON.stringify(marked, null, 2)}\n`);
  return true;
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: bun scripts/e2e/codex-chain-lost.ts <e2e-results.json>");
    process.exit(2);
  }
  const rewritten = await markCodexChainLostFile(path);
  console.error(
    rewritten
      ? `ERROR ${CODEX_CHAIN_NOT_SAVED}; marked the codex leg failed in ${path}`
      : `ERROR ${CODEX_CHAIN_NOT_SAVED}; ${path} is missing, so the report shows the leg as missing`,
  );
}
