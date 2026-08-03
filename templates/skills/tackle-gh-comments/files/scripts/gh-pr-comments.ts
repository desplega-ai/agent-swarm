#!/usr/bin/env bun
/**
 * GitHub PR review-comment triage tool. Project-agnostic.
 *
 * Review THREADS (and their resolved state) are only exposed via GraphQL — the
 * REST API cannot read `isResolved` nor resolve a thread. So everything here
 * goes through GraphQL, authenticated with `gh auth token`.
 *
 * Usage:
 *   bun gh-pr-comments.ts list    [--pr N] [--repo owner/name] [--all]
 *   bun gh-pr-comments.ts reply   --thread <threadId> --body "..."
 *   bun gh-pr-comments.ts resolve --thread <threadId>
 *   bun gh-pr-comments.ts handle  --thread <threadId> --body "..."   # reply + resolve
 *   bun gh-pr-comments.ts verify  [--pr N]                           # assert none unresolved
 *
 * `list` prints unresolved threads by default (--all includes resolved ones).
 * Thread ids are opaque GraphQL node ids — pass them back verbatim.
 */

import { $ } from "bun";

type ThreadComment = {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  url: string;
};

type ReviewThread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments: ThreadComment[];
};

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const cmd = argv[0] ?? "list";
  const args: Args = {};
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return { cmd, args };
}

async function token(): Promise<string> {
  const value = (await $`gh auth token`.text()).trim();
  if (!value) throw new Error("`gh auth token` returned nothing — run `gh auth login`.");
  return value;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${await token()}`,
      "Content-Type": "application/json",
      // Required for the reviewThreads connection on some enterprise hosts.
      Accept: "application/vnd.github.v4+json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(`GraphQL: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) throw new Error(`GraphQL returned no data (HTTP ${res.status})`);
  return json.data;
}

/** Resolve owner/name + PR number from flags, falling back to the current checkout. */
async function context(args: Args): Promise<{ owner: string; name: string; number: number }> {
  let repo = typeof args.repo === "string" ? args.repo : "";
  if (!repo) {
    repo = (await $`gh repo view --json nameWithOwner -q .nameWithOwner`.text()).trim();
  }
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`Could not parse repo from "${repo}"`);

  let number = Number(args.pr);
  if (!Number.isFinite(number) || number <= 0) {
    number = Number((await $`gh pr view --json number -q .number`.text()).trim());
  }
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error("Could not determine PR number — pass --pr N.");
  }

  return { owner, name, number };
}

const THREADS_QUERY = `
query($owner:String!, $name:String!, $number:Int!, $cursor:String) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      reviewThreads(first:50, after:$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first:50) {
            nodes { id author { login } body createdAt url }
          }
        }
      }
    }
  }
}`;

async function fetchThreads(ctx: {
  owner: string;
  name: string;
  number: number;
}): Promise<ReviewThread[]> {
  const threads: ReviewThread[] = [];
  let cursor: string | null = null;

  for (;;) {
    const data = await graphql<{
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: {
              id: string;
              isResolved: boolean;
              isOutdated: boolean;
              path: string | null;
              line: number | null;
              comments: {
                nodes: {
                  id: string;
                  author: { login: string } | null;
                  body: string;
                  createdAt: string;
                  url: string;
                }[];
              };
            }[];
          };
        };
      };
    }>(THREADS_QUERY, { ...ctx, cursor });

    const connection = data.repository.pullRequest.reviewThreads;
    for (const node of connection.nodes) {
      threads.push({
        id: node.id,
        isResolved: node.isResolved,
        isOutdated: node.isOutdated,
        path: node.path,
        line: node.line,
        comments: node.comments.nodes.map((c) => ({
          id: c.id,
          author: c.author?.login ?? "(ghost)",
          body: c.body,
          createdAt: c.createdAt,
          url: c.url,
        })),
      });
    }

    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }

  return threads;
}

async function reply(threadId: string, body: string): Promise<void> {
  await graphql(
    `mutation($threadId:ID!, $body:String!) {
       addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId, body:$body}) {
         comment { id url }
       }
     }`,
    { threadId, body },
  );
}

async function resolve(threadId: string): Promise<void> {
  await graphql(
    `mutation($threadId:ID!) {
       resolveReviewThread(input:{threadId:$threadId}) {
         thread { id isResolved }
       }
     }`,
    { threadId },
  );
}

function render(threads: ReviewThread[], showAll: boolean): void {
  const shown = showAll ? threads : threads.filter((t) => !t.isResolved);
  const unresolved = threads.filter((t) => !t.isResolved).length;

  console.log(
    `${threads.length} thread(s) total — ${unresolved} unresolved, ` +
      `${threads.length - unresolved} resolved\n`,
  );

  for (const [index, thread] of shown.entries()) {
    const where = thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ""}` : "(general)";
    const flags = [
      thread.isResolved ? "RESOLVED" : "UNRESOLVED",
      thread.isOutdated ? "outdated" : null,
    ]
      .filter(Boolean)
      .join(", ");

    console.log(`── [${index + 1}] ${where}  (${flags})`);
    console.log(`   thread: ${thread.id}`);
    for (const comment of thread.comments) {
      const indented = comment.body
        .trim()
        .split("\n")
        .map((line) => `     ${line}`)
        .join("\n");
      console.log(`   @${comment.author} — ${comment.url}`);
      console.log(indented);
    }
    console.log();
  }
}

const { cmd, args } = parseArgs(process.argv.slice(2));

switch (cmd) {
  case "list": {
    render(await fetchThreads(await context(args)), args.all === true);
    break;
  }
  case "json": {
    console.log(JSON.stringify(await fetchThreads(await context(args)), null, 2));
    break;
  }
  case "reply": {
    const id = String(args.thread ?? "");
    const body = String(args.body ?? "");
    if (!id || !body) throw new Error("reply needs --thread and --body");
    await reply(id, body);
    console.log(`replied to ${id}`);
    break;
  }
  case "resolve": {
    const id = String(args.thread ?? "");
    if (!id) throw new Error("resolve needs --thread");
    await resolve(id);
    console.log(`resolved ${id}`);
    break;
  }
  case "handle": {
    const id = String(args.thread ?? "");
    const body = String(args.body ?? "");
    if (!id || !body) throw new Error("handle needs --thread and --body");
    await reply(id, body);
    await resolve(id);
    console.log(`replied + resolved ${id}`);
    break;
  }
  case "verify": {
    const threads = await fetchThreads(await context(args));
    const open = threads.filter((t) => !t.isResolved);
    if (open.length > 0) {
      console.error(`${open.length} thread(s) still unresolved:`);
      for (const thread of open) {
        console.error(`  ${thread.path ?? "(general)"} — ${thread.id}`);
      }
      process.exit(1);
    }
    console.log(`All ${threads.length} thread(s) resolved.`);
    break;
  }
  default:
    console.error(`Unknown command "${cmd}". See the header for usage.`);
    process.exit(1);
}
