// Relative imports: the root `bun test` run resolves no `@/` alias.
import { taskListTitle } from "../task-title";

/**
 * A task search hit. The title and the prompt both match: the prompt rides in
 * `keywords`, and `serverMatched` keeps a row the API found deeper in the
 * prompt than the slim list's preview reaches.
 */
export function taskResult(task: { id: string; task: string; title?: string; status: string }) {
  return {
    id: task.id,
    title: taskListTitle(task),
    detail: task.status.replace("_", " "),
    keywords: [task.id, task.task],
    href: `/tasks/${task.id}`,
    serverMatched: true,
  };
}
