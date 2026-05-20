/**
 * Demo: Navigate to the Workflows page and view the seeded workflow.
 * Runtime: ~15-20s
 *
 * Flow:
 *   1. Open Workflows page — shows the seeded "PR Review Pipeline"
 *   2. Click into the workflow to show the DAG
 *   3. Scroll to show definition nodes
 *   4. Navigate back to list
 */

import { $ } from "bun";

const UI = process.env.SWARM_UI_URL ?? "http://localhost:5274";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export default async function workflowRun(): Promise<void> {
  // Open workflows page
  await $`agent-browser open ${UI}/workflows`;
  await sleep(1200);

  // Show the list — pause so viewer reads it
  await sleep(600);

  // Find the workflow card by its title text and click it
  await $`agent-browser find text "PR Review Pipeline" click`.quiet().catch(async () => {
    // Fallback: find any link in the workflow list
    await $`agent-browser find role link click`.quiet().catch(() => {});
  });
  await sleep(900);

  // Scroll down to show the workflow definition / node graph
  await $`agent-browser scroll down 300`;
  await sleep(700);

  // Pause for viewer to read the DAG
  await $`agent-browser wait 900`;

  // Scroll back up
  await $`agent-browser scroll up 300`;
  await sleep(500);

  // Take a final screenshot to capture the workflow detail
  await $`agent-browser screenshot`.quiet().catch(() => {});
  await sleep(800);
}
