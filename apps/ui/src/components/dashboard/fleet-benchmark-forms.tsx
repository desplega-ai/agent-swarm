/**
 * The two forms inside the fleet benchmark card.
 *
 * - `FleetUnlockFlow` (`basic` level): company context buys the peer-group
 *   comparison. The API reports `full` once the website, team size and use
 *   case are all set. The flow asks for what is missing, saves it as the
 *   company profile (`org.profile_updated {surface: fleet_benchmark}`), sends
 *   `fleet_benchmark.unlocked {fields}` and reloads the benchmark.
 * - `FleetReportForm` (`full` level): a request for the monthly report. An
 *   unchecked box, the work email, Subscribe. Nothing leaves the browser
 *   before Subscribe.
 */
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { useCompanyProfile } from "@/api/hooks/use-company-profile";
import { useSubscribeFleetReport } from "@/api/hooks/use-fleet-report";
import { useUiTelemetry } from "@/api/hooks/use-ui-telemetry";
import type { ApprovalQuestion } from "@/api/types";
import { FadeIn } from "@/components/shared/fade-in";
import { QuestionFlow, type QuestionFlowValues } from "@/components/shared/question-flow";
import { StatusLine } from "@/components/shared/status-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useDismissibleCard } from "@/hooks/use-dismissible-card";
import { optionValue, TEAM_SIZES, USE_CASES } from "@/lib/company-profile";
import { HomeCardDivider, HomeCardNote } from "./home-card";

type UnlockField = "website" | "team_size" | "use_case";
type CompanyProfile = ReturnType<typeof useCompanyProfile>;

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * The missing fields, pre-filled where we know a value. With nothing missing
 * (the card's data predates a Settings edit), all three, so Submit still
 * confirms them and reloads the benchmark.
 */
function unlockForm(profile: CompanyProfile) {
  const missing: UnlockField[] = [];
  if (!profile.website) missing.push("website");
  if (!profile.teamSize) missing.push("team_size");
  if (!profile.useCase) missing.push("use_case");
  const asked: UnlockField[] = missing.length > 0 ? missing : ["website", "team_size", "use_case"];
  const questions: ApprovalQuestion[] = [];
  const initialValues: QuestionFlowValues = {};
  if (asked.includes("website")) {
    const website = profile.website ?? profile.suggestedWebsite;
    questions.push({
      id: "website",
      type: "text",
      required: true,
      label: "Company website",
      description:
        !profile.website && profile.suggestedWebsite
          ? "From your admin email domain. The peer group needs it."
          : "The peer group needs it.",
      placeholder: "example.com",
    });
    if (website) initialValues.website = website;
  }
  if (asked.includes("team_size")) {
    questions.push({
      id: "team_size",
      type: "single-select",
      required: true,
      label: "How many people use this swarm?",
      options: [...TEAM_SIZES],
    });
    if (profile.teamSize) initialValues.team_size = profile.teamSize;
  }
  if (asked.includes("use_case")) {
    questions.push({
      id: "use_case",
      type: "single-select",
      required: true,
      label: "What does it mostly do?",
      options: [...USE_CASES],
    });
    if (profile.useCase) initialValues.use_case = profile.useCase;
  }
  return { asked, questions, initialValues };
}

export function FleetUnlockFlow({ onCancel }: { onCancel: () => void }) {
  const profile = useCompanyProfile();
  if (!profile.loaded) return <StatusLine tone="busy">Loading your company details…</StatusLine>;
  return <UnlockQuestions profile={profile} onCancel={onCancel} />;
}

function UnlockQuestions({ profile, onCancel }: { profile: CompanyProfile; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const track = useUiTelemetry();
  // Fixed on mount: a save that fills a field must not reshape the flow.
  const [form] = useState(() => unlockForm(profile));

  async function submit(values: QuestionFlowValues) {
    const { asked } = form;
    await profile.save(
      {
        ...(asked.includes("website") ? { website: text(values.website) } : {}),
        ...(asked.includes("team_size")
          ? { teamSize: optionValue(TEAM_SIZES, values.team_size) }
          : {}),
        ...(asked.includes("use_case") ? { useCase: optionValue(USE_CASES, values.use_case) } : {}),
      },
      "fleet_benchmark",
    );
    track({ event: "fleet_benchmark.unlocked", properties: { fields: asked } });
    await queryClient.invalidateQueries({ queryKey: ["fleet-benchmark"] });
  }

  return (
    <QuestionFlow
      questions={form.questions}
      initialValues={form.initialValues}
      footer={
        <div className="flex items-start justify-between gap-2">
          <HomeCardNote>
            Submit saves these to your swarm and sends them to Desplega with telemetry, to pick your
            peer group.
          </HomeCardNote>
          <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      }
      onSubmit={submit}
      // Shown once the reload settled: the card swaps in the peer group, or
      // shows the reload error with a Retry.
      done={() => <StatusLine tone="success">Saved.</StatusLine>}
    />
  );
}

export function FleetReportForm() {
  const { user } = useCurrentUser();
  const subscribe = useSubscribeFleetReport();
  // Set after a subscription, so this browser does not offer it again.
  const subscribed = useDismissibleCard("fleet-benchmark-report");
  const [email, setEmail] = useState(user?.email ?? "");
  const [monthly, setMonthly] = useState(false);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  if (sentTo) {
    return (
      <HomeCardDivider>
        <FadeIn>
          {/* No job sends the report yet: promise only the follow-up. */}
          <StatusLine tone="success">
            Request sent. We will email {sentTo} when the monthly report starts.
          </StatusLine>
        </FadeIn>
      </HomeCardDivider>
    );
  }
  if (subscribed.dismissed) return null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!monthly || sending) return;
    setSending(true);
    try {
      await subscribe(email);
      subscribed.dismiss();
      setSentTo(email.trim());
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : "Could not subscribe.");
    } finally {
      setSending(false);
    }
  }

  return (
    <HomeCardDivider>
      <form className="space-y-2" onSubmit={handleSubmit} aria-label="Monthly benchmark report">
        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            type="email"
            required
            aria-label="Email for the monthly report"
            placeholder="you@company.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="h-8 w-56 text-sm"
          />
          <Button type="submit" size="sm" disabled={!monthly || !email.trim() || sending}>
            {sending ? "Subscribing…" : "Subscribe"}
          </Button>
        </div>
        <label className="flex items-start gap-2 text-xs leading-relaxed">
          <input
            type="checkbox"
            checked={monthly}
            onChange={(event) => setMonthly(event.target.checked)}
            className="mt-0.5 size-4 rounded border-input accent-primary"
          />
          <span>
            Email me this report each month. Subscribe sends this email address and your swarm name
            to Desplega.
          </span>
        </label>
      </form>
    </HomeCardDivider>
  );
}
