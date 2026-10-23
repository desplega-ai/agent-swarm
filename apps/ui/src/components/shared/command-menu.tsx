import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Bot,
  ClipboardList,
  Clock,
  FolderGit2,
  Globe,
  LayoutDashboard,
  MessageSquare,
  PauseCircle,
  PlayCircle,
  Settings,
  UserPlus,
  XCircle,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useCancelTask, usePauseTask, useResumeTask, useTasks } from "@/api/hooks/use-tasks";
import type { AgentTask } from "@/api/types";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { taskListTitle } from "@/lib/task-title";

interface NavItem {
  label: string;
  path: string;
  icon: typeof Bot;
  gate?: { minVersion: string };
}

/** One command a page adds to the palette. */
export interface CommandMenuItem {
  /** Unique in its group. */
  id: string;
  label: string;
  icon?: LucideIcon;
  /** More words the palette filter matches. */
  keywords?: string[];
  /** A key hint at the right of the row, e.g. "E". */
  shortcut?: string;
  onSelect: () => void;
}

interface CommandMenuGroupEntry {
  id: string;
  heading: string;
  items: CommandMenuItem[];
}

type RegisterGroup = (id: string, group: CommandMenuGroupEntry | null) => void;

// Three contexts, so a page that registers commands never re-renders when
// the registered groups change (that would register again, in a loop).
const RegisterContext = createContext<RegisterGroup | null>(null);
const GroupsContext = createContext<CommandMenuGroupEntry[]>([]);
const SearchContext = createContext<{ search: string; setSearch: (value: string) => void } | null>(
  null,
);

/** Holds the page command groups and the palette's search text. Mount it around the routes and `CommandMenu`. */
export function CommandMenuProvider({ children }: { children: ReactNode }) {
  const [groups, setGroups] = useState<CommandMenuGroupEntry[]>([]);
  const [search, setSearch] = useState("");
  const register = useCallback<RegisterGroup>((id, group) => {
    setGroups((prev) => {
      const at = prev.findIndex((entry) => entry.id === id);
      if (!group) return at < 0 ? prev : prev.filter((entry) => entry.id !== id);
      if (at < 0) return [...prev, group];
      const next = [...prev];
      next[at] = group;
      return next;
    });
  }, []);
  const searchValue = useMemo(() => ({ search, setSearch }), [search]);
  return (
    <RegisterContext.Provider value={register}>
      <GroupsContext.Provider value={groups}>
        <SearchContext.Provider value={searchValue}>{children}</SearchContext.Provider>
      </GroupsContext.Provider>
    </RegisterContext.Provider>
  );
}

/**
 * Adds a group of commands to the palette while the caller is mounted. An
 * empty `items` list hides the group. Memoize `items`: a new array registers
 * the group again. With `enabled` false the caller leaves the group alone,
 * so another caller can own the same id (the sessions page hands the
 * `sessions` group to the v2 view).
 */
export function useCommandMenuGroup(
  id: string,
  heading: string,
  items: CommandMenuItem[],
  enabled = true,
) {
  const register = useContext(RegisterContext);
  useEffect(() => {
    if (enabled) register?.(id, items.length > 0 ? { id, heading, items } : null);
  }, [register, id, heading, items, enabled]);
  // React runs every cleanup before any new effect, so a hand-over between
  // two callers never drops the other caller's group.
  useEffect(() => {
    if (!enabled) return;
    return () => register?.(id, null);
  }, [register, id, enabled]);
}

/** The palette's search text. Empty while the palette is closed. */
export function useCommandMenuSearch(): string {
  return useContext(SearchContext)?.search ?? "";
}

function useSearchState() {
  const value = useContext(SearchContext);
  if (!value) throw new Error("CommandMenu needs a CommandMenuProvider around it");
  return value;
}

const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", path: "/", icon: LayoutDashboard },
  { label: "Agents", path: "/agents", icon: Bot },
  { label: "Tasks", path: "/tasks", icon: ClipboardList },
  { label: "Chat", path: "/chat", icon: MessageSquare },
  { label: "Schedules", path: "/schedules", icon: Clock },
  { label: "Usage", path: "/usage", icon: BarChart3 },
  { label: "Connections", path: "/settings/connections", icon: Settings },
  { label: "Repos", path: "/settings/repos", icon: FolderGit2 },
  { label: "Pages", path: "/pages", icon: Globe, gate: { minVersion: "1.79.0" } },
  { label: "Metrics", path: "/usage/metrics", icon: BarChart3, gate: { minVersion: "1.79.0" } },
];

export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const pageGroups = useContext(GroupsContext);
  const { search, setSearch } = useSearchState();
  const location = useLocation();
  const navigate = useNavigate();

  const { data: agents } = useAgents();
  const { data: tasksData } = useTasks({ includeHeartbeat: true, limit: 100 });
  const tasks = tasksData?.tasks ?? [];
  const cancelTask = useCancelTask();
  const pauseTask = usePauseTask();
  const resumeTask = useResumeTask();
  const activeTaskId = location.pathname.match(/^\/tasks\/([^/]+)/)?.[1];
  const activeTask = tasks.find((task) => task.id === activeTaskId);
  const actionableTasks = useMemo(
    () =>
      tasks.filter(
        (task) =>
          task.status === "pending" || task.status === "in_progress" || task.status === "paused",
      ),
    [tasks],
  );

  // Feature-gate lookups for nav items whose backing routes need a min API
  // version. Hide an item only when the gate explicitly reports unsupported
  // — leaves it visible while the version probe is in flight so the menu
  // doesn't flash open with missing items.
  const gates: Record<string, boolean> = {
    "1.79.0": useFeatureGate("1.79.0").supported, // Pages
  };
  const visibleNav = NAV_ITEMS.filter((i) => !i.gate || gates[i.gate.minVersion] !== false);

  // Every close path clears the search, so the palette always opens empty.
  const close = useCallback(() => {
    setOpen(false);
    setSearch("");
  }, [setSearch]);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (openRef.current) close();
        else setOpen(true);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close]);

  function handleSelect(path: string) {
    void navigate(path);
    close();
  }

  function handleTaskAction(action: "cancel" | "pause" | "resume", task: AgentTask) {
    if (action === "cancel") {
      cancelTask.mutate({ id: task.id, reason: "Cancelled from command palette" });
    } else if (action === "pause") {
      pauseTask.mutate(task.id);
    } else {
      resumeTask.mutate(task.id);
    }
    close();
  }

  function handleCreateForAgent(agentId: string) {
    void navigate(`/tasks?new=true&agentId=${encodeURIComponent(agentId)}`);
    close();
  }

  function taskLabel(task: AgentTask) {
    const label = taskListTitle(task);
    return label.length > 80 ? `${label.slice(0, 80)}...` : label;
  }

  return (
    <CommandDialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <CommandInput
        placeholder="Search navigation, agents, tasks, actions..."
        value={search}
        onValueChange={setSearch}
      />
      <CommandList className="max-h-[520px]">
        <CommandEmpty>No results found.</CommandEmpty>

        {/* Page commands first: they act on what the user is looking at. */}
        {pageGroups.map((group) => (
          <CommandGroup key={group.id} heading={group.heading}>
            {group.items.map((item) => (
              <CommandItem
                key={item.id}
                value={`${group.heading} ${item.label} ${item.id}`}
                keywords={item.keywords}
                onSelect={() => {
                  close();
                  item.onSelect();
                }}
                className="group/item"
              >
                {item.icon ? <item.icon className="h-4 w-4" /> : null}
                {/* One line with an ellipsis. The highlighted row (keys or
                    pointer) shows the whole label, e.g. a long session title. */}
                <span className="truncate group-data-[selected=true]/item:whitespace-normal group-data-[selected=true]/item:wrap-anywhere">
                  {item.label}
                </span>
                {item.shortcut ? <CommandShortcut>{item.shortcut}</CommandShortcut> : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
        {pageGroups.length > 0 ? <CommandSeparator /> : null}

        <CommandGroup heading="Navigation">
          {visibleNav.map((item) => (
            <CommandItem key={item.path} onSelect={() => handleSelect(item.path)}>
              <item.icon className="h-4 w-4" />
              <span>{item.label}</span>
              {item.label === "Tasks" && <CommandShortcut>G T</CommandShortcut>}
            </CommandItem>
          ))}
        </CommandGroup>

        {activeTask && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Current Task">
              {activeTask.status === "in_progress" && (
                <CommandItem
                  value={`pause current task ${activeTask.task} ${activeTask.id}`}
                  onSelect={() => handleTaskAction("pause", activeTask)}
                >
                  <PauseCircle className="h-4 w-4" />
                  <span>Pause current task</span>
                  <CommandShortcut>P</CommandShortcut>
                </CommandItem>
              )}
              {activeTask.status === "paused" && (
                <CommandItem
                  value={`resume current task ${activeTask.task} ${activeTask.id}`}
                  onSelect={() => handleTaskAction("resume", activeTask)}
                >
                  <PlayCircle className="h-4 w-4" />
                  <span>Resume current task</span>
                  <CommandShortcut>R</CommandShortcut>
                </CommandItem>
              )}
              {activeTask.status !== "completed" &&
                activeTask.status !== "failed" &&
                activeTask.status !== "cancelled" &&
                activeTask.status !== "superseded" && (
                  <CommandItem
                    value={`cancel current task ${activeTask.task} ${activeTask.id}`}
                    onSelect={() => handleTaskAction("cancel", activeTask)}
                  >
                    <XCircle className="h-4 w-4" />
                    <span>Cancel current task</span>
                    <CommandShortcut>C</CommandShortcut>
                  </CommandItem>
                )}
            </CommandGroup>
          </>
        )}

        {agents && agents.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Agents">
              {agents.slice(0, 8).map((agent) => (
                <div key={agent.id}>
                  <CommandItem
                    value={`agent ${agent.name} ${agent.role ?? ""} ${agent.status} ${agent.id}`}
                    onSelect={() => handleSelect(`/agents/${agent.id}`)}
                  >
                    <Bot className="h-4 w-4" />
                    <span>{agent.name}</span>
                    {agent.role && (
                      <span className="ml-auto text-xs text-muted-foreground">{agent.role}</span>
                    )}
                  </CommandItem>
                  <CommandItem
                    value={`assign new task to ${agent.name} ${agent.role ?? ""} ${agent.id}`}
                    onSelect={() => handleCreateForAgent(agent.id)}
                  >
                    <UserPlus className="h-4 w-4" />
                    <span>Assign new task to {agent.name}</span>
                  </CommandItem>
                </div>
              ))}
            </CommandGroup>
          </>
        )}

        {actionableTasks.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Task Actions">
              {actionableTasks.slice(0, 12).map((task) => (
                <div key={task.id}>
                  {task.status === "in_progress" && (
                    <CommandItem
                      value={`pause task ${task.task} ${task.id} ${task.agentId ?? ""}`}
                      onSelect={() => handleTaskAction("pause", task)}
                    >
                      <PauseCircle className="h-4 w-4" />
                      <span className="max-w-[320px] truncate">Pause {taskLabel(task)}</span>
                    </CommandItem>
                  )}
                  {task.status === "paused" && (
                    <CommandItem
                      value={`resume task ${task.task} ${task.id} ${task.agentId ?? ""}`}
                      onSelect={() => handleTaskAction("resume", task)}
                    >
                      <PlayCircle className="h-4 w-4" />
                      <span className="max-w-[320px] truncate">Resume {taskLabel(task)}</span>
                    </CommandItem>
                  )}
                  {task.status !== "paused" && (
                    <CommandItem
                      value={`cancel task ${task.task} ${task.id} ${task.agentId ?? ""}`}
                      onSelect={() => handleTaskAction("cancel", task)}
                    >
                      <XCircle className="h-4 w-4" />
                      <span className="max-w-[320px] truncate">Cancel {taskLabel(task)}</span>
                    </CommandItem>
                  )}
                </div>
              ))}
            </CommandGroup>
          </>
        )}

        {tasks.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Search Tasks">
              {tasks.slice(0, 25).map((task) => (
                <CommandItem
                  key={task.id}
                  value={`task ${task.task} ${task.id} ${task.status} ${task.agentId ?? ""} ${
                    task.tags?.join(" ") ?? ""
                  } ${task.taskType ?? ""}`}
                  onSelect={() => handleSelect(`/tasks/${task.id}`)}
                >
                  <ClipboardList className="h-4 w-4" />
                  <span className="max-w-[300px] truncate">{taskListTitle(task)}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{task.status}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
