// State contract of the agent-swarm Claude Code mod (claude-mod/register.tsx).

// A task started from this session: by Claude's delegate tool or the pane.
export type Tracked = {
  id: string;
  title: string;
  tier: string | null;
  status: string;
  progress: string | null;
  createdAt: number;
  // "claude": its result goes back to Claude. "pane": a toast only.
  origin: "claude" | "pane";
  // Set once the finish was reported, so it is reported once.
  isReported: boolean;
};

// One of the user's other swarm tasks (Slack, schedules, other sessions).
export type Row = { id: string; status: string; preview: string; progress: string | null };

// One rendered line of a task's session log.
export type LogLine = {
  id: string;
  icon: string;
  text: string;
  tone: "normal" | "dim" | "error" | "accent";
};

// Which input the pane shows: none, the search field, a new task, or a steer message.
export type Mode = "list" | "search" | "new" | "steer";

declare module "claude-code" {
  interface PluginState {
    "agent-swarm": {
      // `cc:<8 hex>`: the tag this session puts on its tasks.
      tag: string | null;
      tracked: Tracked[];
      others: Row[];
      selected: string | null;
      query: string;
      mode: Mode;
      logsFor: string | null;
      logLines: LogLine[];
      error: string | null;
    };
  }
}
