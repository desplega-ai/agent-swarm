/**
 * Demo: Browse to the Schedules page and view the daily standup schedule.
 * Runtime: ~12-18s
 *
 * Flow:
 *   1. Open Schedules page — shows seeded "Daily Standup Summary"
 *   2. Click into the schedule detail
 *   3. Show cron expression + task template
 *   4. Scroll to show more details
 */

import { $ } from "bun";

const UI = process.env.SWARM_UI_URL ?? "http://localhost:5274";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export default async function schedule(): Promise<void> {
  // Open schedules page
  await $`agent-browser open ${UI}/schedules`;
  await sleep(1200);

  // Pause for viewer to see the schedule list
  await sleep(600);

  // Click into the "Daily Standup Summary" schedule
  await $`agent-browser find text "Daily Standup" click`.quiet().catch(async () => {
    // Fallback: click any schedule card
    await $`agent-browser find role link click`.quiet().catch(() => {});
  });
  await sleep(900);

  // Scroll down to show cron expression and task template
  await $`agent-browser scroll down 200`;
  await sleep(700);

  // Pause so viewer can read the schedule details
  await $`agent-browser wait 900`;

  // Scroll back up for clean outro frame
  await $`agent-browser scroll up 200`;
  await sleep(600);
}
