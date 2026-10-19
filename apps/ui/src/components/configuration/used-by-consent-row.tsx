import { Building2, Check, MessagesSquare } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useSetUsedByConsent } from "@/api/hooks/use-org-profile";
import type { ApprovalQuestion } from "@/api/types";
import { useStatusContext } from "@/app/status-context";
import { BorderBeam } from "@/components/shared/border-beam";
import { FadeIn } from "@/components/shared/fade-in";
import { QuestionFlow, type QuestionFlowValues } from "@/components/shared/question-flow";
import { SetupCard } from "@/components/shared/setup-card";
import { SetupChip } from "@/components/shared/setup-chip";
import { StatusLine } from "@/components/shared/status-icon";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useSlackConnectPerk } from "@/hooks/use-slack-connect-invite";
import { isTruthyConfigValue } from "@/hooks/use-swarm-config";
import { optionLabel, optionValue, USER_FUNCTIONS } from "@/lib/company-profile";
import { isAdminLike } from "@/lib/user-role";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const QUOTE_MAX = 280;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const featureQuestions = (company: string, inviteDone: boolean): ApprovalQuestion[] => [
  {
    id: "contact_email",
    type: "text",
    required: true,
    label: "Contact email",
    description: "Required for the listing. We write here about the logo and the shared channel.",
    placeholder: "you@company.com",
  },
  {
    id: "contact_function",
    type: "single-select",
    label: "Your role",
    description: "Shown next to your line, if you add one.",
    options: [...USER_FUNCTIONS],
  },
  {
    id: "quote",
    type: "text",
    multiline: true,
    label: "One line on how you use Agent Swarm",
    description: `Optional, up to ${QUOTE_MAX} characters. A person reviews it before anything is public.`,
    placeholder: "Our swarm reviews every PR before a human does.",
  },
  {
    id: "consent",
    type: "boolean",
    required: true,
    label: `Send these details to Desplega and list ${company} on agent-swarm.dev?`,
    description: inviteDone
      ? "Yes sends the organization name, website, contact email, and the optional role and line to Desplega, even with telemetry off. You already asked for the shared Slack channel, so Yes does not ask again. Turn the logo off here at any time to remove it."
      : "Yes sends the organization name, website, contact email, and the optional role and line to Desplega, even with telemetry off, and asks for the shared Slack channel. Turn the logo off here at any time to remove it.",
  },
];

/**
 * Settings > Branding: the revocable "used by" consent, offered as "Get
 * featured". The offer previews the logo in a Used by strip and names the
 * perks. A short flow asks for a contact email (required), a role and a
 * one-line quote (both optional), then an explicit yes. Only the yes sends
 * anything: `POST /api/used-by` tells the telemetry proxy (the API sends
 * `used_by.consent_changed`), and a person at Desplega approves each logo by
 * hand before anything public shows it. The Slack Connect request follows the
 * grant, unless this user already asked (the bell's inbox row is done).
 * Revoking needs no email. Both need config write rights (admins only), so
 * other users see the offer read-only.
 */
export function UsedByConsentRow() {
  const { data: configs } = useConfigs({ scope: "global" });
  const { data: status } = useStatusContext();
  const currentUser = useCurrentUser();
  const canWrite = isAdminLike(currentUser.user);
  const inviteDone = useSlackConnectPerk().done;
  const setConsent = useSetUsedByConsent();
  const value = (key: string) => configs?.find((entry) => entry.key === key)?.value.trim() || "";
  const granted = isTruthyConfigValue(value("SWARM_USED_BY_CONSENT"));
  const name = value("SWARM_ORG_NAME");
  const website = value("SWARM_ORG_WEBSITE");
  const ready = Boolean(name && website);
  const logoUrl = status?.identity.logo_url ?? null;
  /** The company name when the flow started; null shows the offer. */
  const [company, setCompany] = useState<string | null>(null);

  function revoke() {
    setCompany(null);
    setConsent.mutate(
      { granted: false },
      {
        onSuccess: () => toast.success("Removed. Your logo will come off agent-swarm.dev."),
        onError: (error) => toast.error(error.message),
      },
    );
  }

  const fn = optionLabel(USER_FUNCTIONS, value("SWARM_USED_BY_CONTACT_FUNCTION"));
  const quote = value("SWARM_USED_BY_QUOTE");
  // A secret row: the API masks the email for every reader.
  const hasContact = Boolean(value("SWARM_USED_BY_CONTACT_EMAIL"));

  return (
    <div id="setting-SWARM_USED_BY_CONSENT" className="scroll-mt-6 space-y-3 py-4">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Show our logo on agent-swarm.dev</span>
            <code className="font-mono text-[10px] text-muted-foreground select-text">
              SWARM_USED_BY_CONSENT
            </code>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {granted
              ? `On. A person at Desplega reviews the logo before it is public${hasContact ? " and writes to the contact email you gave" : ""}. ${canWrite ? "Turn it off" : "An admin can turn it off"} at any time to remove the logo.`
              : "List your organization as a company that uses Agent Swarm. Nothing is sent until you say yes at the end of the short form."}
          </p>
        </div>
        {granted ? (
          <Switch
            checked
            disabled={setConsent.isPending || !canWrite}
            onCheckedChange={(next) => {
              if (!next) revoke();
            }}
            aria-label="Show our logo on agent-swarm.dev"
          />
        ) : null}
      </div>
      <FadeIn key={granted ? "granted" : company ? "flow" : "offer"}>
        {granted ? (
          <LogoStrip
            name={name || "Your company"}
            logoUrl={logoUrl}
            caption={quote ? `"${quote}"${fn ? `, ${fn} at ${name}` : ""}` : undefined}
          />
        ) : company ? (
          <FeatureFlow company={company} inviteDone={inviteDone} onClose={() => setCompany(null)} />
        ) : (
          <SetupCard
            className="relative"
            icon={<Building2 className="size-4" aria-hidden="true" />}
            title={`Feature ${name || "your company"} on agent-swarm.dev`}
            description="A person reviews every logo before it is public."
            status={<SetupChip tone="info">Optional</SetupChip>}
            bodyClassName="space-y-3"
          >
            <BorderBeam className={ready && canWrite ? undefined : "opacity-0"} />
            <ul className="space-y-1 text-xs text-muted-foreground">
              <li className="flex items-center gap-1.5">
                <Check className="size-3 shrink-0 text-status-success-strong" aria-hidden="true" />
                Your logo and a link to {website || "your website"} in the Used by strip
              </li>
              <li className="flex items-center gap-1.5">
                <MessagesSquare
                  className="size-3 shrink-0 text-status-success-strong"
                  aria-hidden="true"
                />
                A shared Slack channel with the team that builds Agent Swarm
                {inviteDone ? " (already requested)" : ""}
              </li>
            </ul>
            <LogoStrip name={name || "Your company"} logoUrl={logoUrl} />
            {canWrite ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <Button
                  size="sm"
                  aria-disabled={!ready}
                  className="aria-disabled:opacity-50"
                  onClick={() => {
                    if (ready) setCompany(name);
                  }}
                >
                  Get featured
                </Button>
                {ready ? null : (
                  <span className="text-xs text-muted-foreground">
                    Set the organization name and company website above first.
                  </span>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Ask an admin to get {name || "your company"} featured. Only admins can send this
                request.
              </p>
            )}
          </SetupCard>
        )}
      </FadeIn>
    </div>
  );
}

function LogoStrip({
  name,
  logoUrl,
  caption,
}: {
  name: string;
  logoUrl: string | null;
  caption?: string;
}) {
  return (
    <div className="rounded-md border bg-background p-3">
      <p className="mb-2 text-meta font-medium uppercase tracking-wide text-muted-foreground">
        Preview: Used by
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {/* Stand-ins for the other logos in the strip. */}
        {["w-16", "w-20", "w-14"].map((width) => (
          <span key={width} aria-hidden="true" className={`h-7 ${width} rounded-md bg-muted`} />
        ))}
        <span className="flex h-7 items-center gap-1.5 rounded-md border border-primary/40 px-2 text-xs font-medium">
          <Avatar className="size-5 rounded-sm">
            {logoUrl ? <AvatarImage src={logoUrl} alt="" /> : null}
            <AvatarFallback className="rounded-sm text-meta">{name.charAt(0)}</AvatarFallback>
          </Avatar>
          {name}
        </span>
      </div>
      {caption ? <p className="mt-2 text-xs text-muted-foreground">{caption}</p> : null}
    </div>
  );
}

/** Built once per start, so editing the rows above never resets the flow. */
function FeatureFlow({
  company,
  inviteDone,
  onClose,
}: {
  company: string;
  /** This user already asked for the Slack channel (here, the bell or the org-name popup). */
  inviteDone: boolean;
  onClose: () => void;
}) {
  const { user } = useCurrentUser();
  const setConsent = useSetUsedByConsent();
  const slackPerk = useSlackConnectPerk();
  /** Set when the yes skipped the Slack request because an earlier one is in. */
  const [inviteSkipped, setInviteSkipped] = useState(false);
  const [form] = useState(() => {
    const initialValues: QuestionFlowValues = {};
    if (user?.email) initialValues.contact_email = user.email;
    const jobFunction = optionValue(USER_FUNCTIONS, user?.metadata?.jobFunction);
    if (jobFunction) initialValues.contact_function = jobFunction;
    return { questions: featureQuestions(company, inviteDone), initialValues };
  });

  async function submit(values: QuestionFlowValues) {
    if (values.consent !== true) return;
    const contactEmail = text(values.contact_email);
    if (!EMAIL_RE.test(contactEmail)) throw new Error("Enter a valid contact email.");
    const quote = text(values.quote);
    if (quote.length > QUOTE_MAX) {
      throw new Error(`Keep the line to ${QUOTE_MAX} characters (now ${quote.length}).`);
    }
    const contactFunction = optionValue(USER_FUNCTIONS, values.contact_function) ?? undefined;
    await setConsent.mutateAsync({
      granted: true,
      contactEmail,
      contactFunction,
      quote: quote || undefined,
    });
    toast.success("Thanks. We'll review your logo before it appears on agent-swarm.dev.");
    // The perk, once per user. The listing stands even if this request fails.
    if (inviteDone) {
      setInviteSkipped(true);
      return;
    }
    try {
      await slackPerk.request(
        contactEmail,
        contactFunction ? { user_function: contactFunction } : {},
      );
    } catch {
      toast.error("Could not ask for the Slack channel. We still review the logo.");
    }
  }

  return (
    <QuestionFlow
      questions={form.questions}
      initialValues={form.initialValues}
      footer={
        <div className="flex justify-end">
          <Button type="button" size="xs" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
      onSubmit={submit}
      done={(values) =>
        values.consent === true ? (
          <StatusLine tone="success">
            {inviteSkipped
              ? "Requested. A person reviews the logo first. Your Slack channel request was already in."
              : "Requested. A person reviews the logo first."}
          </StatusLine>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <StatusLine tone="success">Nothing was sent to Desplega.</StatusLine>
            <Button type="button" size="xs" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        )
      }
    />
  );
}
