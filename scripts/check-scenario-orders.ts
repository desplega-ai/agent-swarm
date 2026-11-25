#!/usr/bin/env bun
/**
 * Fails fast on e2e scenario `order` collisions, before the merge queue finds them.
 *
 * Two PRs branched off the same main can each give a new scenario the same `order`. Each
 * passes its own CI. The second one reaches the merge queue, where loadScenarios() throws
 * "Duplicate scenario order" and the queue kicks it. This check reports the collision on
 * the PR instead.
 *
 * Default mode (PR, merge group, local):
 *   1. loadScenarios() on the checked-out tree (the registry's own duplicate check).
 *   2. Orders this branch adds, against orders main gained since the base commit.
 *      Fails: the queue would kick the PR.
 *   3. With --open-prs: against orders other open PRs add. Fails when the other PR has
 *      auto-merge on (it is about to land), warns otherwise.
 *
 * --sweep (push to main): comments on every open PR whose added order main now owns.
 * --dry-run with --sweep prints the comments instead of posting them.
 *
 * Env: SCENARIO_ORDER_BASE (base commit, default merge-base of origin/main and HEAD),
 * SCENARIO_ORDER_MAIN (main tip, default origin/main), PR_NUMBER (own PR, skipped in
 * --open-prs), REPO (owner/name for gh).
 */
import { $ } from "bun";
import { loadScenarios, NON_SCENARIO_FILES, scenarioFiles, scenariosIn } from "./e2e/scenarios/registry";

const SCENARIOS_PATH = "scripts/e2e/scenarios/";

export interface AddedOrder {
  file: string;
  order: number;
}

export interface Collision {
  order: number;
  ours: string;
  theirs: string;
}

// shortcut: reads top-level `  order: N,` lines only, the shape every hand-written scenario
// uses. Generated scenarios (arrays, computed orders) are invisible here; the registry load
// in step 1 still covers them once both sides are in one tree.
const ORDER_LINE = /^\+ {2}order:\s*([0-9][0-9_]*(?:\.[0-9]+)?)\s*,/;

/** Orders a unified diff adds in scenario files, keyed by file name. */
export function addedOrders(diff: string): AddedOrder[] {
  const found: AddedOrder[] = [];
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "");
      const name = path.startsWith(SCENARIOS_PATH) ? path.slice(SCENARIOS_PATH.length) : "";
      file =
        name.endsWith(".ts") && !name.includes("/") && !NON_SCENARIO_FILES.has(name) ? name : null;
      continue;
    }
    if (!file) continue;
    const match = ORDER_LINE.exec(line);
    if (match?.[1]) found.push({ file, order: Number(match[1].replaceAll("_", "")) });
  }
  return found;
}

/** Orders both sides claim from different files. Same file means one scenario, edited twice. */
export function collisions(ours: AddedOrder[], theirs: AddedOrder[]): Collision[] {
  const out: Collision[] = [];
  for (const a of ours) {
    for (const b of theirs) {
      if (a.order === b.order && a.file !== b.file) {
        out.push({ order: a.order, ours: a.file, theirs: b.file });
      }
    }
  }
  return out;
}

async function git(...args: string[]): Promise<string> {
  return (await $`git ${args}`.quiet()).stdout.toString();
}

async function refExists(ref: string): Promise<boolean> {
  return (await $`git rev-parse --verify --quiet ${`${ref}^{commit}`}`.nothrow().quiet()).exitCode === 0;
}

async function diffOrders(from: string, to: string): Promise<AddedOrder[]> {
  return addedOrders(await git("diff", "--no-color", from, to, "--", SCENARIOS_PATH));
}

interface OpenPr {
  number: number;
  title: string;
  isDraft: boolean;
  autoMergeRequest: unknown;
  files: { path: string }[];
}

async function openScenarioPrs(repo: string): Promise<OpenPr[]> {
  const raw = await $`gh pr list --repo ${repo} --base main --state open --limit 200 --json number,title,isDraft,autoMergeRequest,files`
    .nothrow()
    .quiet();
  if (raw.exitCode !== 0) {
    console.log(`::warning::gh pr list failed, skipping open PRs: ${raw.stderr.toString().trim()}`);
    return [];
  }
  const prs = JSON.parse(raw.stdout.toString()) as OpenPr[];
  return prs.filter((pr) => pr.files.some((f) => f.path.startsWith(SCENARIOS_PATH)));
}

async function prOrders(repo: string, number: number): Promise<AddedOrder[]> {
  const diff = await $`gh pr diff ${number} --repo ${repo}`.nothrow().quiet();
  return diff.exitCode === 0 ? addedOrders(diff.stdout.toString()) : [];
}

function describe(c: Collision, where: string): string {
  return `order ${c.order}: ${c.ours} collides with ${c.theirs} (${where})`;
}

async function checkBranch(openPrs: boolean): Promise<number> {
  try {
    await loadScenarios();
  } catch (error) {
    console.log(`::error::${(error as Error).message}`);
    return 1;
  }

  const main = process.env.SCENARIO_ORDER_MAIN || "origin/main";
  if (!(await refExists(main))) {
    console.log(`Registry loads. ${main} not found, skipping the main and open-PR comparisons.`);
    return 0;
  }
  const base = process.env.SCENARIO_ORDER_BASE || (await git("merge-base", main, "HEAD")).trim();
  const ours = await diffOrders(base, "HEAD");
  let failed = 0;

  for (const c of collisions(ours, await diffOrders(base, main))) {
    console.log(`::error::${describe(c, `added on ${main} since ${base.slice(0, 10)}`)}. Pick a free order.`);
    failed = 1;
  }

  if (openPrs && ours.length > 0) {
    const repo = process.env.REPO || "desplega-ai/agent-swarm";
    const self = Number(process.env.PR_NUMBER || 0);
    for (const pr of await openScenarioPrs(repo)) {
      if (pr.number === self || pr.isDraft) continue;
      for (const c of collisions(ours, await prOrders(repo, pr.number))) {
        const where = `open PR #${pr.number}`;
        if (pr.autoMergeRequest) {
          console.log(`::error::${describe(c, `${where}, auto-merge on`)}. It lands first: pick a free order.`);
          failed = 1;
        } else {
          console.log(`::warning::${describe(c, where)}. Whichever lands second gets kicked from the queue.`);
        }
      }
    }
  }

  if (!failed) console.log(`Scenario orders OK (${ours.length} added on this branch).`);
  return failed;
}

async function sweep(dryRun: boolean): Promise<number> {
  const repo = process.env.REPO || "desplega-ai/agent-swarm";
  const owners = new Map<number, string>();
  for (const file of await scenarioFiles()) {
    for (const scenario of await scenariosIn(file)) owners.set(scenario.order, file);
  }
  for (const pr of await openScenarioPrs(repo)) {
    const mainOwned = (await prOrders(repo, pr.number)).flatMap((added) => {
      const owner = owners.get(added.order);
      return owner && owner !== added.file ? [{ order: added.order, ours: added.file, theirs: owner }] : [];
    });
    if (mainOwned.length === 0) continue;
    const marker = `<!-- scenario-order-check:${mainOwned.map((c) => `${c.order}@${c.theirs}`).join(",")} -->`;
    const comments = await $`gh pr view ${pr.number} --repo ${repo} --json comments --jq ${".comments[].body"}`.quiet();
    if (comments.stdout.toString().includes(marker)) {
      console.log(`PR #${pr.number} already notified`);
      continue;
    }
    const lines = mainOwned.map((c) => `- \`${c.ours}\` uses order **${c.order}**, now owned on main by \`${c.theirs}\``);
    const body = `${marker}\nmain now uses an e2e scenario order this PR also adds:\n${lines.join("\n")}\n\nMerge main and pick a free order before queueing, or the merge queue fails on \`Duplicate scenario order\`. \`bun scripts/check-scenario-orders.ts\` checks it locally.`;
    if (dryRun) {
      console.log(`would notify PR #${pr.number}:\n${lines.join("\n")}`);
      continue;
    }
    await $`gh pr comment ${pr.number} --repo ${repo} --body ${body}`.quiet();
    console.log(`notified PR #${pr.number}`);
  }
  return 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  process.exit(args.includes("--sweep") ? await sweep(args.includes("--dry-run")) : await checkBranch(args.includes("--open-prs")));
}
