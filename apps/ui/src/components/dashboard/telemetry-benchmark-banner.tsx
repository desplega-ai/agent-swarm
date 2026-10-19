/**
 * The Home banner while telemetry is off, for admins: this swarm's last 30
 * days next to a locked fleet column. The local numbers come from
 * `GET /api/fleet-benchmark` (`local` in the `telemetry_off` state), computed
 * on this server with no proxy call. "Turn on telemetry" turns it on with the
 * click (`telemetry.enabled {via: banner}`), then asks what the benchmark
 * needs: the org name (required), the website and the team size, saved as the
 * company profile (`org.profile_updated {surface: telemetry_banner}`).
 * Telemetry stays on if the admin leaves the form.
 */
import { useQueryClient } from "@tanstack/react-query";
import { BarChart3, Check, Lock } from "lucide-react";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { useCompanyProfile } from "@/api/hooks/use-company-profile";
import { useFleetBenchmark } from "@/api/hooks/use-fleet-benchmark";
import { useEnableTelemetry } from "@/api/hooks/use-org-profile";
import type { ApprovalQuestion, FleetBenchmarkResponse } from "@/api/types";
import { useStatusContext } from "@/app/status-context";
import { QuestionFlow, type QuestionFlowValues } from "@/components/shared/question-flow";
import { StatusLine } from "@/components/shared/status-icon";
import { Button } from "@/components/ui/button";
import { optionValue, TEAM_SIZES } from "@/lib/company-profile";
import { fleetPeersLabel, formatFleetNumber } from "@/lib/fleet-benchmark";
import { HomeCard, HomeCardNote } from "./home-card";

const TITLE = "See how your swarm compares";
const TELEMETRY_DOCS_URL = "https://docs.agent-swarm.dev/docs/reference/telemetry";

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export function TelemetryBenchmarkBanner({
  onStart,
  onClose,
  onDismiss,
}: {
  /** Turn on was clicked: keep the banner mounted while telemetry flips on. */
  onStart: () => void;
  /** The profile step was closed or finished. */
  onClose: () => void;
  /** The X on the ask: the permanent dismissal. */
  onDismiss: () => void;
}) {
  const { data: status } = useStatusContext();
  const benchmark = useFleetBenchmark(Boolean(status));
  const enableTelemetry = useEnableTelemetry();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<"off" | "profile">("off");

  function turnOn() {
    onStart();
    enableTelemetry.mutate("banner", {
      onSuccess: () => {
        setStep("profile");
        void queryClient.invalidateQueries({ queryKey: ["fleet-benchmark"] });
      },
      onError: () => {
        onClose();
        toast.error("Could not turn telemetry on. Please try again.");
      },
    });
  }

  if (step === "profile") {
    return (
      <HomeCard
        icon={Check}
        title="Telemetry is on"
        onDismiss={() => {
          setStep("off");
          onClose();
        }}
        dismissLabel="Close the benchmark questions"
      >
        <ProfileStep benchmark={benchmark.data} />
      </HomeCard>
    );
  }

  const local = benchmark.data?.local ?? null;
  const minFinished = benchmark.data?.minFinishedTasks ?? 10;
  return (
    <HomeCard icon={BarChart3} title={TITLE} beam onDismiss={onDismiss}>
      <p className="text-sm text-muted-foreground">
        {local
          ? `Your last 30 days next to ${fleetPeersLabel(local.bucket ?? "all")}. Your numbers are computed on this server and stay here until you turn telemetry on.`
          : "Turn on telemetry to compare your swarm with similar swarms."}
      </p>
      {local ? (
        <div className="grid w-fit grid-cols-[auto_auto_auto] gap-x-6 gap-y-1 text-sm">
          <span />
          <span className="text-xs text-muted-foreground">You</span>
          <span className="text-xs text-muted-foreground">Similar swarms</span>
          {(
            [
              ["Tasks per week", formatFleetNumber("tasksPerWeek", local.tasksPerWeek)],
              [
                "Task success",
                local.taskSuccessRate === null
                  ? "No finished tasks"
                  : formatFleetNumber("taskSuccessRate", local.taskSuccessRate),
              ],
            ] as const
          ).map(([metric, value]) => (
            <Fragment key={metric}>
              <span className="text-muted-foreground">{metric}</span>
              <span className="font-mono font-medium tabular-nums">{value}</span>
              <span className="flex items-center gap-1 text-muted-foreground">
                <Lock className="size-3" aria-hidden="true" /> Hidden
              </span>
            </Fragment>
          ))}
        </div>
      ) : null}
      {local && local.finishedTasks < minFinished ? (
        <HomeCardNote>
          The comparison starts at {minFinished} finished tasks in 30 days ({local.finishedTasks} so
          far).
        </HomeCardNote>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button size="sm" disabled={enableTelemetry.isPending} onClick={turnOn}>
          {enableTelemetry.isPending ? "Turning on…" : "Turn on telemetry"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Telemetry turns on with this click. It sends usage counts, never prompts or code.{" "}
          <a
            href={TELEMETRY_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            What we collect
          </a>
        </span>
      </div>
    </HomeCard>
  );
}

/** What the benchmark needs, asked right after the opt-in. */
function ProfileStep({ benchmark }: { benchmark: FleetBenchmarkResponse | undefined }) {
  const profile = useCompanyProfile();
  if (!profile.loaded) return <StatusLine tone="busy">Loading your company details…</StatusLine>;
  return <ProfileQuestions profile={profile} benchmark={benchmark} />;
}

function ProfileQuestions({
  profile,
  benchmark,
}: {
  profile: ReturnType<typeof useCompanyProfile>;
  benchmark: FleetBenchmarkResponse | undefined;
}) {
  const queryClient = useQueryClient();
  // Built once: initial values are read on mount only.
  const [form] = useState(() => {
    const suggestedFrom = profile.name ? null : (profile.website ?? profile.suggestedWebsite);
    const questions: ApprovalQuestion[] = [
      {
        id: "org_name",
        type: "text",
        required: true,
        label: "Organization name",
        description: `${suggestedFrom && profile.suggestedName ? `Suggested from ${suggestedFrom}. ` : ""}The benchmark needs it. Other swarms never see it.`,
        placeholder: "Acme",
      },
      {
        id: "website",
        type: "text",
        label: "Company website",
        description: "The dashboard shows this site's logo.",
        placeholder: "example.com",
      },
      {
        id: "team_size",
        type: "single-select",
        label: "How many people work with the swarm?",
        description: "The benchmark card uses it to find teams your size.",
        options: [...TEAM_SIZES],
      },
    ];
    const initialValues: QuestionFlowValues = {};
    const name = profile.name ?? profile.suggestedName;
    const website = profile.website ?? profile.suggestedWebsite;
    if (name) initialValues.org_name = name;
    if (website) initialValues.website = website;
    if (profile.teamSize) initialValues.team_size = profile.teamSize;
    return { questions, initialValues };
  });

  const [saved, setSaved] = useState(false);

  async function submit(values: QuestionFlowValues) {
    await profile.save(
      {
        name: text(values.org_name),
        website: text(values.website),
        teamSize: optionValue(TEAM_SIZES, values.team_size) ?? undefined,
      },
      "telemetry_banner",
    );
    await queryClient.invalidateQueries({ queryKey: ["fleet-benchmark"] });
    setSaved(true);
  }

  const state = benchmark?.state;
  return (
    <>
      {saved ? null : (
        <p className="text-sm text-muted-foreground">
          One step to your benchmark: it needs your organization name. The rest is optional.
        </p>
      )}
      <QuestionFlow
        questions={form.questions}
        initialValues={form.initialValues}
        footer={<HomeCardNote>Telemetry stays on even if you leave this form.</HomeCardNote>}
        onSubmit={submit}
        done={() => (
          <StatusLine tone="success">
            {state === "ready" || state === "not_enough_tasks"
              ? "Saved. The benchmark card below shows where you stand."
              : "Saved. The comparison shows here as soon as it is available."}
          </StatusLine>
        )}
      />
    </>
  );
}
