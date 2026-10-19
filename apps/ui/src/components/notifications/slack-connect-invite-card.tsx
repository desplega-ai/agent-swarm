import { AlertTriangle, ExternalLink, MessagesSquare, Workflow } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useCompanyProfile } from "@/api/hooks/use-company-profile";
import { useNotificationEvents } from "@/api/hooks/use-notification-events";
import { useUiTelemetry } from "@/api/hooks/use-ui-telemetry";
import type { ApprovalQuestion, InboxItemState, SlackConnectMoment } from "@/api/types";
import { BorderBeam } from "@/components/shared/border-beam";
import { QuestionFlow, type QuestionFlowValues } from "@/components/shared/question-flow";
import { SetupCard } from "@/components/shared/setup-card";
import { SetupChip } from "@/components/shared/setup-chip";
import { StatusLine } from "@/components/shared/status-icon";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/contexts/current-user-context";
import {
  useRequestSlackConnectInvite,
  useSlackConnectInvite,
} from "@/hooks/use-slack-connect-invite";
import {
  domainOf,
  isFreemail,
  optionValue,
  TEAM_SIZES,
  USER_FUNCTIONS,
  type UserFunction,
} from "@/lib/company-profile";
import type { NotificationDefinition } from "@/lib/notifications/definitions";

const KICKOFF_URL = "https://calendar.app.google/R1ngNwcjs4vrJDk96";
const FREEMAIL_HINT = "Use the email of your company Slack, so the invite reaches your workspace.";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** The proxy keeps at most this many characters of `working_on`. */
const WORKING_ON_MAX = 500;

/** Copy per moment. `default` uses the definition's own title and body. */
const MOMENT_COPY: Record<
  Exclude<SlackConnectMoment, "default">,
  { icon: ReactNode; title: string; body: string }
> = {
  task_failed: {
    icon: <AlertTriangle className="size-4" />,
    title: "A task failed. Want a hand?",
    body: "Open a shared Slack channel, and we look at the failure with you. We reply within a business day.",
  },
  first_workflow: {
    icon: <Workflow className="size-4" />,
    title: "Your first workflow ran",
    body: "Show the team what you built, and ask what to automate next, in a shared Slack channel.",
  },
};

const PREPARE_QUESTIONS: ApprovalQuestion[] = [
  {
    id: "team_size",
    type: "single-select",
    label: "How many people work with this swarm?",
    options: [...TEAM_SIZES],
  },
  {
    id: "working_on",
    type: "text",
    label: "What are you working on?",
    description: "Submit adds this to your request. It goes to Desplega.",
    placeholder: "For example: PR reviews for 3 repos",
  },
];

interface SentRequest {
  email: string;
  userFunction: UserFunction | null;
  submissionId: string;
}

/**
 * The Slack Connect invite in the bell. Its copy follows the moment (a recent
 * failed task, a first workflow run, else the plain invite). The first Submit
 * sends the request; an optional second set updates the same submission.
 */
export function SlackConnectInviteCard({
  definition,
  state,
  moment: pinnedMoment,
}: {
  definition: NotificationDefinition;
  state?: InboxItemState;
  /**
   * Pinned by the bell while it is open.
   * Null while it loads: the plain copy shows and the events carry no moment.
   */
  moment?: SlackConnectMoment | null;
}) {
  const moment = pinnedMoment ?? undefined;
  const currentUser = useCurrentUser();
  const profile = useCompanyProfile();
  const invite = useSlackConnectInvite(definition.key, moment);
  const requestInvite = useRequestSlackConnectInvite();
  const { trackEvent } = useNotificationEvents();
  const sendEvent = useUiTelemetry();
  const profileEmail = currentUser.user?.email ?? "";
  const [email, setEmail] = useState(profileEmail);
  // Set before the send, so the inbox row turning "done" does not swap this card out.
  const [request, setRequest] = useState<SentRequest | null>(null);

  const status = request ? null : state?.status;
  if (status === "dismissed" || status === "done") {
    return (
      <SetupCard
        icon={<MessagesSquare className="size-4" />}
        title={definition.title}
        status={<SetupChip>{status === "dismissed" ? "Dismissed" : "Requested"}</SetupChip>}
      >
        <StatusLine tone="saved" className="text-xs text-muted-foreground">
          {status === "dismissed"
            ? "Dismissed. A later moment does not bring it back."
            : "Invite requested. The team replies by email."}
        </StatusLine>
      </SetupCard>
    );
  }

  const copy =
    !moment || moment === "default"
      ? {
          icon: <MessagesSquare className="size-4" />,
          title: definition.title,
          body: definition.body,
        }
      : MOMENT_COPY[moment];
  const emailLead = isFreemail(email)
    ? FREEMAIL_HINT
    : profileEmail && email === profileEmail
      ? "Pre-filled from your profile."
      : null;
  const requestQuestions: ApprovalQuestion[] = [
    {
      id: "email",
      type: "text",
      required: true,
      label: "Work email",
      placeholder: "you@company.com",
      description: `${emailLead ? `${emailLead} ` : ""}Submit sends it, your swarm name and any role you pick to Desplega.`,
    },
    {
      id: "user_function",
      type: "single-select",
      label: "Your role",
      options: [...USER_FUNCTIONS],
    },
  ];

  // Only known answers: a pre-filled empty value would flag a required card at once.
  const storedFunction = optionValue(USER_FUNCTIONS, currentUser.user?.metadata?.jobFunction);
  const initialRequest: QuestionFlowValues = {
    ...(profileEmail ? { email: profileEmail } : {}),
    ...(storedFunction ? { user_function: storedFunction } : {}),
  };

  async function submitRequest(values: QuestionFlowValues) {
    const value = String(values.email ?? "").trim();
    if (!EMAIL_PATTERN.test(value)) throw new Error("Enter a valid work email.");
    // Optional: an unset role stays out of the request and the event.
    const userFunction = optionValue(USER_FUNCTIONS, values.user_function);
    const role = userFunction ? { user_function: userFunction } : {};
    const sent = { email: value, userFunction, submissionId: crypto.randomUUID() };
    setRequest(sent);
    try {
      await requestInvite(value, { submission_id: sent.submissionId, moment, ...role });
    } catch (error) {
      setRequest(null);
      throw error;
    }
    trackEvent(definition.key, "submit", {
      email_domain: domainOf(value) ?? undefined,
      moment,
      ...role,
    });
  }

  async function submitPrepare(values: QuestionFlowValues) {
    if (!request) return;
    const teamSize = optionValue(TEAM_SIZES, values.team_size);
    const workingOn = String(values.working_on ?? "").trim();
    if (workingOn.length > WORKING_ON_MAX) {
      throw new Error(`Keep it under ${WORKING_ON_MAX} characters.`);
    }
    if (!teamSize && !workingOn) return;
    await requestInvite(request.email, {
      submission_id: request.submissionId,
      moment,
      ...(request.userFunction ? { user_function: request.userFunction } : {}),
      team_size: teamSize ?? undefined,
      working_on: workingOn || undefined,
    });
  }

  return (
    <SetupCard
      className="relative"
      icon={copy.icon}
      title={copy.title}
      description={copy.body}
      bodyClassName="space-y-3"
    >
      <BorderBeam className={request ? "rounded-xl opacity-0" : "rounded-xl"} />
      <QuestionFlow
        questions={requestQuestions}
        initialValues={initialRequest}
        onChange={(values) => setEmail(String(values.email ?? "").trim())}
        onSubmit={submitRequest}
        footer={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={invite.dismiss}
          >
            Dismiss
          </Button>
        }
        done={() => (
          <div className="space-y-3">
            <StatusLine tone="success">
              Requested. We invite {request?.email} within a business day.
            </StatusLine>
            <p className="text-xs text-muted-foreground">
              Help us prepare (optional): two answers make the first reply useful.
            </p>
            <QuestionFlow
              questions={PREPARE_QUESTIONS}
              initialValues={profile.teamSize ? { team_size: profile.teamSize } : {}}
              onSubmit={submitPrepare}
              done={() => (
                <div className="space-y-2">
                  <StatusLine tone="success">Thanks. The team reads this first.</StatusLine>
                  <Button asChild variant="outline" size="sm">
                    <a
                      href={KICKOFF_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() =>
                        sendEvent({
                          event: "feature.used",
                          properties: { feature: "kickoff_call_opened" },
                        })
                      }
                    >
                      Book a kickoff call
                      <ExternalLink aria-hidden="true" />
                    </a>
                  </Button>
                </div>
              )}
            />
          </div>
        )}
      />
    </SetupCard>
  );
}
