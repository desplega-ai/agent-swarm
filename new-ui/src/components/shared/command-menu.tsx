import {
  BarChart3,
  Bot,
  ClipboardList,
  Clock,
  FolderGit2,
  LayoutDashboard,
  MessageSquare,
  Server,
  Settings,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useTasks } from "@/api/hooks/use-tasks";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

const NAV_ITEMS = [
  { label: "Dashboard", path: "/", icon: LayoutDashboard, shortcut: "1" },
  { label: "Agents", path: "/agents", icon: Bot, shortcut: "2" },
  { label: "Tasks", path: "/tasks", icon: ClipboardList, shortcut: "3" },
  { label: "Chat", path: "/chat", icon: MessageSquare, shortcut: "4" },
  { label: "Schedules", path: "/schedules", icon: Clock, shortcut: "5" },
  { label: "Usage", path: "/usage", icon: BarChart3, shortcut: "6" },
  { label: "Config", path: "/config", icon: Settings, shortcut: "7" },
  { label: "Repos", path: "/repos", icon: FolderGit2, shortcut: "8" },
  { label: "Services", path: "/services", icon: Server, shortcut: "9" },
];

export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const { data: agents } = useAgents();
  const { data: tasksData } = useTasks();
  const tasks = tasksData?.tasks;

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
      <CommandInput placeholder="Search agents, tasks..." />
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
                <CommandItem key={agent.id} onSelect={() => handleSelect(`/agents/${agent.id}`)}>
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
                <CommandItem key={task.id} onSelect={() => handleSelect(`/tasks/${task.id}`)}>
                  <ClipboardList className="h-4 w-4" />
                  <span className="truncate max-w-[300px]">{task.task}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
