import { ArrowLeft, ChevronDown, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useUpdateUser, useUser } from "@/api/hooks/use-users";
import type { User } from "@/api/types";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DetailPageBody,
  DetailPageRail,
  QuickStat,
  QuickStats,
} from "@/components/ui/detail-page-layout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelative } from "@/lib/relative-time";
import { cn, formatSmartTime } from "@/lib/utils";
import { IdentitiesTable } from "../identities-table";
import { getIntegrationLabel, IntegrationIcon } from "../integration-icons";
import { BudgetBadge, UserStatusPill } from "../user-status";
import { EventsTable } from "./events-table";
import { TokensTable } from "./tokens-table";

const STATUS_OPTIONS: Array<User["status"]> = ["invited", "active", "suspended"];
const ROLE_PRESETS: Array<{ value: string; label: string }> = [
  { value: "admin", label: "Admin" },
  { value: "editor", label: "Editor" },
  { value: "viewer", label: "Viewer" },
];
const CHANNEL_OPTIONS = [
  { value: "slack", label: "Slack" },
  { value: "email", label: "Email" },
  { value: "linear", label: "Linear" },
  { value: "github", label: "GitHub" },
  { value: "agentmail", label: "AgentMail" },
];

const TZ_DATALIST = [
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Madrid",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Australia/Sydney",
  "UTC",
];

/** Active tab values surfaced in `?tab=`. Unknown values fall back to "profile". */
type TabValue = "profile" | "identities" | "tokens" | "events";
const TAB_VALUES = new Set<TabValue>(["profile", "identities", "tokens", "events"]);
function coerceTab(raw: string | null): TabValue {
  return raw && (TAB_VALUES as Set<string>).has(raw) ? (raw as TabValue) : "profile";
}

interface ProfileDraft {
  name: string;
  email: string;
  role: string;
  emailAliases: string[];
  notes: string;
  status: User["status"];
  dailyBudgetUsdRaw: string;
  dailyBudgetUnlimited: boolean;
  preferredChannel: string;
  timezone: string;
}

function userToDraft(user: User): ProfileDraft {
  return {
    name: user.name,
    email: user.email ?? "",
    role: user.role ?? "",
    emailAliases: [...(user.emailAliases ?? [])],
    notes: user.notes ?? "",
    status: user.status,
    dailyBudgetUsdRaw: user.dailyBudgetUsd == null ? "" : user.dailyBudgetUsd.toString(),
    dailyBudgetUnlimited: user.dailyBudgetUsd == null,
    preferredChannel: user.preferredChannel || "slack",
    timezone: user.timezone ?? "",
  };
}

function draftDiff(
  user: User,
  draft: ProfileDraft,
): { changes: Record<string, unknown>; error: string | null } {
  const changes: Record<string, unknown> = {};
  if (draft.name.trim() !== user.name) changes.name = draft.name.trim();
  if ((draft.email.trim() || undefined) !== (user.email ?? undefined)) {
    changes.email = draft.email.trim() === "" ? undefined : draft.email.trim();
  }
  if ((draft.role.trim() || undefined) !== (user.role ?? undefined)) {
    changes.role = draft.role.trim() === "" ? undefined : draft.role.trim();
  }
  if ((draft.notes.trim() || undefined) !== (user.notes ?? undefined)) {
    changes.notes = draft.notes.trim() === "" ? undefined : draft.notes.trim();
  }
  // emailAliases — compare arrays case-sensitive after trim
  const beforeAliases = (user.emailAliases ?? []).slice().sort();
  const afterAliases = draft.emailAliases
    .map((a) => a.trim())
    .filter(Boolean)
    .slice()
    .sort();
  if (JSON.stringify(beforeAliases) !== JSON.stringify(afterAliases)) {
    changes.emailAliases = draft.emailAliases.map((a) => a.trim()).filter(Boolean);
  }
  if (draft.status !== user.status) changes.status = draft.status;
  // budget
  let budget: number | null = null;
  if (!draft.dailyBudgetUnlimited) {
    const parsed = Number.parseFloat(draft.dailyBudgetUsdRaw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { changes, error: "Budget must be a non-negative number" };
    }
    budget = parsed;
  }
  if ((user.dailyBudgetUsd ?? null) !== budget) changes.dailyBudgetUsd = budget;
  if ((draft.preferredChannel || "slack") !== (user.preferredChannel || "slack")) {
    changes.preferredChannel = draft.preferredChannel;
  }
  if ((draft.timezone.trim() || undefined) !== (user.timezone ?? undefined)) {
    changes.timezone = draft.timezone.trim() === "" ? undefined : draft.timezone.trim();
  }
  if (!draft.name.trim()) return { changes, error: "Name is required" };
  return { changes, error: null };
}

function RoleSelect({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const matchesPreset = ROLE_PRESETS.some((r) => r.value === search.trim().toLowerCase());
  const customRole = search.trim();

  const display =
    ROLE_PRESETS.find((r) => r.value === value)?.label ?? (value ? value : "Select a role");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-9 justify-between font-normal"
        >
          <span className={cn("capitalize", !value && "text-muted-foreground")}>{display}</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-50 ml-2" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-[220px] p-0" align="start">
        <Command>
          <CommandInput
            placeholder="Search or type a custom role…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>No preset matches.</CommandEmpty>
            <CommandGroup heading="Presets">
              {ROLE_PRESETS.map((r) => (
                <CommandItem
                  key={r.value}
                  value={r.label}
                  onSelect={() => {
                    onChange(r.value);
                    setOpen(false);
                    setSearch("");
                  }}
                >
                  {r.label}
                </CommandItem>
              ))}
            </CommandGroup>
            {customRole && !matchesPreset && (
              <CommandGroup heading="Custom">
                <CommandItem
                  value={`custom:${customRole}`}
                  onSelect={() => {
                    onChange(customRole);
                    setOpen(false);
                    setSearch("");
                  }}
                >
                  Use "{customRole}" as role
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ProfileCard({ user }: { user: User }) {
  const updateUser = useUpdateUser();
  const [draft, setDraft] = useState<ProfileDraft>(() => userToDraft(user));
  const [newAlias, setNewAlias] = useState("");

  // Re-seed when server-side user changes (e.g. after a save).
  useEffect(() => {
    setDraft(userToDraft(user));
  }, [user]);

  const { changes, error } = useMemo(() => draftDiff(user, draft), [user, draft]);
  const hasChanges = Object.keys(changes).length > 0;

  async function save() {
    if (error) {
      toast.error(error);
      return;
    }
    if (!hasChanges) return;
    try {
      await updateUser.mutateAsync({ id: user.id, data: changes });
      toast.success("Profile saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save profile");
    }
  }

  function reset() {
    setDraft(userToDraft(user));
    setNewAlias("");
  }

  function addAlias() {
    const value = newAlias.trim();
    if (!value || draft.emailAliases.includes(value)) {
      setNewAlias("");
      return;
    }
    setDraft((d) => ({ ...d, emailAliases: [...d.emailAliases, value] }));
    setNewAlias("");
  }

  function removeAlias(alias: string) {
    setDraft((d) => ({ ...d, emailAliases: d.emailAliases.filter((a) => a !== alias) }));
  }

  return (
    <Card>
      <CardContent className="p-5 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-tight">Profile</h2>
          {hasChanges && (
            <Badge
              variant="outline"
              size="tag"
              className="border-status-active/30 text-status-active-strong"
            >
              Unsaved changes
            </Badge>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-4">
          {/* LEFT COLUMN — identity, role, aliases. Notes moved to the
              full-width row below so its textarea can actually breathe. */}
          <div className="space-y-4">
            <Field label="Name" htmlFor="f-name" required>
              <Input
                id="f-name"
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="Jane Smith"
                className="h-9"
              />
            </Field>

            <Field label="Primary email" htmlFor="f-email">
              <Input
                id="f-email"
                type="email"
                value={draft.email}
                onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
                placeholder="jane@example.com"
                className="h-9 font-mono"
              />
            </Field>

            <Field
              label="Role"
              htmlFor="f-role"
              helper="Roles aren't enforced yet — informational only."
            >
              <RoleSelect
                value={draft.role}
                onChange={(role) => setDraft((d) => ({ ...d, role }))}
              />
            </Field>

            <Field label="Email aliases" htmlFor="f-alias">
              <div className="space-y-2">
                {draft.emailAliases.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {draft.emailAliases.map((alias) => (
                      <Badge
                        key={alias}
                        variant="outline"
                        className="font-mono gap-1 normal-case text-[11px] py-0 h-6"
                      >
                        <span>{alias}</span>
                        <button
                          type="button"
                          onClick={() => removeAlias(alias)}
                          className="text-muted-foreground hover:text-foreground"
                          aria-label="Remove alias"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <span className="text-xs italic text-muted-foreground/60">
                    No aliases. Add an alternate email below.
                  </span>
                )}
                <div className="flex items-center gap-1.5">
                  <Input
                    id="f-alias"
                    value={newAlias}
                    onChange={(e) => setNewAlias(e.target.value)}
                    placeholder="alias@example.com"
                    className="h-9 text-sm max-w-xs"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addAlias();
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={addAlias}
                    disabled={!newAlias.trim()}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Add
                  </Button>
                </div>
              </div>
            </Field>
          </div>

          {/* RIGHT COLUMN — operational settings (status / budget / channel / tz). */}
          <div className="space-y-4">
            <Field label="Status" htmlFor="f-status">
              <Select
                value={draft.status}
                onValueChange={(v) => setDraft((d) => ({ ...d, status: v as User["status"] }))}
              >
                <SelectTrigger id="f-status" className="h-9 capitalize">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s} className="capitalize">
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field
              label="Daily budget"
              htmlFor="f-budget"
              helper="Soft cap, enforced at task claim time for this user's MCP-created tasks."
            >
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <Switch
                    id="f-budget-unlimited"
                    checked={draft.dailyBudgetUnlimited}
                    onCheckedChange={(c) => setDraft((d) => ({ ...d, dailyBudgetUnlimited: c }))}
                  />
                  <Label htmlFor="f-budget-unlimited" className="text-xs">
                    Unlimited
                  </Label>
                </div>
                {!draft.dailyBudgetUnlimited && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground text-sm">$</span>
                    <Input
                      id="f-budget"
                      type="number"
                      step="0.01"
                      min="0"
                      value={draft.dailyBudgetUsdRaw}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, dailyBudgetUsdRaw: e.target.value }))
                      }
                      placeholder="5.00"
                      className="h-9 w-24 text-sm font-mono"
                    />
                    <span className="text-muted-foreground text-xs">/day</span>
                  </div>
                )}
              </div>
            </Field>

            <Field label="Preferred channel" htmlFor="f-channel">
              <Select
                value={draft.preferredChannel}
                onValueChange={(v) => setDraft((d) => ({ ...d, preferredChannel: v }))}
              >
                <SelectTrigger id="f-channel" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHANNEL_OPTIONS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      <div className="flex items-center gap-2">
                        <IntegrationIcon kind={c.value} className="h-4 w-4 text-foreground/70" />
                        <span>{c.label}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field
              label="Timezone"
              htmlFor="f-tz"
              helper="IANA tz string (e.g. America/New_York). Free-form."
            >
              <Input
                id="f-tz"
                value={draft.timezone}
                onChange={(e) => setDraft((d) => ({ ...d, timezone: e.target.value }))}
                placeholder="America/New_York"
                className="h-9 font-mono"
                list="people-tz-list"
              />
              <datalist id="people-tz-list">
                {TZ_DATALIST.map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
            </Field>
          </div>
        </div>

        {/* Full-width Notes row — pulled out of the left column so the
            textarea is wide enough to be useful. Min height covers ~5 lines;
            the textarea grows on user-resize and content overflow. */}
        <Field
          label="Notes"
          htmlFor="f-notes"
          helper="Free-form operator notes. Not shown to the user."
        >
          <Textarea
            id="f-notes"
            value={draft.notes}
            onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
            placeholder="On parental leave through June. Reach out via Slack DM, not email."
            className="min-h-[120px] text-sm resize-y"
          />
        </Field>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/40">
          {error && <span className="text-xs text-status-error-strong mr-auto">{error}</span>}
          <Button variant="outline" size="sm" onClick={reset} disabled={!hasChanges}>
            Discard
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={!hasChanges || !!error || updateUser.isPending}
          >
            {updateUser.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  htmlFor,
  helper,
  required,
  children,
}: {
  label: string;
  htmlFor?: string;
  helper?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
        {required && <span className="text-status-error-strong">*</span>}
      </Label>
      {children}
      {helper && <p className="text-[11px] text-muted-foreground/80">{helper}</p>}
    </div>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────────── */

export default function PersonDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: user, isLoading, error } = useUser(id);

  // Tabs are URL-driven (`?tab=profile|identities|events`) so deep-linking,
  // refresh, and shared screenshots all land on the right tab. Mirrors the
  // `?q=` pattern from the People list page (`replace: true` so back-button
  // pops out to `/people`, not through every tab switch).
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = coerceTab(searchParams.get("tab"));
  const setTab = useCallback(
    (next: string) => {
      setSearchParams(
        (current) => {
          const out = new URLSearchParams(current);
          if (next === "profile") out.delete("tab");
          else out.set("tab", next);
          return out;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const identitiesCount = useMemo(() => user?.identities?.length ?? 0, [user]);
  const aliasesCount = useMemo(() => user?.emailAliases?.length ?? 0, [user]);
  const tokensCount = useMemo(() => user?.tokens?.length ?? 0, [user]);

  if (isLoading) return <PageSkeleton />;

  if (error || !user) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => navigate("/people")}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to People
        </button>
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground">
            User not found.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3 overflow-hidden">
      <div className="shrink-0">
        <button
          type="button"
          onClick={() => navigate("/people")}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to People
        </button>
      </div>

      <div className="flex items-center gap-3 shrink-0 flex-wrap">
        <h1 className="text-2xl font-semibold tracking-tight">{user.name}</h1>
        <UserStatusPill status={user.status} />
        {user.email && (
          <span className="text-sm text-muted-foreground font-mono">{user.email}</span>
        )}
        {user.role && (
          <Badge variant="outline" size="tag" className="capitalize">
            {user.role}
          </Badge>
        )}
      </div>

      <Tabs value={tab} onValueChange={setTab} className="flex flex-col flex-1 min-h-0">
        <TabsList className="shrink-0">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="identities">
            Identities ({identitiesCount + aliasesCount})
          </TabsTrigger>
          <TabsTrigger value="tokens">Tokens ({tokensCount})</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="mt-4 overflow-y-auto">
          <DetailPageBody
            main={<ProfileCard user={user} />}
            rail={
              <DetailPageRail>
                <QuickStats>
                  <QuickStat label="Status" value={<UserStatusPill status={user.status} />} />
                  <QuickStat
                    label="Daily budget"
                    value={<BudgetBadge value={user.dailyBudgetUsd} />}
                  />
                  <QuickStat
                    label="Preferred channel"
                    value={
                      <div className="flex items-center gap-1.5">
                        <IntegrationIcon
                          kind={user.preferredChannel || "slack"}
                          className="h-3.5 w-3.5 text-foreground/70"
                        />
                        <span>{getIntegrationLabel(user.preferredChannel || "slack")}</span>
                      </div>
                    }
                  />
                  <QuickStat
                    label="Timezone"
                    value={
                      user.timezone ? (
                        <span className="font-mono text-xs">{user.timezone}</span>
                      ) : (
                        <span className="text-muted-foreground/60">—</span>
                      )
                    }
                  />
                  <QuickStat label="Identities" value={identitiesCount.toString()} />
                  <QuickStat label="Aliases" value={aliasesCount.toString()} />
                  <QuickStat
                    label="Joined"
                    value={
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>{formatRelative(user.createdAt)}</span>
                        </TooltipTrigger>
                        <TooltipContent className="font-mono text-[10px]">
                          {formatSmartTime(user.createdAt)}
                        </TooltipContent>
                      </Tooltip>
                    }
                  />
                  <QuickStat
                    label="Last update"
                    value={
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>{formatRelative(user.lastUpdatedAt)}</span>
                        </TooltipTrigger>
                        <TooltipContent className="font-mono text-[10px]">
                          {formatSmartTime(user.lastUpdatedAt)}
                        </TooltipContent>
                      </Tooltip>
                    }
                  />
                </QuickStats>
              </DetailPageRail>
            }
          />
        </TabsContent>

        <TabsContent value="identities" className="mt-4 overflow-y-auto">
          <Card>
            <CardContent className="p-4">
              <IdentitiesTable user={user} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tokens" className="mt-4 overflow-y-auto">
          <TokensTable user={user} />
        </TabsContent>

        <TabsContent value="events" className="mt-4 overflow-y-auto">
          <Card>
            <CardContent className="p-4">
              <EventsTable userId={user.id} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
