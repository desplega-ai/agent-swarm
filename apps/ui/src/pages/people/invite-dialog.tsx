import {
  AlertCircle,
  AlertTriangle,
  Check,
  Copy,
  Eye,
  type LucideIcon,
  Send,
  ShieldCheck,
  SquarePen,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { InviteApiError } from "@/api/client";
import { useUpsertConfig } from "@/api/hooks/use-config-api";
import { useCreateInvite, useRbacRoles } from "@/api/hooks/use-users";
import type { CreateInviteResponse, InviteRole } from "@/api/types";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { inviteDestination } from "./invite-destination";

/** The three primary roles `POST /api/invites` accepts, from the most access to the least. */
const INVITE_ROLES: ReadonlyArray<{
  value: InviteRole;
  label: string;
  help: string;
  icon: LucideIcon;
}> = [
  { value: "admin", label: "Admin", help: "full control", icon: ShieldCheck },
  {
    value: "requester",
    label: "Requester",
    help: "creates and follows own tasks",
    icon: SquarePen,
  },
  { value: "viewer", label: "Viewer", help: "reads only", icon: Eye },
];

/** The role the form opens with. The API default stays Requester. */
const DEFAULT_ROLE: InviteRole = "admin";

function roleLabel(role: InviteRole): string {
  return INVITE_ROLES.find((r) => r.value === role)?.label ?? role;
}

/**
 * The API URL teammates reach: the link without its `/invite/<code>` tail (an API
 * under a path prefix keeps it), or the `swarm` param of an older link.
 */
function swarmOf(inviteUrl: string): string | null {
  try {
    const url = new URL(inviteUrl);
    const apiPath = url.pathname.replace(/\/invite\/[^/]+\/?$/, "");
    return url.searchParams.get("swarm") ?? `${url.origin}${apiPath}`;
  } catch {
    return null;
  }
}

function formatExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

interface InviteResult {
  invite: CreateInviteResponse;
  role: InviteRole;
}

/** Other words for the form stage, for a dialog that opens on its own (the first-task pop-up). */
export interface InviteDialogIntro {
  title: string;
  description: string;
  /** The label of the button that closes the form. Default "Cancel". */
  cancelLabel?: string;
}

/**
 * Invite a teammate: email, optional name, role. On success the one-time link
 * shows once, with a copy button. No email is sent: the admin sends the link.
 */
export function InviteDialog({
  open,
  onOpenChange,
  intro,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  intro?: InviteDialogIntro;
}) {
  const createInvite = useCreateInvite();
  const roles = useRbacRoles({ enabled: open });
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<InviteRole>(DEFAULT_ROLE);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InviteResult | null>(null);

  function reset() {
    setEmail("");
    setName("");
    setRole(DEFAULT_ROLE);
    setError(null);
    setResult(null);
    createInvite.reset();
  }

  function close(next: boolean) {
    onOpenChange(next);
    // The link is shown once: closing forgets it.
    if (!next) reset();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const address = email.trim();
    if (!address || createInvite.isPending) return;
    setError(null);
    try {
      const invite = await createInvite.mutateAsync({
        email: address,
        name: name.trim() || undefined,
        role,
      });
      setResult({ invite, role });
    } catch (err) {
      if (err instanceof InviteApiError && err.status === 409 && err.code === "user_exists") {
        setError(`${address} already has access.`);
      } else {
        setError(err instanceof Error ? err.message : "Could not create the invite.");
      }
    }
  }

  const description = (value: InviteRole) =>
    roles.data?.roles.find((r) => r.name === value)?.description ?? undefined;
  const selected = INVITE_ROLES.find((r) => r.value === role) ?? INVITE_ROLES[0];

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {result ? "Invite link ready" : (intro?.title ?? "Invite a teammate")}
          </DialogTitle>
          <DialogDescription>
            {result
              ? "Copy the link now. It is shown once."
              : (intro?.description ??
                "They get their own access to this swarm. No email is sent: you send the link.")}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <InviteLink result={result} />
        ) : (
          <form id="invite-form" className="space-y-4 py-1" onSubmit={submit}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="ada@example.com"
                  autoComplete="off"
                  required
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="invite-name">Name (optional)</Label>
                <Input
                  id="invite-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ada Lovelace"
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label id="invite-role-label">Role</Label>
              <SegmentedControl
                aria-labelledby="invite-role-label"
                value={role}
                onValueChange={setRole}
                options={INVITE_ROLES.map((r) => ({
                  value: r.value,
                  label: (
                    <>
                      <r.icon aria-hidden="true" />
                      {r.label}
                    </>
                  ),
                  tooltip: description(r.value),
                }))}
              />
              <p className="text-xs text-muted-foreground">
                {selected.label}: {selected.help}.
              </p>
            </div>
            {error ? (
              <AlertCallout tone="error" icon={AlertCircle}>
                {error}
              </AlertCallout>
            ) : null}
          </form>
        )}

        <DialogFooter>
          {result ? (
            <>
              <Button variant="outline" onClick={reset}>
                Invite another
              </Button>
              <Button onClick={() => close(false)}>Done</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => close(false)}>
                {intro?.cancelLabel ?? "Cancel"}
              </Button>
              <Button
                type="submit"
                form="invite-form"
                status={createInvite.isPending ? "loading" : "idle"}
                disabled={!email.trim()}
              >
                <Send />
                Create invite link
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteLink({ result }: { result: InviteResult }) {
  const { invite, role } = result;
  const { copied, copy } = useCopyToClipboard();
  const [copyFailed, setCopyFailed] = useState(false);
  const saveConfig = useUpsertConfig();
  const [saved, setSaved] = useState(false);
  const destination = inviteDestination(
    saved ? window.location.origin : invite.appUrl,
    window.location.origin,
  );
  const swarm = swarmOf(invite.inviteUrl);

  return (
    <div className="space-y-4 py-1">
      <div className="space-y-1.5">
        <Label htmlFor="invite-link">Invite link</Label>
        <div className="flex items-center gap-2">
          <Input
            id="invite-link"
            data-invite-link=""
            readOnly
            value={invite.inviteUrl}
            className="h-9 font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0"
            aria-label={copied ? "Copied" : "Copy invite link"}
            onClick={async () => setCopyFailed(!(await copy(invite.inviteUrl)))}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
        {destination ? (
          <p className="text-xs text-muted-foreground">Opens {destination.host}</p>
        ) : null}
        {copyFailed ? (
          <p className="text-xs text-status-error-strong">
            Could not copy. Select the link and copy it.
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Valid until {formatExpiry(invite.expiresAt)}, one use.
        </p>
      </div>
      {saved ? (
        <output className="block text-xs text-status-success-strong">
          Saved. The link now opens this dashboard.
        </output>
      ) : destination?.differentOrigin ? (
        <AlertCallout tone="warning" icon={AlertTriangle}>
          <p className="break-words">Teammates land on {invite.appUrl}, not on this dashboard.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={saveConfig.isPending}
            status={saveConfig.isPending ? "loading" : "idle"}
            onClick={() =>
              saveConfig.mutate(
                { scope: "global", key: "APP_URL", value: window.location.origin },
                { onSuccess: () => setSaved(true) },
              )
            }
          >
            Use this dashboard
          </Button>
        </AlertCallout>
      ) : null}
      {saveConfig.error ? (
        <AlertCallout tone="error" icon={AlertCircle}>
          {saveConfig.error.message}
        </AlertCallout>
      ) : null}
      <p className="text-sm">
        Anyone with this link joins as {roleLabel(role)}. Send it in a private message.
      </p>
      {invite.apiReachable === "local" ? (
        <AlertCallout tone="warning" icon={AlertTriangle}>
          Teammates cannot reach this swarm yet. It runs at{" "}
          <span className="font-mono">{swarm ?? "a local address"}</span>. Reinstall with{" "}
          <code className="font-mono">--tunnel</code> or put it behind a domain.
        </AlertCallout>
      ) : null}
    </div>
  );
}
