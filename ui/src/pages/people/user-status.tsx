import {
  CircleAlert,
  CircleCheck,
  CircleDollarSign,
  CircleSlash,
  type LucideIcon,
  Mail,
  Pencil,
  ShieldCheck,
  ShieldOff,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import type { IdentityEventType, User } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<User["status"], { label: string; dot: string; text: string }> = {
  invited: {
    label: "INVITED",
    dot: "bg-status-pending",
    text: "text-status-pending-strong",
  },
  active: {
    label: "ACTIVE",
    dot: "bg-status-success",
    text: "text-status-success-strong",
  },
  suspended: {
    label: "SUSPENDED",
    dot: "bg-status-error",
    text: "text-status-error-strong",
  },
};

export function UserStatusPill({ status }: { status: User["status"] }) {
  const config = STATUS_STYLES[status] ?? {
    label: status,
    dot: "bg-status-neutral",
    text: "text-status-neutral",
  };
  return (
    <Badge
      variant="outline"
      className="gap-1.5 text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center"
    >
      <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", config.dot)} />
      <span className={config.text}>{config.label}</span>
    </Badge>
  );
}

/**
 * Render the per-user daily budget badge. `dailyBudgetUsd === null` /
 * `undefined` → "Unlimited". Tooltip text is owned by the caller (the People
 * list/detail wraps the badge in a `<Tooltip>` to surface the "Enforced once
 * MCP user-tokens ship" hint).
 */
export function BudgetBadge({ value }: { value: number | null | undefined }) {
  if (value == null) {
    return (
      <Badge
        variant="outline"
        size="tag"
        className="border-status-neutral/30 text-muted-foreground"
      >
        Unlimited
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      size="tag"
      className="border-status-active/30 bg-status-active/10 text-status-active-strong font-mono"
    >
      ${value.toFixed(2)}/day
    </Badge>
  );
}

/**
 * Icon mapping for the identity-event timeline.
 */
const EVENT_ICONS: Record<IdentityEventType, LucideIcon> = {
  auto_merge: Users,
  manual_merge: Users,
  identity_added: UserPlus,
  identity_removed: UserMinus,
  email_added: Mail,
  email_removed: Mail,
  token_minted: ShieldCheck,
  token_revoked: ShieldOff,
  budget_changed: CircleDollarSign,
  status_changed: CircleCheck,
  profile_changed: Pencil,
};

const EVENT_TONE: Record<IdentityEventType, string> = {
  auto_merge: "text-status-info-strong",
  manual_merge: "text-action-delegate-to-agent",
  identity_added: "text-status-success-strong",
  identity_removed: "text-status-error-strong",
  email_added: "text-status-success-strong",
  email_removed: "text-status-error-strong",
  token_minted: "text-status-active-strong",
  token_revoked: "text-status-error-strong",
  budget_changed: "text-status-active-strong",
  status_changed: "text-status-paused-strong",
  profile_changed: "text-muted-foreground",
};

export function EventIcon({ eventType }: { eventType: string }) {
  const Icon =
    EVENT_ICONS[eventType as IdentityEventType] ?? (eventType === "" ? CircleAlert : CircleSlash);
  const tone = EVENT_TONE[eventType as IdentityEventType] ?? "text-muted-foreground";
  return <Icon className={cn("h-3.5 w-3.5 shrink-0", tone)} />;
}

export function EventTypeLabel({ eventType }: { eventType: string }) {
  return (
    <span className="font-mono text-[10px] uppercase text-muted-foreground">
      {eventType.replaceAll("_", " ")}
    </span>
  );
}
