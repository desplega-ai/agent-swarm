import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useTasks } from "@/api/hooks/use-tasks";
import { useEpics } from "@/api/hooks/use-epics";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Bot,
  ClipboardList,
  LayoutDashboard,
  MessageSquare,
  Clock,
  BarChart3,
  Settings,
  FolderGit2,
  Server,
  Hexagon,
} from "lucide-react";

const NAV_ITEMS = [
  { label: "Dashboard", path: "/", icon: LayoutDashboard, shortcut: "1" },
  { label: "Agents", path: "/agents", icon: Bot, shortcut: "2" },
  { label: "Tasks", path: "/tasks", icon: ClipboardList, shortcut: "3" },
  { label: "Epics", path: "/epics", icon: Hexagon, shortcut: "4" },
  { label: "Chat", path: "/chat", icon: MessageSquare, shortcut: "5" },
  { label: "Schedules", path: "/schedules", icon: Clock, shortcut: "6" },
  { label: "Usage", path: "/usage", icon: BarChart3, shortcut: "7" },
  { label: "Config", path: "/config", icon: Settings, shortcut: "8" },
  { label: "Repos", path: "/repos", icon: FolderGit2, shortcut: "9" },
  { label: "Services", path: "/services", icon: Server, shortcut: "0" },
];

export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const { data: agents } = useAgents();
  const { data: tasksData } = useTasks();
  const { data: epicsData } = useEpics();

  const tasks = tasksData?.tasks;
  const epics = epicsData?.epics;

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

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search agents, tasks, epics..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Navigation">
          {NAV_ITEMS.map((item) => (
            <CommandItem key={item.path} onSelect={() => handleSelect(item.path)}>
              <item.icon className="h-4 w-4" />
              <span>{item.label}</span>
              <span className="ml-auto text-xs text-muted-foreground">{item.shortcut}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        {agents && agents.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Agents">
              {agents.slice(0, 8).map((agent) => (
                <CommandItem
                  key={agent.id}
                  onSelect={() => handleSelect(`/agents/${agent.id}`)}
                >
                  <Bot className="h-4 w-4" />
                  <span>{agent.name}</span>
                  {agent.role && (
                    <span className="ml-auto text-xs text-muted-foreground">{agent.role}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {tasks && tasks.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Recent Tasks">
              {tasks.slice(0, 6).map((task) => (
                <CommandItem
                  key={task.id}
                  onSelect={() => handleSelect(`/tasks/${task.id}`)}
                >
                  <ClipboardList className="h-4 w-4" />
                  <span className="truncate max-w-[300px]">{task.task}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {epics && epics.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Epics">
              {epics.slice(0, 5).map((epic) => (
                <CommandItem
                  key={epic.id}
                  onSelect={() => handleSelect(`/epics/${epic.id}`)}
                >
                  <Hexagon className="h-4 w-4" />
                  <span>{epic.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
