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
  Server,
  Settings,
  UserPlus,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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

interface NavItem {
  label: string;
  path: string;
  icon: typeof Bot;
  gate?: { minVersion: string };
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
  { label: "Services", path: "/services", icon: Server },
];

export function CommandMenu() {
  const [open, setOpen] = useState(false);
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

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function handleSelect(path: string) {
    navigate(path);
    setOpen(false);
  }

  function handleTaskAction(action: "cancel" | "pause" | "resume", task: AgentTask) {
    if (action === "cancel") {
      cancelTask.mutate({ id: task.id, reason: "Cancelled from command palette" });
    } else if (action === "pause") {
      pauseTask.mutate(task.id);
    } else {
      resumeTask.mutate(task.id);
    }
    setOpen(false);
  }

  function handleCreateForAgent(agentId: string) {
    navigate(`/tasks?new=true&agentId=${encodeURIComponent(agentId)}`);
    setOpen(false);
  }

  function taskLabel(task: AgentTask) {
    return task.task.length > 80 ? `${task.task.slice(0, 80)}...` : task.task;
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search navigation, agents, tasks, actions..." />
      <CommandList className="max-h-[520px]">
        <CommandEmpty>No results found.</CommandEmpty>

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
                activeTask.status !== "cancelled" && (
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
                  <span className="max-w-[300px] truncate">{task.task}</span>
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
