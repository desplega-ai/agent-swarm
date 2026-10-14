/**
 * `IconName` → lucide component, plus the `CatalogIcon` renderer every catalog
 * `icon` prop goes through. The map is static (no `import *`) so only these
 * icons reach the bundle.
 */

import {
  Activity,
  AlertTriangle,
  Bot,
  Calendar,
  Check,
  CircleCheck,
  Clock,
  Copy,
  Database,
  DollarSign,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Filter,
  Flag,
  Folder,
  GitBranch,
  Github,
  GitPullRequest,
  Info,
  Link,
  type LucideIcon,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Slack,
  Sparkles,
  Star,
  Tag,
  Trash2,
  TrendingDown,
  TrendingUp,
  Upload,
  User,
  Users,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { IconName } from "./icon-names";

export const CATALOG_ICONS: Record<IconName, LucideIcon> = {
  plus: Plus,
  "refresh-cw": RefreshCw,
  search: Search,
  filter: Filter,
  download: Download,
  upload: Upload,
  "external-link": ExternalLink,
  copy: Copy,
  check: Check,
  x: X,
  "trash-2": Trash2,
  pencil: Pencil,
  eye: Eye,
  calendar: Calendar,
  clock: Clock,
  user: User,
  users: Users,
  bot: Bot,
  "git-pull-request": GitPullRequest,
  "git-branch": GitBranch,
  github: Github,
  slack: Slack,
  mail: Mail,
  link: Link,
  "file-text": FileText,
  folder: Folder,
  database: Database,
  zap: Zap,
  sparkles: Sparkles,
  flag: Flag,
  star: Star,
  tag: Tag,
  "alert-triangle": AlertTriangle,
  info: Info,
  "circle-check": CircleCheck,
  "trending-up": TrendingUp,
  "trending-down": TrendingDown,
  "dollar-sign": DollarSign,
  activity: Activity,
  rocket: Rocket,
};

/** A name from app JSON → its icon. Unknown names (an old build) render nothing. */
export function catalogIcon(name: unknown): LucideIcon | undefined {
  return typeof name === "string" && Object.hasOwn(CATALOG_ICONS, name)
    ? CATALOG_ICONS[name as IconName]
    : undefined;
}

const iconSizeClass = { sm: "size-3.5", md: "size-4", lg: "size-5" } as const;

/**
 * Decorative (`aria-hidden`) unless `label` is set, in which case it is an
 * `img` with that accessible name.
 */
export function CatalogIcon({
  name,
  size = "md",
  label,
  className,
}: {
  name: unknown;
  size?: keyof typeof iconSizeClass;
  label?: string;
  className?: string;
}) {
  const Icon = catalogIcon(name);
  if (!Icon) return null;
  return label ? (
    <Icon
      role="img"
      aria-label={label}
      className={cn(iconSizeClass[size], "shrink-0", className)}
    />
  ) : (
    <Icon aria-hidden className={cn(iconSizeClass[size], "shrink-0", className)} />
  );
}
