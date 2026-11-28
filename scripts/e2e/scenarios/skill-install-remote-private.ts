import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { callTool, ensureLead, expectToolError, expectToolOk } from "./knowledge-helpers";

// Remote skill install from a private GitHub repo. The API restarts with GITHUB_URL and
// GITHUB_API_URL pointed at a loopback stand-in (Enterprise mode, so every read goes to the
// stand-in and none to raw.githubusercontent.com). The stand-in serves SKILL.md only to the
// configured token, and answers 404 without it, as GitHub does for a private repo. The token
// must never reach an error message or the stored skill.

const TOKEN = "e2e-private-skill-token";
const REPO = "e2e-org/private-skills";

export const skillInstallRemotePrivate: Scenario = {
  name: "skill-install-remote-private",
  order: 659,
  async run(ctx) {
    const skillName = `private-skill-${ctx.nonce}`;
    const auths: string[] = [];
    let revoked = false;
    const github = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        const auth = req.headers.get("authorization") ?? "";
        auths.push(auth);
        const file = `/api/v3/repos/${REPO}/contents/skills/private/SKILL.md`;
        if (url.pathname !== file || url.searchParams.get("ref") !== "main") {
          return new Response("Not Found", { status: 404 });
        }
        if (auth && revoked) return new Response("Bad credentials", { status: 401 });
        if (auth !== `Bearer ${TOKEN}`) return new Response("Not Found", { status: 404 });
        return new Response(`---\nname: ${skillName}\ndescription: Private skill\n---\n\nBody\n`);
      },
    });
    const host = `127.0.0.1:${github.port}`;
    const githubEnv = {
      GITHUB_URL: `http://${host}`,
      GITHUB_API_URL: `http://${host}/api/v3`,
    };
    const cleanupSkills: string[] = [];
    const noToken = (text: string, label: string) =>
      expect(!text.includes(TOKEN), `${label} must not carry the token: ${text.slice(0, 300)}`);
    try {
      await ctx.restartSut({ env: { ...githubEnv, GITHUB_TOKEN: TOKEN } });
      const lead = await ensureLead(ctx);
      const sessionLead = await ctx.connectMcp(lead);

      // Token configured: the read authenticates and the private skill installs.
      const outcome = expectToolOk(
        await callTool(sessionLead, "skill-install-remote", {
          sourceRepo: REPO,
          sourcePath: "skills/private",
          scope: "swarm",
        }),
        "skill-install-remote from a private repo",
      );
      expect(auths.at(-1) === `Bearer ${TOKEN}`, `the read sends the token, got ${auths.at(-1)}`);
      const skill = asRecord(outcome.data.skill);
      const skillId = asString(skill.id, "private skill id");
      cleanupSkills.push(skillId);
      expect(
        skill.name === skillName && String(skill.content).includes("Body"),
        `private skill fields: ${JSON.stringify(skill).slice(0, 300)}`,
      );
      noToken(JSON.stringify(skill), "the stored skill");
      noToken(outcome.text, "the tool result");

      // A missing file is a 404, and its error says so, not "auth failed".
      const missing = await callTool(sessionLead, "skill-install-remote", {
        sourceRepo: REPO,
        sourcePath: "skills/missing",
      });
      expectToolError(missing, "skill-install-remote of a missing file", /not found \(HTTP 404\)/i);
      expect(!/refused/i.test(missing.message), `404 is not an auth failure: ${missing.message}`);

      // The token is revoked: the error names the auth failure, never the token.
      revoked = true;
      const refused = await callTool(sessionLead, "skill-install-remote", {
        sourceRepo: REPO,
        sourcePath: "skills/private",
      });
      expectToolError(refused, "skill-install-remote with a revoked token", /refused.*HTTP 401/i);
      noToken(`${refused.message}\n${refused.text}`, "the auth error");
      const sync = await ctx.api("POST", "/api/skills/sync-remote", { body: { skillId } });
      expectStatus(sync, [200], "sync the private skill with a revoked token");
      const syncText = JSON.stringify(sync.json);
      expect(/refused.*HTTP 401/i.test(syncText), `sync reports the auth failure: ${syncText}`);
      noToken(syncText, "the sync errors");
      revoked = false;

      // No token configured: the read is unauthenticated and the private repo is a 404.
      await ctx.restartSut({ env: githubEnv });
      auths.length = 0;
      const anon = await ctx.api("POST", "/api/skills/install-remote", {
        body: { sourceRepo: REPO, sourcePath: "skills/private" },
      });
      expectStatus(anon, [400], "install-remote from a private repo without a token");
      expect(
        /not found \(HTTP 404\).*configure a GitHub token/i.test(anon.text),
        `the 404 hints at a missing token: ${anon.text}`,
      );
      expect(
        auths.length === 1 && auths[0] === "",
        `one unauthenticated read, got ${JSON.stringify(auths)}`,
      );
    } finally {
      for (const id of cleanupSkills) await ctx.api("DELETE", `/api/skills/${id}`);
      await ctx.restartSut();
      github.stop(true);
    }
  },
};
