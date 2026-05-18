import { ArrowLeft, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  useAddUserIdentity,
  useRemoveUserIdentity,
  useUpdateUser,
  useUser,
  useUserEvents,
} from "@/api/hooks/use-users";
import type { User, UserIdentity } from "@/api/types";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DetailPageBody,
  DetailPageRail,
  QuickStat,
  QuickStats,
} from "@/components/ui/detail-page-layout";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DefinitionList, InfoRow } from "@/components/ui/info-row";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, formatRelativeTime, formatSmartTime } from "@/lib/utils";
import { IdentityBadge } from "../identity-badges";
import { BudgetBadge, EventIcon, UserStatusPill } from "../user-status";

const STATUS_OPTIONS: Array<User["status"]> = ["invited", "active", "suspended"];
const KIND_OPTIONS = ["slack", "linear", "github", "gitlab", "jira", "agentmail", "custom"];

function ProfileSection({ user }: { user: User }) {
  const updateUser = useUpdateUser();
  const [editingField, setEditingField] = useState<"name" | "email" | "role" | null>(null);
  const [draft, setDraft] = useState("");

  function start(field: "name" | "email" | "role") {
    setEditingField(field);
    setDraft((user[field] as string | undefined) ?? "");
  }

  async function save(field: "name" | "email" | "role") {
    const value = draft.trim();
    if (field === "name" && !value) {
      toast.error("Name is required");
      return;
    }
    try {
      await updateUser.mutateAsync({
        id: user.id,
        data: { [field]: value === "" ? undefined : value },
      });
      toast.success(`${field} updated`);
      setEditingField(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to update ${field}`);
    }
  }

  const EditField = ({
    field,
    label,
    value,
  }: {
    field: "name" | "email" | "role";
    label: string;
    value: string | undefined;
  }) => {
    const isEditing = editingField === field;
    return (
      <InfoRow label={label}>
        {isEditing ? (
          <div className="flex items-center gap-1.5">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="h-8 text-sm"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") save(field);
                if (e.key === "Escape") setEditingField(null);
              }}
            />
            <Button size="icon" variant="ghost" onClick={() => save(field)}>
              <Check className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => setEditingField(null)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <span className={cn(!value && "italic text-muted-foreground")}>
              {value || "Not set"}
            </span>
            <Button size="icon" variant="ghost" onClick={() => start(field)}>
              <Pencil className="h-3 w-3" />
            </Button>
          </div>
        )}
      </InfoRow>
    );
  };

  // Email aliases
  const [newAlias, setNewAlias] = useState("");
  async function addAlias() {
    const value = newAlias.trim();
    if (!value) return;
    const next = [...(user.emailAliases ?? []), value];
    try {
      await updateUser.mutateAsync({ id: user.id, data: { emailAliases: next } });
      toast.success("Alias added");
      setNewAlias("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add alias");
    }
  }
  async function removeAlias(alias: string) {
    const next = (user.emailAliases ?? []).filter((a) => a !== alias);
    try {
      await updateUser.mutateAsync({ id: user.id, data: { emailAliases: next } });
      toast.success("Alias removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove alias");
    }
  }

  return (
    <Card>
      <CardContent className="p-4">
        <DefinitionList>
          <EditField field="name" label="Name" value={user.name} />
          <EditField field="email" label="Primary email" value={user.email} />
          <EditField field="role" label="Role" value={user.role} />
          <InfoRow label="Email aliases">
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {(user.emailAliases ?? []).map((alias) => (
                  <Badge
                    key={alias}
                    variant="outline"
                    size="tag"
                    className="font-mono gap-1 normal-case"
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
                {(user.emailAliases ?? []).length === 0 && (
                  <span className="text-xs italic text-muted-foreground/50">No aliases</span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  value={newAlias}
                  onChange={(e) => setNewAlias(e.target.value)}
                  placeholder="alias@example.com"
                  className="h-8 text-sm max-w-xs"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addAlias();
                    }
                  }}
                />
                <Button size="sm" variant="outline" onClick={addAlias} disabled={!newAlias.trim()}>
                  <Plus className="h-3 w-3 mr-1" />
                  Add
                </Button>
              </div>
            </div>
          </InfoRow>
        </DefinitionList>
      </CardContent>
    </Card>
  );
}

function IdentitiesSection({ user }: { user: User }) {
  const addIdent = useAddUserIdentity();
  const removeIdent = useRemoveUserIdentity();
  const [open, setOpen] = useState(false);
  const [draftKind, setDraftKind] = useState("slack");
  const [draftId, setDraftId] = useState("");

  async function add() {
    const id = draftId.trim();
    if (!id) return;
    try {
      await addIdent.mutateAsync({
        id: user.id,
        identity: { kind: draftKind, externalId: id },
      });
      toast.success(`Identity ${draftKind}:${id} linked`);
      setDraftId("");
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to link identity");
    }
  }

  async function remove(ident: UserIdentity) {
    try {
      await removeIdent.mutateAsync({
        id: user.id,
        kind: ident.kind,
        externalId: ident.externalId,
      });
      toast.success("Identity removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove identity");
    }
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-muted-foreground">Identities</h3>
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <Plus className="h-3 w-3 mr-1" />
            Add identity
          </Button>
        </div>
        {(user.identities ?? []).length === 0 ? (
          <p className="text-xs italic text-muted-foreground/50">No identities linked.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {(user.identities ?? []).map((ident) => (
              <div
                key={`${ident.kind}:${ident.externalId}`}
                className="inline-flex items-center gap-1 rounded-md border border-border px-1 py-0.5"
              >
                <IdentityBadge identity={ident} showId />
                <Button
                  size="icon"
                  variant="destructive-outline"
                  className="h-6 w-6"
                  onClick={() => remove(ident)}
                  aria-label="Remove identity"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Add identity</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="space-y-1.5">
                <Label>Kind</Label>
                <Select value={draftKind} onValueChange={setDraftKind}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KIND_OPTIONS.map((k) => (
                      <SelectItem key={k} value={k}>
                        {k}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ident-external-id">External ID</Label>
                <Input
                  id="ident-external-id"
                  value={draftId}
                  onChange={(e) => setDraftId(e.target.value)}
                  placeholder="U12345…"
                  className="font-mono"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      add();
                    }
                  }}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={add} disabled={!draftId.trim() || addIdent.isPending}>
                {addIdent.isPending ? "Linking…" : "Link identity"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function BudgetSection({ user }: { user: User }) {
  const updateUser = useUpdateUser();
  const [unlimited, setUnlimited] = useState(user.dailyBudgetUsd == null);
  const [draft, setDraft] = useState(
    user.dailyBudgetUsd != null ? user.dailyBudgetUsd.toString() : "",
  );

  // Sync local state when the user prop changes (e.g. after a save).
  useEffect(() => {
    setUnlimited(user.dailyBudgetUsd == null);
    setDraft(user.dailyBudgetUsd != null ? user.dailyBudgetUsd.toString() : "");
  }, [user.dailyBudgetUsd]);

  async function save() {
    let value: number | null = null;
    if (!unlimited) {
      const parsed = Number.parseFloat(draft);
      if (!Number.isFinite(parsed) || parsed < 0) {
        toast.error("Budget must be a non-negative number");
        return;
      }
      value = parsed;
    }
    try {
      await updateUser.mutateAsync({ id: user.id, data: { dailyBudgetUsd: value } });
      toast.success("Budget updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update budget");
    }
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-muted-foreground">Daily budget</h3>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <BudgetBadge value={user.dailyBudgetUsd} />
              </span>
            </TooltipTrigger>
            <TooltipContent>Enforced once MCP user-tokens ship.</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch
              id="budget-unlimited"
              checked={unlimited}
              onCheckedChange={(checked) => setUnlimited(checked)}
            />
            <Label htmlFor="budget-unlimited" className="text-xs">
              Unlimited
            </Label>
          </div>
          {!unlimited && (
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground text-sm">$</span>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="5.00"
                className="h-8 w-24 text-sm font-mono"
              />
              <span className="text-muted-foreground text-xs">/day</span>
            </div>
          )}
          <Button size="sm" onClick={save} disabled={updateUser.isPending}>
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusSection({ user }: { user: User }) {
  const updateUser = useUpdateUser();
  const [draft, setDraft] = useState<User["status"]>(user.status);

  useEffect(() => {
    setDraft(user.status);
  }, [user.status]);

  async function save() {
    if (draft === user.status) return;
    try {
      await updateUser.mutateAsync({ id: user.id, data: { status: draft } });
      toast.success("Status updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update status");
    }
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-muted-foreground">Status</h3>
          <UserStatusPill status={user.status} />
        </div>
        <div className="flex items-center gap-2">
          <Select value={draft} onValueChange={(v) => setDraft(v as User["status"])}>
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={save} disabled={draft === user.status || updateUser.isPending}>
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function EventsTimeline({ userId }: { userId: string }) {
  const { data: events, isLoading } = useUserEvents(userId, { limit: 100 });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading events…</p>;
  if (!events || events.length === 0)
    return (
      <p className="text-sm italic text-muted-foreground py-4">
        No identity events yet — every mutation through the People page lands one here.
      </p>
    );

  return (
    <div className="space-y-1.5">
      {events.map((event) => {
        const beforeJson = event.before === null ? null : JSON.stringify(event.before, null, 2);
        const afterJson = event.after === null ? null : JSON.stringify(event.after, null, 2);
        const actorShort = event.actor.length > 14 ? `${event.actor.slice(0, 12)}…` : event.actor;
        return (
          <details
            key={event.id}
            className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs group"
          >
            <summary className="cursor-pointer flex items-center gap-2 list-none">
              <EventIcon eventType={event.eventType} />
              <span className="font-mono uppercase text-[10px] text-muted-foreground tracking-wide">
                {event.eventType.replaceAll("_", " ")}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="font-mono text-[10px] text-muted-foreground">{actorShort}</span>
                </TooltipTrigger>
                <TooltipContent className="font-mono text-[10px]">{event.actor}</TooltipContent>
              </Tooltip>
              <span className="flex-1" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-[10px] text-muted-foreground">
                    {formatRelativeTime(event.createdAt)}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="font-mono text-[10px]">{event.createdAt}</TooltipContent>
              </Tooltip>
            </summary>
            {(beforeJson || afterJson) && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2 pt-2 border-t border-border/50">
                <div>
                  <div className="text-[10px] uppercase text-muted-foreground mb-1">Before</div>
                  <pre className="font-mono text-[10px] leading-relaxed bg-background/50 p-2 rounded border border-border/40 overflow-auto max-h-48">
                    {beforeJson ?? "—"}
                  </pre>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-muted-foreground mb-1">After</div>
                  <pre className="font-mono text-[10px] leading-relaxed bg-background/50 p-2 rounded border border-border/40 overflow-auto max-h-48">
                    {afterJson ?? "—"}
                  </pre>
                </div>
              </div>
            )}
          </details>
        );
      })}
    </div>
  );
}

export default function PersonDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: user, isLoading, error } = useUser(id);
  const [tab, setTab] = useState("profile");

  const identitiesCount = useMemo(() => user?.identities?.length ?? 0, [user]);

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

      <div className="flex items-center gap-3 shrink-0">
        <h1 className="text-3xl font-bold tracking-tight">{user.name}</h1>
        <UserStatusPill status={user.status} />
        {user.email && (
          <span className="text-base text-muted-foreground font-mono">{user.email}</span>
        )}
      </div>

      <Tabs value={tab} onValueChange={setTab} className="flex flex-col flex-1 min-h-0">
        <TabsList className="shrink-0">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="identities">Identities ({identitiesCount})</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="mt-4 overflow-y-auto">
          <DetailPageBody
            main={
              <div className="space-y-3">
                <ProfileSection user={user} />
                <BudgetSection user={user} />
                <StatusSection user={user} />
              </div>
            }
            rail={
              <DetailPageRail>
                <QuickStats>
                  <QuickStat label="Status" value={user.status} />
                  <QuickStat
                    label="Daily budget"
                    value={
                      user.dailyBudgetUsd == null
                        ? "Unlimited"
                        : `$${user.dailyBudgetUsd.toFixed(2)}`
                    }
                  />
                  <QuickStat label="Identities" value={identitiesCount.toString()} />
                  <QuickStat label="Aliases" value={(user.emailAliases?.length ?? 0).toString()} />
                  <QuickStat label="Joined" value={formatSmartTime(user.createdAt)} />
                  <QuickStat label="Last update" value={formatSmartTime(user.lastUpdatedAt)} />
                </QuickStats>
              </DetailPageRail>
            }
          />
        </TabsContent>

        <TabsContent value="identities" className="mt-4 overflow-y-auto">
          <IdentitiesSection user={user} />
        </TabsContent>

        <TabsContent value="events" className="mt-4 overflow-y-auto">
          <Card>
            <CardContent className="p-4">
              <EventsTimeline userId={user.id} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
