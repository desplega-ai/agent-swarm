/**
 * Regression test for scripts/deploy-select.ts, the selection step of
 * .github/workflows/deploy.yml: deploy the newest main commit with api and
 * worker images, and skip when that commit is already on `:prod`.
 */
import { describe, expect, test } from "bun:test";
import { type Digests, selectDeploy } from "../../scripts/deploy-select";

const sha = (c: string) => c.repeat(40);
const [A, B, C, D] = ["a", "b", "c", "d"].map(sha) as [string, string, string, string];
const digests = (c: string): Digests => ({
  api: `sha256:${c}1`,
  worker: `sha256:${c}2`,
});

/** Main is D (newest) -> A; `built` lists the commits whose api and worker images exist. */
function run(built: string[], deployedSha: string | null, requestedSha?: string) {
  const resolved: string[] = [];
  const selection = selectDeploy({
    commits: [D, C, B, A],
    deployedSha,
    requestedSha,
    resolve: async (s) => {
      resolved.push(s);
      return built.includes(s) ? digests(s[0] as string) : null;
    },
  });
  return { selection, resolved };
}

describe("deploy selection (scripts/deploy-select.ts)", () => {
  test("main moved: deploys the newest built commit with its pinned digests", async () => {
    const { selection } = run([D, B], B);
    expect(await selection).toEqual({ action: "deploy", sha: D, digests: digests("d") });
  });

  test("main unchanged: skips when the newest built commit is already deployed", async () => {
    const { selection, resolved } = run([D, C], D);
    expect((await selection).action).toBe("skip");
    expect(resolved).toEqual([]);
  });

  test("newest commit without images falls back to an older built one", async () => {
    const { selection } = run([B, A], A);
    expect(await selection).toEqual({ action: "deploy", sha: B, digests: digests("b") });
  });

  test("only unbuilt commits since the deploy: skips without walking past it", async () => {
    const { selection, resolved } = run([A], B);
    expect((await selection).action).toBe("skip");
    expect(resolved).toEqual([D, C]);
  });

  test("no built commit at all: skips", async () => {
    const { selection } = run([], null);
    expect(await selection).toEqual({
      action: "skip",
      reason: "none of the last 4 main commits has api and worker images",
    });
  });

  test("no :prod yet (first run): deploys the newest built commit", async () => {
    expect(await run([C, A], null).selection).toEqual({
      action: "deploy",
      sha: C,
      digests: digests("c"),
    });
  });

  test("requested SHA deploys that commit, even an older one", async () => {
    const { selection } = run([D, B], D, B);
    expect(await selection).toEqual({ action: "deploy", sha: B, digests: digests("b") });
  });

  test("requested SHA already deployed: skips", async () => {
    expect((await run([D], D, D).selection).action).toBe("skip");
  });

  test("requested SHA without images or off main fails", async () => {
    await expect(run([D], A, C).selection).rejects.toThrow("missing an api or worker image");
    await expect(run([D], A, sha("e")).selection).rejects.toThrow("is not on main");
  });
});
