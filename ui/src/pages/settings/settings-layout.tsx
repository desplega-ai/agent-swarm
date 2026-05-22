import {
  Bug,
  Key,
  type LucideIcon,
  Plug,
  Settings as SettingsIcon,
  SlidersHorizontal,
} from "lucide-react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface SettingsNavItem {
  title: string;
  path: string;
  icon: LucideIcon;
}

const SETTINGS_NAV: SettingsNavItem[] = [
  { title: "Config", path: "/settings/config", icon: SlidersHorizontal },
  { title: "API Keys", path: "/settings/api-keys", icon: Key },
  { title: "Integrations", path: "/settings/integrations", icon: Plug },
  { title: "Repos", path: "/settings/repos", icon: SettingsIcon },
  { title: "Debug", path: "/settings/debug", icon: Bug },
];

/**
 * Two-column shell for the admin section. A left rail of NavLinks (collapsing
 * to a Select below `md`) drives nested routes that render into the `<Outlet/>`.
 * The shell owns the content scroll container and renders no PageHeader of its
 * own — each embedded page keeps its own header as the section title.
 */
export function SettingsLayout() {
  const location = useLocation();
  const navigate = useNavigate();

  // Match the active rail item by path prefix so deep links (e.g.
  // /settings/integrations/slack) keep "Integrations" highlighted.
  const activeItem =
    SETTINGS_NAV.find((item) => location.pathname.startsWith(item.path)) ?? SETTINGS_NAV[0];

  return (
    <div className="flex flex-col flex-1 min-h-0 md:flex-row md:gap-6">
      {/* Mobile: Select picker above the content. */}
      <div className="md:hidden shrink-0 mb-4">
        <Select value={activeItem.path} onValueChange={(next) => navigate(next)}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SETTINGS_NAV.map((item) => (
              <SelectItem key={item.path} value={item.path}>
                {item.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Desktop: left rail. */}
      <nav aria-label="Settings" className="hidden md:flex md:flex-col md:gap-0.5 md:w-48 shrink-0">
        {SETTINGS_NAV.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )
            }
          >
            <item.icon className="size-4 shrink-0" />
            <span>{item.title}</span>
          </NavLink>
        ))}
      </nav>

      {/* Content area owns the scroll container. */}
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
