/**
 * Compile-time checks of the repository contracts: `bun run tsc` in this
 * package fails when a directive below stops matching an error. Nothing here
 * runs.
 */
import type {
  AgentsRepository,
  NewAgent,
  NewTaskRow,
  TaskStatus,
  TasksRepository,
} from "../../src";

declare const agents: AgentsRepository;
declare const tasks: TasksRepository;
declare const valid: NewAgent;
const page = { limit: 1, offset: 0 };

export async function agentStatusIsChecked(): Promise<void> {
  // @ts-expect-error a misspelled status fails on insert
  await agents.insertAgent({ ...valid, status: "bsy" });
  // @ts-expect-error a misspelled status fails on update
  await agents.setAgentColumns("a1", { status: "bsy" });
  await agents.setAgentColumns("a1", { status: "busy", maxTasks: 2 });
  const row = await agents.findAgentById("a1");
  const status: "idle" | "busy" | "offline" | "waiting_for_credentials" | undefined = row?.status;
  void status;
}

export async function listProjectionsExposeOnlyTheirColumns(): Promise<void> {
  const [timeline] = await tasks.listTasks({}, page, "timeline");
  // @ts-expect-error the timeline projection does not select output
  void timeline?.output;
  const preview: Uint8Array | undefined = timeline?.task;
  void preview;
  const [slim] = await tasks.listTasks({}, page, "slim");
  // @ts-expect-error the slim projection does not select output
  void slim?.output;
  void slim?.progress;
  const [full] = await tasks.listTasks({}, page, "full");
  const output: string | null | undefined = full?.output;
  void output;
}

declare const newTask: NewTaskRow;

export async function taskEnumColumnsAreChecked(): Promise<void> {
  // @ts-expect-error a misspelled status fails on insert
  await tasks.insertTask({ ...newTask, status: "in_progres" });
  // @ts-expect-error a source outside the domain list fails on insert
  await tasks.insertTask({ ...newTask, source: "email" });
  // @ts-expect-error routing_reason takes only the CHECK constraint's values
  await tasks.insertTask({ ...newTask, routing_reason: "random" });
  const row = await tasks.findTaskById("t1");
  const status: TaskStatus | undefined = row?.status;
  const routing: "declared" | "engine_default" | null | undefined = row?.routing_source;
  void status;
  void routing;
}
