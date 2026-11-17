import { generateKeyPairSync } from "node:crypto";
import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { registerWorker, retireAgent } from "./platformb-helpers";

// Repo-scoped GitHub App tokens (POST /api/github/installation-token with `repo`).
// The API restarts with App credentials and GITHUB_URL pointed at a loopback stand-in for
// GitHub (GHES mode, so the API base is the stand-in). The operator lists one owner in
// GITHUB_APP_REPO_OWNERS. A worker can register any repo row, so the scenario proves the row
// alone never selects an installation: only a listed owner's repo, registered on the
// configured host, gets its own installation's token. Every other call gets the fixed
// GITHUB_APP_INSTALLATION_ID, as before this feature.

const FIXED_INSTALLATION = 77;
const ALLOWED = "e2e-allowed";
const OTHER = "e2e-other";

export const githubInstallationTokenRepos: Scenario = {
  name: "github-installation-token-repos",
  order: 656,
  async run(ctx) {
    const lookups: string[] = [];
    const mints: number[] = [];
    // Repo -> the installation the stand-in reports, and the account that owns it.
    const installations: Record<string, { id: number; login: string }> = {
      [`${ALLOWED}/app`]: { id: 88, login: ALLOWED },
      [`${OTHER}/app`]: { id: 99, login: OTHER },
      // A transferred repo: GitHub redirects to the new owner's installation.
      [`${ALLOWED}/moved`]: { id: 55, login: OTHER },
    };
    const minted = (id: number) => `e2e-installation-${id}`;
    const github = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        const lookup = path.match(/^\/api\/v3\/repos\/([^/]+\/[^/]+)\/installation$/);
        if (lookup) {
          const repo = lookup[1]!;
          lookups.push(repo);
          const found = installations[repo];
          if (!found) return new Response("no installation", { status: 404 });
          return Response.json({ id: found.id, account: { login: found.login } });
        }
        const mint = path.match(/^\/api\/v3\/app\/installations\/(\d+)\/access_tokens$/);
        if (!mint) return new Response("not found", { status: 404 });
        const id = Number(mint[1]);
        mints.push(id);
        return Response.json(
          { token: minted(id), expires_at: new Date(Date.now() + 3_600_000).toISOString() },
          { status: 201 },
        );
      },
    });
    const host = `127.0.0.1:${github.port}`;
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    let workerId: string | undefined;
    const repoIds: string[] = [];
    try {
      await ctx.restartSut({
        env: {
          GITHUB_DISABLE: "false",
          GITHUB_URL: `http://${host}`,
          // The base SUT env points the API base at its own stand-in; this scenario owns it.
          GITHUB_API_URL: `http://${host}/api/v3`,
          GITHUB_APP_ID: "424242",
          GITHUB_APP_PRIVATE_KEY: privateKey,
          GITHUB_APP_INSTALLATION_ID: String(FIXED_INSTALLATION),
          // Mixed case: owner logins compare case-insensitively.
          GITHUB_APP_REPO_OWNERS: ` E2E-Allowed , `,
        },
      });

      // The owner list is deployment env only: a config writer cannot extend it.
      const write = await ctx.api("PUT", "/api/config", {
        body: { scope: "global", key: "GITHUB_APP_REPO_OWNERS", value: OTHER },
      });
      expectStatus(write, [400], "storing GITHUB_APP_REPO_OWNERS in swarm_config");

      workerId = await registerWorker(ctx, `e2e-gh-repo-token-${ctx.nonce}`);
      const agentId = workerId;
      // The worker registers every repo itself: rows are agent-writable, so they cannot be the gate.
      const register = async (url: string, name: string) => {
        const res = await ctx.api("POST", "/api/repos", {
          agentId,
          body: { url, name: `${name}-${ctx.nonce}`, clonePath: `/tmp/e2e-${name}-${ctx.nonce}` },
        });
        expectStatus(res, [201], `worker registers ${url}`);
        repoIds.push(asString(asRecord(res.json).id, `repo ${name} id`));
      };
      await register(`http://${host}/${ALLOWED}/App.git`, "allowed-app");
      await register(`http://${host}/${OTHER}/app`, "other-app");
      await register(`http://${host}/${ALLOWED}/moved`, "allowed-moved");
      await register(`http://${host}/${ALLOWED}/missing`, "allowed-missing");
      // Another host whose path ends in a listed owner's repo is not that repo.
      await register(`https://git.example.test/${ALLOWED}/spoof`, "allowed-spoof");

      const mint = (repo?: string) =>
        ctx.api("POST", "/api/github/installation-token", {
          agentId,
          body: repo === undefined ? {} : { repo },
        });
      const tokenOf = (res: { json: unknown }) => asRecord(res.json).token;
      const reset = () => {
        lookups.length = 0;
        mints.length = 0;
      };

      // A listed owner's registered repo: its own installation, looked up with the App JWT.
      const own = await mint(`${ALLOWED}/app`);
      expectStatus(own, [200], "listed owner, registered repo");
      expect(tokenOf(own) === minted(88), `listed owner gets installation 88, got ${own.text}`);
      expect(
        JSON.stringify(lookups) === JSON.stringify([`${ALLOWED}/app`]) &&
          JSON.stringify(mints) === "[88]",
        `one lookup and one mint for 88, got lookups=${lookups} mints=${mints}`,
      );

      // Regression: a worker registers another owner's repo (201 above), then asks for it.
      // The owner is not listed, so the request cannot select that installation: no lookup,
      // and the token is the fixed installation's, exactly as with no repo.
      reset();
      const other = await mint(`${OTHER}/app`);
      expectStatus(other, [200], "unlisted owner");
      expect(
        tokenOf(other) === minted(FIXED_INSTALLATION),
        `unlisted owner gets the fixed installation, got ${other.text}`,
      );
      expect(lookups.length === 0, `unlisted owner never resolves an installation, got ${lookups}`);
      expect(!mints.includes(99), "installation 99 is never minted");

      // A listed owner's repo the swarm has not registered, or registered on another host: 403.
      reset();
      for (const repo of [`${ALLOWED}/unregistered`, `${ALLOWED}/spoof`]) {
        const refused = await mint(repo);
        expectStatus(refused, [403], `listed owner, ${repo}`);
        expect(
          asRecord(refused.json).error === "The repo is not registered in the swarm",
          `${repo} is refused as unregistered, got ${refused.text}`,
        );
      }
      expect(lookups.length === 0 && mints.length === 0, "a refused repo reaches GitHub not at all");

      // GitHub answers with an installation that belongs to an unlisted account, or with no
      // installation: nothing minted. The "no" is cached, so repeating the request does not
      // cost another App JWT and GitHub call.
      for (const repo of [`${ALLOWED}/moved`, `${ALLOWED}/missing`]) {
        reset();
        for (const attempt of [1, 2, 3]) {
          expectStatus(await mint(repo), [502], `${repo}, attempt ${attempt}`);
        }
        expect(mints.length === 0, `no token for ${repo}, got mints=${mints}`);
        expect(lookups.length === 1, `${repo} is looked up once, got ${lookups.length}`);
      }

      // No repo: the fixed installation, unchanged.
      reset();
      const none = await mint();
      expectStatus(none, [200], "no repo");
      expect(tokenOf(none) === minted(FIXED_INSTALLATION), "no repo gets the fixed installation");
    } finally {
      for (const id of repoIds) await ctx.api("DELETE", `/api/repos/${id}`);
      await retireAgent(ctx, workerId);
      // Boot the base env again, without the App credentials.
      await ctx.restartSut();
      github.stop(true);
    }
  },
};
