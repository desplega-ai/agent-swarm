/**
 * Compile-time regression guard for `track()`'s catalog bound.
 *
 * Never imported and never run. `tsconfig.json` excludes `src/tests`, so a
 * `@ts-expect-error` in a `*.test.ts` file is never checked; this file sits
 * inside the program that `bun run tsc:check` compiles (CI: "Lint and Type
 * Check"). Every `@ts-expect-error` below is an assertion: once `track()` stops
 * rejecting the line under it, tsc reports an unused directive and CI fails.
 */
import { track } from "./telemetry";

const taskCreated = {
  taskId: "task-1",
  task_source: "mcp",
  trigger_surface: "mcp",
  hasParent: false,
  has_repo: false,
  priority: 50,
} as const;

export function _trackRejectsWhatTheCatalogDoesNot(): void {
  // Control: a catalogued event with catalogued properties compiles. If the
  // contract types break, this line fails instead of the assertions passing.
  track({ event: "task.created", properties: taskCreated });

  track({
    // @ts-expect-error "not.in.catalog" is not a catalogued agent-swarm event
    event: "not.in.catalog",
    properties: {},
  });

  track({
    event: "task.created",
    properties: {
      ...taskCreated,
      // @ts-expect-error "bogus" is not a property of task.created
      bogus: 1,
    },
  });
}
