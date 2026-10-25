import { AlertCircle, RotateCw, UserCircle2 } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { toast } from "sonner";
import { useStatus } from "@/api/hooks/use-status";
import { sendUiTelemetry } from "@/api/hooks/use-ui-telemetry";
import { useCreateUser, useUpdateUser, useUsers } from "@/api/hooks/use-users";
import type { ApprovalQuestion, User } from "@/api/types";
import { Spinner } from "@/components/kibo-ui/spinner";
import { FadeIn } from "@/components/shared/fade-in";
import { QuestionFlow, type QuestionFlowValues } from "@/components/shared/question-flow";
import { useFinePointer } from "@/components/shared/questions/keyboard";
import { OptionChoices } from "@/components/shared/questions/question-field";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsRow } from "@/components/ui/settings-row";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useContinueAction, useContinueBlocker } from "@/hooks/use-autosave";
import { useConfig } from "@/hooks/use-config";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { isTypingTarget } from "@/lib/approval-shortcuts";
import {
  companyDomain,
  domainOf,
  isFreemail,
  isValidEmail,
  nameFromEmail,
  optionValue,
  USER_FUNCTIONS,
} from "@/lib/company-profile";
import { normalizeOrgWebsite } from "../../../../../src/utils/org-website";

/**
 * An outer primary button submits the form (the `/setup` footer Continue).
 * Local types: components never import from `pages/`.
 */
export interface IdentityContinue {
  /** Offer `submit` as the outer Continue action, or remove it (null). */
  setAction: (submit: (() => Promise<void>) | null) => void;
  /** Why the answers cannot go yet, or null when Continue can submit them. */
  setHold: (reason: string | null) => void;
}

const NO_ACTION: IdentityContinue["setAction"] = () => {};
const NO_HOLD: IdentityContinue["setHold"] = () => {};

type Stage =
  | { kind: "email" }
  | { kind: "match"; user: User }
  | { kind: "details"; askWebsite: boolean }
  | { kind: "list" }
  | { kind: "add-email"; user: User };

/** Case-insensitive match on the email and the email aliases (like `?email=` auto-bind). */
function findByEmail(users: User[], email: string): User | undefined {
  const value = email.trim().toLowerCase();
  return users.find(
    (u) =>
      u.email?.toLowerCase() === value || u.emailAliases.some((a) => a.toLowerCase() === value),
  );
}

function emailHint(email: string): string {
  const company = companyDomain(email);
  if (company) return `Work address at ${company}. Stays on this swarm.`;
  if (domainOf(email)) return "A personal address works. Stays on this swarm.";
  return "Stays on this swarm. With anonymous telemetry on, at most its domain is shared.";
}

const JOB_FUNCTION_QUESTION: ApprovalQuestion = {
  id: "jobFunction",
  type: "single-select",
  label: "What do you work on?",
  description: "Tunes the first tasks the swarm suggests to you.",
  required: true,
  options: [...USER_FUNCTIONS],
};

function detailQuestions(askWebsite: boolean): ApprovalQuestion[] {
  return [
    { id: "name", type: "text", label: "Your name", required: true, placeholder: "Ada Lovelace" },
    JOB_FUNCTION_QUESTION,
    ...(askWebsite
      ? [
          {
            id: "website",
            type: "text",
            label: "Your company website",
            description:
              "You used a personal address. Your company site gives your swarm its name and logo.",
            placeholder: "acme.com",
          } satisfies ApprovalQuestion,
        ]
      : []),
  ];
}

function EmailInput({
  id,
  value,
  onChange,
  error,
  autoFocus,
  helper,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  autoFocus?: boolean;
  helper: string;
}) {
  return (
    <SettingsRow
      label="Email"
      htmlFor={id}
      required
      helper={error ? <span className="text-status-error-strong">{error}</span> : helper}
    >
      <Input
        id={id}
        type="email"
        autoComplete="email"
        autoFocus={autoFocus}
        placeholder="ada@acme.com"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
      />
    </SettingsRow>
  );
}

/**
 * "Who are you?": one email field finds the user on this swarm (email or
 * alias), or starts a short question flow that creates one (name, a required
 * job function, and for a personal address an optional company website).
 * Users with no email on record are picked from a list and must add one. On
 * finish the user's id goes into `CurrentUserContext` via `setUserId`, then
 * `onDone` runs. Shared by the identity modal and the inline picker on
 * `/setup` (step 1, and step 7 as a fallback). It sends telemetry through
 * `/status` directly, because `/setup` has no `StatusProvider`.
 */
export function IdentityForm({
  surface,
  autoFocus = true,
  onDone,
  saveCompanyWebsite,
  continueWith,
}: {
  /** The `surface` of `identity.user_created`. */
  surface: "identity_modal" | "setup";
  autoFocus?: boolean;
  /** Called after a user is picked or created (also when the pick did not change). */
  onDone?: () => void;
  /**
   * Stores the company website a personal-address user gives. Pass it only
   * while the swarm has no website: the create flow then asks for one.
   * Not asked with `continueWith`.
   */
  saveCompanyWebsite?: (website: string) => Promise<void>;
  /**
   * An outer Continue submits the answers (`/setup` step 1). The form is then
   * one flat set of fields with no buttons of its own: the email, and for an
   * address with no user yet, the name and the job function (1-9 pick it).
   */
  continueWith?: IdentityContinue;
}) {
  const { setUserId, user: currentUser } = useCurrentUser();
  const { pendingIdentity, clearPendingIdentity } = useConfig();
  const { data: status } = useStatus({ pollIntervalMs: 0 });
  const usersQuery = useUsers();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const [chosenStage, setStage] = useState<Stage | null>(null);
  // A remembered user with no email on record adds one first.
  const stage: Stage =
    chosenStage ??
    (currentUser && !currentUser.email
      ? { kind: "add-email", user: currentUser }
      : { kind: "email" });
  const [email, setEmail] = useState(pendingIdentity?.email ?? "");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [addedEmail, setAddedEmail] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  // `continueWith` mode: the name follows the email until it is edited (null).
  const [name, setName] = useState<string | null>(null);
  const [jobFunction, setJobFunction] = useState<string | null>(null);
  // Enter in a field: show what is missing.
  const [attempted, setAttempted] = useState(false);
  const finePointer = useFinePointer();
  // The name fields wait for a typing pause, so they do not flash in and out
  // while a returning user types their address.
  const settledEmail = useDebouncedValue(email, 400);

  const users = usersQuery.data ?? [];

  function pick(id: string) {
    setUserId(id);
    clearPendingIdentity();
    onDone?.();
  }

  function restart() {
    setStage({ kind: "email" });
    setEmailError(null);
  }

  function lookUp(event: FormEvent) {
    event.preventDefault();
    // Only a loaded list can say "no match".
    if (!usersQuery.data) return;
    if (!isValidEmail(email)) {
      setEmailError("Enter a valid email, such as ada@acme.com.");
      return;
    }
    setEmailError(null);
    const match = findByEmail(users, email);
    sendUiTelemetry(status, { event: "identity.lookup", properties: { matched: Boolean(match) } });
    setStage(
      match
        ? { kind: "match", user: match }
        : {
            kind: "details",
            askWebsite: companyDomain(email) === null && saveCompanyWebsite !== undefined,
          },
    );
  }

  async function create(values: QuestionFlowValues) {
    const name = String(values.name ?? "").trim();
    const jobFunction = optionValue(USER_FUNCTIONS, values.jobFunction);
    const websiteInput = String(values.website ?? "").trim();
    const website = websiteInput ? normalizeOrgWebsite(websiteInput) : null;
    if (!name || !jobFunction) throw new Error("Answer the required questions.");
    if (websiteInput && !website) {
      throw new Error("Enter a public website, such as example.com, or clear it.");
    }
    // The job function lives in metadata: `users.role` stays empty, so the
    // user keeps the admin-level prompts (`isAdminLike`).
    const user = await createUser.mutateAsync({
      name,
      email: email.trim(),
      metadata: { jobFunction },
    });
    let savedWebsite = false;
    if (website && saveCompanyWebsite) {
      // The user exists now: a failed website write must not block sign-in.
      try {
        await saveCompanyWebsite(website);
        savedWebsite = true;
      } catch {
        toast.error("You are signed in. The website did not save: add it in Settings.");
      }
    }
    sendUiTelemetry(status, {
      event: "identity.user_created",
      properties: {
        surface,
        email_kind: isFreemail(email) ? "personal" : "work",
        has_function: true,
        // We know the company: from a work address, or from the website given here.
        has_company: companyDomain(email) !== null || savedWebsite,
      },
    });
    pick(user.id);
  }

  async function addEmail(event: FormEvent, user: User) {
    event.preventDefault();
    const value = addedEmail.trim();
    if (!usersQuery.data) return;
    if (!isValidEmail(value)) {
      setAddError("Enter a valid email, such as ada@acme.com.");
      return;
    }
    const owner = findByEmail(users, value);
    if (owner && owner.id !== user.id) {
      setAddError(`That email belongs to ${owner.name}.`);
      return;
    }
    setAddError(null);
    try {
      await updateUser.mutateAsync({ id: user.id, data: { email: value } });
      pick(user.id);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Could not save the email.");
    }
  }

  // `continueWith` mode: one flat form that the outer Continue submits.
  const flat = continueWith !== undefined;
  const match = isValidEmail(email) ? findByEmail(users, email) : undefined;
  const nameValue = name ?? (pendingIdentity?.name?.trim() || nameFromEmail(email));
  // A swarm with no users always creates one. Else ask once the address finds
  // nobody: after a typing pause, or at once on Enter.
  const unmatched = (value: string) => isValidEmail(value) && !findByEmail(users, value);
  const asksDetails =
    users.length === 0 || (unmatched(email) && (attempted || unmatched(settledEmail)));
  const emailProblem = !email.trim()
    ? "Enter your email."
    : !isValidEmail(email)
      ? "Enter a valid email, such as ada@acme.com."
      : null;
  const hold =
    stage.kind === "list"
      ? "Pick your user from the list."
      : stage.kind === "add-email"
        ? "Add an email to continue."
        : !usersQuery.data
          ? usersQuery.isPending
            ? "Loading users…"
            : "Could not load the users on this swarm."
          : (emailProblem ??
            (match
              ? null
              : !nameValue.trim()
                ? "Enter your name."
                : !jobFunction
                  ? "Pick what you work on."
                  : null));

  async function submitFlat() {
    const found = findByEmail(users, email);
    sendUiTelemetry(status, { event: "identity.lookup", properties: { matched: Boolean(found) } });
    if (found) {
      pick(found.id);
      return;
    }
    await create({ name: nameValue, jobFunction });
  }

  useContinueAction(
    continueWith?.setAction ?? NO_ACTION,
    flat && hold === null ? submitFlat : null,
  );
  useContinueBlocker(continueWith?.setHold ?? NO_HOLD, flat ? hold : null);

  function onFlatKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) setAttempted(true);
    // 1-9 pick the job function while focus is outside a text field.
    const option = /^[1-9]$/.test(event.key) ? USER_FUNCTIONS[Number(event.key) - 1] : undefined;
    if (!asksDetails || !option || event.altKey || event.ctrlKey || event.metaKey) return;
    if (isTypingTarget(event.target)) return;
    event.preventDefault();
    setJobFunction(option.value);
  }

  if (usersQuery.isPending) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        <Spinner className="size-4 mr-2" /> Loading users…
      </div>
    );
  }

  // A failed read is not an empty directory: nothing goes on until the list loads.
  if (!usersQuery.data) {
    return (
      <AlertCallout
        tone="error"
        icon={AlertCircle}
        title="Could not load the users on this swarm"
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            status={usersQuery.isFetching ? "loading" : "idle"}
            onClick={() => void usersQuery.refetch()}
          >
            <RotateCw />
            Retry
          </Button>
        }
      >
        {usersQuery.error?.message || "The request failed."}
      </AlertCallout>
    );
  }

  if (stage.kind === "match") {
    return (
      <FadeIn key="match" className="flex flex-col gap-4">
        <p className="text-sm">
          Welcome back, <span className="font-medium">{stage.user.name}</span>.
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={restart}>
            Not you? Use another email
          </Button>
          <Button type="button" onClick={() => pick(stage.user.id)}>
            Continue as {stage.user.name}
          </Button>
        </div>
      </FadeIn>
    );
  }

  if (stage.kind === "details") {
    const company = companyDomain(email);
    const teammates = company
      ? users.filter((u) => u.email && companyDomain(u.email) === company).length
      : 0;
    return (
      <FadeIn key="details" className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          {email.trim()} is new on this swarm. Answer these, then you are in.
        </p>
        <QuestionFlow
          questions={detailQuestions(stage.askWebsite)}
          initialValues={{ name: pendingIdentity?.name?.trim() || nameFromEmail(email) }}
          onSubmit={create}
          footer={
            <div className="flex flex-wrap items-center justify-between gap-2">
              {teammates > 0 ? (
                <Badge variant="outline">
                  {teammates === 1
                    ? `1 teammate from ${company} is on this swarm`
                    : `${teammates} teammates from ${company} are on this swarm`}
                </Badge>
              ) : (
                <span />
              )}
              <Button type="button" variant="ghost" size="sm" onClick={restart}>
                Use another email
              </Button>
            </div>
          }
        />
      </FadeIn>
    );
  }

  if (stage.kind === "list") {
    return (
      <FadeIn key="list" className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Pick your user. A user with no email on record adds one first.
        </p>
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
          {users.map((user) => (
            <Button
              key={user.id}
              type="button"
              variant="outline"
              className="justify-start"
              onClick={() => {
                if (user.email) {
                  pick(user.id);
                  return;
                }
                setAddedEmail("");
                setAddError(null);
                setStage({ kind: "add-email", user });
              }}
            >
              <UserCircle2 className="text-muted-foreground" />
              <span className="truncate">{user.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {user.email ?? "no email"}
              </span>
            </Button>
          ))}
        </div>
        <Button type="button" variant="ghost" size="sm" className="self-start" onClick={restart}>
          Back to email
        </Button>
      </FadeIn>
    );
  }

  if (stage.kind === "add-email") {
    const user = stage.user;
    return (
      <FadeIn key="add-email">
        <form className="flex flex-col gap-4" onSubmit={(event) => void addEmail(event, user)}>
          <p className="text-sm text-muted-foreground">
            {user.name} has no email on record. Every user on this swarm needs one.
          </p>
          <EmailInput
            id="identity-add-email"
            value={addedEmail}
            onChange={setAddedEmail}
            error={addError}
            autoFocus
            helper={emailHint(addedEmail)}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setStage({ kind: "list" })}
            >
              Back to the list
            </Button>
            <Button type="submit" status={updateUser.isPending ? "loading" : "idle"}>
              Save and continue as {user.name}
            </Button>
          </div>
        </form>
      </FadeIn>
    );
  }

  if (flat) {
    const busy = createUser.isPending;
    const fieldError = (problem: string | null) =>
      attempted && problem ? <span className="text-status-error-strong">{problem}</span> : null;
    return (
      <FadeIn key="flat">
        {/* No submit button: Enter and the outer Continue submit. */}
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => event.preventDefault()}
          onKeyDown={onFlatKeyDown}
          noValidate
        >
          <EmailInput
            id="identity-email"
            value={email}
            onChange={setEmail}
            error={attempted ? emailProblem : null}
            autoFocus={autoFocus}
            helper={emailHint(email)}
          />
          {match ? (
            <FadeIn key="match">
              <p className="text-sm">
                Welcome back, <span className="font-medium">{match.name}</span>.
              </p>
            </FadeIn>
          ) : asksDetails ? (
            <FadeIn key="details" className="flex flex-col gap-4">
              <SettingsRow
                label="Your name"
                htmlFor="identity-name"
                required
                helper={fieldError(nameValue.trim() ? null : "Enter your name.")}
              >
                <Input
                  id="identity-name"
                  autoComplete="name"
                  placeholder="Ada Lovelace"
                  value={nameValue}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                />
              </SettingsRow>
              <SettingsRow
                label={JOB_FUNCTION_QUESTION.label}
                required
                helper={
                  fieldError(jobFunction ? null : "Pick what you work on.") ??
                  JOB_FUNCTION_QUESTION.description
                }
              >
                <OptionChoices
                  question={JOB_FUNCTION_QUESTION}
                  options={JOB_FUNCTION_QUESTION.options ?? []}
                  selected={jobFunction ? [jobFunction] : []}
                  multi={false}
                  onToggle={setJobFunction}
                  cursor={-1}
                  showKeys={finePointer}
                  disabled={busy}
                />
              </SettingsRow>
            </FadeIn>
          ) : null}
          {users.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => setStage({ kind: "list" })}
            >
              No email? Pick from the list
            </Button>
          ) : null}
        </form>
      </FadeIn>
    );
  }

  return (
    <FadeIn key="email">
      <form className="flex flex-col gap-4" onSubmit={lookUp} noValidate>
        <EmailInput
          id="identity-email"
          value={email}
          onChange={(value) => {
            setEmail(value);
            setEmailError(null);
          }}
          error={emailError}
          autoFocus={autoFocus}
          helper={emailHint(email)}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          {users.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setStage({ kind: "list" })}
            >
              No email? Pick from the list
            </Button>
          ) : (
            <span />
          )}
          {/* /setup has its own Continue in the footer. */}
          <Button type="submit">{surface === "setup" ? "Next" : "Continue"}</Button>
        </div>
      </form>
    </FadeIn>
  );
}
