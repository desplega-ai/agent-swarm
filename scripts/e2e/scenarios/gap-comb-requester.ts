// biome-ignore-all lint/suspicious/noExplicitAny: scratch e2e fixtures read untyped JSON
import { asRecord, expect, expectStatus } from "../http";
import { SkipError } from "../report";
import type { Scenario } from "../run";

// PR #2545: a Comb send from the dashboard carries no user, so the task's requester is the
// swarm user mapped from the newest comment author (agent-fs drive-members email -> swarm user).
// A smuggled body `requestedByUserId` is dropped. Run via scripts/e2e-gap/with-afs.sh.
async function afs(
  base: string,
  method: string,
  path: string,
  key?: string,
  body?: unknown,
): Promise<{ status: number; json: any; text: string }> {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, json, text };
}

export const gapCombRequester: Scenario = {
  name: "gap-comb-requester",
  order: 1050,
  async run(ctx) {
    const base = process.env.GAP_AFS_URL;
    if (!base) throw new SkipError("GAP_AFS_URL not set (use scripts/e2e-gap/with-afs.sh)");

    const status = await ctx.api("GET", "/status");
    expectStatus(status, [200], "status");
    const comb = asRecord(asRecord(asRecord(status.json).agent_fs).comb);
    expect(comb.enabled === true, `Comb is off: ${JSON.stringify(comb)}`);
    const orgId = String(comb.org_id);
    const driveId = String(comb.drive_id);

    // Two swarm users with emails; only the first has an agent-fs account in the swarm drive.
    const mkUser = async (label: string) => {
      const email = `${label}-${ctx.nonce}@example.com`;
      const created = await ctx.api("POST", "/api/users", { body: { name: label, email } });
      expectStatus(created, [200, 201], `create swarm user ${label}`);
      return { email, id: String(asRecord(asRecord(created.json).user).id) };
    };
    const author = await mkUser("comb-author");
    const bystander = await mkUser("comb-bystander");
    const stranger = `comb-stranger-${ctx.nonce}@example.com`; // agent-fs account, no swarm user

    const registerAfs = async (email: string) => {
      const response = await afs(base, "POST", "/auth/register", undefined, { email });
      expect(response.status === 200, `register ${email} on agent-fs: ${response.status}`);
      return { key: String(response.json.apiKey), userId: String(response.json.userId) };
    };
    const authorAfs = await registerAfs(author.email);
    const strangerAfs = await registerAfs(stranger);
    for (const email of [author.email, stranger]) {
      const invite = await ctx.api("POST", "/api/fs/members/invite", {
        body: { email, role: "editor" },
      });
      expectStatus(invite, [200], `add ${email} to the swarm drive`);
    }

    const ops = (key: string, body: Record<string, unknown>) =>
      afs(base, "POST", `/orgs/${orgId}/ops`, key, { driveId, ...body });
    const path = `/gap/comb-${ctx.nonce}.md`;
    const wrote = await ops(authorAfs.key, {
      op: "write",
      path,
      content: "# Comb gap\nline one\n",
    });
    expect(wrote.status === 200, `write file: ${wrote.status} ${wrote.text.slice(0, 200)}`);
    const comment = async (key: string, bodyText: string) => {
      const response = await ops(key, { op: "comment-add", path, body: bodyText });
      expect(
        response.status === 200,
        `comment-add: ${response.status} ${response.text.slice(0, 200)}`,
      );
      return String(response.json.id);
    };

    const sendBatch = (commentIds: string[], extra: Record<string, unknown> = {}) =>
      ctx.api("POST", "/api/comb/review-batches", {
        body: { orgId, driveId, commentIds, scopePath: path, ...extra },
      });
    const requesterOf = (taskId: string) =>
      ctx.db.get<{ requestedByUserId: string | null }>(
        "SELECT requestedByUserId FROM agent_tasks WHERE id = ?",
        [taskId],
      )?.requestedByUserId ?? null;

    // 1. Mapped author, with a smuggled requestedByUserId naming the bystander.
    const c1 = await comment(authorAfs.key, "please tighten line one");
    const first = await sendBatch([c1], { requestedByUserId: bystander.id });
    expectStatus(first, [201], "send batch 1");
    const task1 = String(asRecord(first.json).taskId);
    expect(
      requesterOf(task1) === author.id,
      `batch 1 requester: got ${String(requesterOf(task1))}, expected the comment author ${author.id}`,
    );
    expect(requesterOf(task1) !== bystander.id, "a body requestedByUserId was trusted");

    // 2. Control: an author with no swarm user leaves the requester empty.
    const c2 = await comment(strangerAfs.key, "unmapped author comment");
    const second = await sendBatch([c2]);
    expectStatus(second, [201], "send batch 2");
    const task2 = String(asRecord(second.json).taskId);
    expect(
      requesterOf(task2) === null,
      `unmapped author got requester ${String(requesterOf(task2))}`,
    );

    // 3. Mixed authors: the newest mapped comment's author wins.
    const c3 = await comment(strangerAfs.key, "older, unmapped");
    await Bun.sleep(1100);
    const c4 = await comment(authorAfs.key, "newer, mapped");
    const third = await sendBatch([c3, c4]);
    expectStatus(third, [201], "send batch 3");
    expect(
      requesterOf(String(asRecord(third.json).taskId)) === author.id,
      "mixed batch: the mapped author is the requester",
    );
  },
};
