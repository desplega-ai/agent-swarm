/**
 * Demo: Create a task and watch it appear in the task list.
 * Runtime: ~15-20s
 *
 * Flow:
 *   1. Open the tasks page
 *   2. Show the seeded task list
 *   3. Click the first task to show the detail view
 *   4. Navigate back, create a new task via the UI
 */

import { $ } from "bun";

const UI = process.env.SWARM_UI_URL ?? "http://localhost:5274";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export default async function createTask(): Promise<void> {
  // Open tasks page directly
  await $`agent-browser open ${UI}/tasks`;
  await sleep(1200);

  // Wait for tasks to load and take a snapshot to see what's there
  const snap = await $`agent-browser snapshot -i -c`.text();
  console.log("  page:", snap.split("\n").slice(0, 5).join(" | "));

  // Click the first task in the list (seeded: 12 tasks in various statuses)
  // Use `find text` to locate a task by its visible status badge
  await $`agent-browser find text "in_progress" click`.quiet().catch(async () => {
    await $`agent-browser find text "pending" click`.quiet().catch(() => {});
  });
  await sleep(800);

  // Navigate back to task list
  await $`agent-browser open ${UI}/tasks`;
  await sleep(800);

  // Click "New Task" button — correct find syntax: find role button click <text>
  await $`agent-browser find role button click "New Task"`.quiet().catch(async () => {
    // Try alternative labels
    await $`agent-browser find role button click "Create Task"`.quiet().catch(() => {});
  });
  await sleep(600);

  // Type task description
  await $`agent-browser find role textbox click "Task description"`.quiet().catch(() => {});
  await sleep(300);
  await $`agent-browser keyboard type "Review authentication PR #512 for security issues and post a summary"`;
  await sleep(500);

  // Submit the task — look for a Create or Submit button
  await $`agent-browser find role button click "Create"`.quiet().catch(async () => {
    await $`agent-browser find role button click "Submit"`.quiet().catch(() => {});
  });
  await sleep(1200);

  // Final pause for viewer
  await $`agent-browser wait 1000`;
}
