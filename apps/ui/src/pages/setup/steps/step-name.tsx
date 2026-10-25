import { Bot, House, ListTodo } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useStatus } from "@/api/hooks/use-status";
import { type OrgProfileField, sendUiTelemetry } from "@/api/hooks/use-ui-telemetry";
import { SaveIndicator, WithIndicator } from "@/components/onboarding/save-indicator";
import { useSetupSave } from "@/components/onboarding/use-setup-save";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { SetupCard } from "@/components/shared/setup-card";
import { StatusIcon } from "@/components/shared/status-icon";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { SettingsRow } from "@/components/ui/settings-row";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCurrentUser } from "@/contexts/current-user-context";
import {
  AutosaveScopeContext,
  useAutosave,
  useAutosaveScope,
  useContinueAction,
  useContinueBlocker,
} from "@/hooks/use-autosave";
import { useTheme } from "@/hooks/use-theme";
import {
  AVATAR_COLOR_INPUT_FALLBACK,
  AVATAR_SUGGESTED_SWATCHES,
  AVATAR_SWATCH_NAMES,
} from "@/lib/agent-color";
import {
  companyDomain,
  optionValue,
  orgNameFromDomain,
  SWARM_ORG_TEAM_SIZE,
  SWARM_ORG_USE_CASE,
  TEAM_SIZES,
  type TeamSize,
  USE_CASE_GROUPS,
  USE_CASES,
  type UseCase,
} from "@/lib/company-profile";
import { resolveCssVarToHex } from "@/lib/css-color";
import { cn } from "@/lib/utils";
import {
  isFilledOrgLogoUrl,
  normalizeOrgWebsite,
  orgLogoUrl,
  websiteSuggestion,
} from "../../../../../../src/utils/org-website";
import { httpUrlError } from "../components/http-url";
import { initialSwarmName } from "../components/swarm-name";
import type { StepProps } from "../step-contract";
import {
  EmojiSuggestions,
  emojiLogoCandidates,
  lastEmoji,
  parseEmojiLogo,
  useEmojiImage,
} from "./name/emoji-logo";
import { useLogoColor } from "./name/logo-color";
import { OptionChips } from "./name/option-chips";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

type LogoMode = "emoji" | "url";

type ProfileEntry = { key: string; value: string; field: OrgProfileField };

/** The `domain` of a logo URL the API filled from a website. */
function logoDomain(url: string): string | null {
  try {
    return new URL(url).searchParams.get("domain");
  } catch {
    return null;
  }
}

/**
 * Step 2: the swarm identity. Four profile answers (name, website, team size,
 * use case); the logo and color follow the website, behind a Change link.
 * Every edit saves as you type or pick. The name is required: no Skip, no
 * default name. Viewing the step saves nothing: on the first pass the name
 * and website are pre-filled from a company domain and the color from the
 * website's logo, and Continue stores what is still untouched and completes
 * the step. The theme is a browser preference: Settings > Appearance.
 */
export function StepName({ onboarding, act, setContinueBlocker, setContinueAction }: StepProps) {
  // The step's one blocker slot shows the scope's hold ("Saving…"), so the
  // scope reports here instead of the shell.
  const [scopeHold, setScopeHold] = useState<{ reason: string | null; busy: boolean }>({
    reason: null,
    busy: false,
  });
  const scope = useAutosaveScope(
    useCallback(
      (reason: string | null, options?: { busy?: boolean }) =>
        setScopeHold({ reason, busy: options?.busy ?? false }),
      [],
    ),
  );
  // The shell's top bar polls `/status`; this read shares its cache.
  const { data: status } = useStatus({ pollIntervalMs: 0 });
  const { data: configs } = useConfigs({ scope: "global" });
  const { user } = useCurrentUser();
  const { save } = useSetupSave();
  const identity = status?.identity;
  const row = (key: string) => configs?.find((c) => c.key === key);
  const storedName = row("SWARM_ORG_NAME")?.value;
  const storedLogo = identity?.logo_url ?? "";
  const storedEmoji = parseEmojiLogo(storedLogo);
  // The API fills the logo from the website while no one has set another.
  const storedFilled = isFilledOrgLogoUrl(storedLogo);
  const nameStep = onboarding.state.steps.name;
  // Both reads decide the suggestion, so nothing stores before they answer.
  const loaded = configs !== undefined && status !== undefined;
  // Pre-fill only until the step is done. After that, the fields show what is stored.
  const firstPass = nameStep.status !== "done";
  const panelId = useId();
  const nameInput = useRef<HTMLInputElement>(null);

  // `null` = untouched: follow the server value until the operator edits.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  // The empty name shows as invalid only after a blur or a Continue attempt.
  const [nameTouched, setNameTouched] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [logoMode, setLogoMode] = useState<LogoMode | null>(null);
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [emojiDraft, setEmojiDraft] = useState<string | null>(null);
  const [colorDraft, setColorDraft] = useState<string | null>(null);
  const [websiteDraft, setWebsiteDraft] = useState<string | null>(null);
  const [teamSizeDraft, setTeamSizeDraft] = useState<TeamSize | null>(null);
  const [useCaseDraft, setUseCaseDraft] = useState<UseCase | null>(null);

  // The admin's work domain, never free mail: the API's earliest-admin
  // domain, else the signed-in user's own address.
  const suggestedWebsite =
    websiteSuggestion(row("telemetry_org_domain")?.value) ?? companyDomain(user?.email ?? "");
  const websiteRow = row("SWARM_ORG_WEBSITE");
  const storedWebsite = websiteRow?.value ?? "";
  const websiteInput =
    websiteDraft ?? (websiteRow || !firstPass ? storedWebsite : (suggestedWebsite ?? ""));
  const website = normalizeOrgWebsite(websiteInput);
  const websiteError =
    websiteInput.trim() && !website ? "Enter a public website, such as example.com." : null;
  // Shown but not stored yet: Continue stores it.
  const websitePrefilled = websiteDraft === null && !websiteRow && firstPass && website !== null;

  // An untouched name follows the website (acme.com becomes Acme).
  const nameDomain = firstPass ? (website ?? suggestedWebsite) : null;
  const name = (
    nameDraft ??
    initialSwarmName(storedName, identity?.name, nameDomain ? orgNameFromDomain(nameDomain) : null)
  ).trim();
  const nameSuggested =
    nameDraft === null && nameDomain !== null && name === orgNameFromDomain(nameDomain);
  const nameMissing = loaded && !name;
  const nameInvalid = nameMissing && nameTouched;
  useContinueBlocker(setContinueBlocker, scopeHold.reason, {
    busy: scopeHold.reason !== null && scopeHold.busy,
  });

  // Logo: an emoji.family URL opens in Emoji mode, another custom URL in Image
  // URL mode. A logo filled from the website opens in Emoji mode, and the URL
  // field stays empty: the proxy URL is not something to edit.
  const mode: LogoMode =
    logoMode ?? (storedLogo && !storedEmoji && !storedFilled ? "url" : "emoji");
  const urlInput = urlDraft ?? (storedFilled ? "" : storedLogo);
  const url = urlInput.trim();
  const urlError = url ? httpUrlError(url) : null;
  const emojiInput = emojiDraft ?? storedEmoji ?? "";
  const emoji = lastEmoji(emojiInput);
  // Always the Fluent pack: an older logo in another pack re-saves as Fluent on its next edit.
  const emojiImage = useEmojiImage(mode === "emoji" && emoji ? emojiLogoCandidates(emoji) : []);
  const emojiError =
    emojiInput.trim() && !emoji
      ? "Type or paste one emoji."
      : emojiImage.status === "missing"
        ? "No image for that emoji. Try another one."
        : null;
  // A blank field clears the logo, so the sidebar falls back to the hive mark.
  const logo =
    mode === "url"
      ? { value: url, touched: urlDraft !== null, valid: !urlError }
      : emojiInput.trim()
        ? {
            value: emojiImage.url ?? "",
            touched: emojiDraft !== null,
            valid: emojiImage.status === "ok",
          }
        : { value: "", touched: emojiDraft !== null, valid: true };
  // The website's logo: stored, or the one the API fills when the website saves.
  const websiteLogo =
    !storedLogo || storedFilled ? (website ? orgLogoUrl(website) : storedLogo || null) : null;
  const shownLogo = logo.valid && logo.value ? logo.value : websiteLogo;
  const fromWebsite = shownLogo !== null && shownLogo === websiteLogo;
  const shownDomain = fromWebsite && shownLogo ? logoDomain(shownLogo) : null;

  const storedColor = identity?.brand_color ?? "";
  const websiteColor = useLogoColor(fromWebsite ? websiteLogo : null);
  // The website's color while no color is set, on the first pass or after a
  // website edit. Shown but not stored yet: Continue stores it.
  const colorSuggested =
    colorDraft === null &&
    !storedColor &&
    (firstPass || websiteDraft !== null) &&
    websiteColor !== null;
  const colorInput = colorDraft ?? (storedColor || (colorSuggested ? (websiteColor ?? "") : ""));
  // With no brand color the sidebar name renders in the theme's text color.
  // Show that color in the swatch instead of the picker's black fallback.
  const { theme, preset } = useTheme();
  const [themeNameHex, setThemeNameHex] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read the CSS variable when the theme or preset changes
  useEffect(() => {
    // The theme provider applies its class after this effect; read next frame.
    const frame = requestAnimationFrame(() =>
      setThemeNameHex(resolveCssVarToHex("--color-sidebar-foreground")),
    );
    return () => cancelAnimationFrame(frame);
  }, [theme, preset]);
  const color = colorInput.trim();
  const colorValid = color === "" || HEX_RE.test(color);

  /** Store org profile rows (no config reload), then report them as `org.profile_updated`. */
  async function storeProfile(entries: ProfileEntry[]) {
    if (entries.length === 0) return;
    await save(entries.map(({ key, value }) => ({ key, value, isSecret: false })));
    sendUiTelemetry(status, {
      event: "org.profile_updated",
      properties: { fields: entries.map((entry) => entry.field), surface: "setup" },
    });
  }

  async function completeStep() {
    // There is no default name, so every stored name is a custom one.
    if (nameStep.status !== "done" || nameStep.method !== "custom_name") {
      await act({ action: "complete", step: "name", method: "custom_name" });
    }
  }

  const websiteSave = useAutosave({
    value: website ?? "",
    dirty: websiteDraft !== null && (website ?? "") !== storedWebsite,
    // Empty clears the website.
    ready: website !== null || websiteInput.trim() === "",
    save: (value) => storeProfile([{ key: "SWARM_ORG_WEBSITE", value, field: "website" }]),
  });

  async function storeName(value: string) {
    if (value !== storedName) {
      await storeProfile([{ key: "SWARM_ORG_NAME", value, field: "name" }]);
    }
    await completeStep();
  }

  const nameSave = useAutosave({
    value: name,
    // An edit saves. On a step that is not done yet, any edit also completes it.
    dirty: nameDraft !== null && (name !== storedName || nameStep.status !== "done"),
    ready: name.length > 0 && loaded,
    save: storeName,
  });
  // Continue stores the untouched pre-fills (name, website, color) and
  // completes the step. With no name, it marks the field and stays.
  useContinueAction(
    (action) => setContinueAction(action, { unlocks: true }),
    nameMissing
      ? async () => {
          setNameTouched(true);
          nameInput.current?.focus();
          throw new Error("Name your swarm to continue.");
        }
      : loaded && ((nameDraft === null && firstPass) || websitePrefilled || colorSuggested)
        ? async () => {
            const entries: ProfileEntry[] = [];
            if (nameDraft === null && name !== storedName) {
              entries.push({ key: "SWARM_ORG_NAME", value: name, field: "name" });
            }
            if (websitePrefilled && website) {
              entries.push({ key: "SWARM_ORG_WEBSITE", value: website, field: "website" });
            }
            await storeProfile(entries);
            if (colorSuggested && HEX_RE.test(color)) {
              await save([{ key: "SWARM_BRAND_COLOR", value: color, isSecret: false }]);
            }
            await completeStep();
          }
        : null,
  );

  // Team size and use case store on a pick (an explicit action).
  const storedTeamSize = optionValue(TEAM_SIZES, row(SWARM_ORG_TEAM_SIZE)?.value);
  const teamSize = teamSizeDraft ?? storedTeamSize;
  const teamSizeSave = useAutosave({
    value: teamSize ?? "",
    dirty: teamSizeDraft !== null && teamSizeDraft !== storedTeamSize,
    ready: true,
    save: (value) => storeProfile([{ key: SWARM_ORG_TEAM_SIZE, value, field: "team_size" }]),
  });
  const storedUseCase = optionValue(USE_CASES, row(SWARM_ORG_USE_CASE)?.value);
  const useCase = useCaseDraft ?? storedUseCase;
  const useCaseSave = useAutosave({
    value: useCase ?? "",
    dirty: useCaseDraft !== null && useCaseDraft !== storedUseCase,
    ready: true,
    save: (value) => storeProfile([{ key: SWARM_ORG_USE_CASE, value, field: "use_case" }]),
  });
  // The Home benchmark compares only with telemetry on.
  const telemetryOff = status?.telemetry?.enabled === false;

  const logoSave = useAutosave({
    value: logo.value,
    dirty: logo.touched && logo.value !== storedLogo,
    ready: logo.valid,
    save: (value) => save([{ key: "SWARM_ORG_LOGO_URL", value, isSecret: false }]),
  });
  const colorSave = useAutosave({
    value: color,
    dirty: colorDraft !== null && color.toLowerCase() !== storedColor.toLowerCase(),
    ready: colorValid,
    save: (value) => save([{ key: "SWARM_BRAND_COLOR", value, isSecret: false }]),
  });

  function pickSwatch(hex: string) {
    setColorDraft(hex);
    colorSave.commit();
  }

  const logoIndicator = <SaveIndicator phase={logoSave.phase} error={logoSave.error} />;
  const logoSource = shownDomain
    ? `From ${shownDomain}`
    : !shownLogo
      ? "Hive mark"
      : parseEmojiLogo(shownLogo)
        ? "Your emoji"
        : "Your image";

  return (
    <AutosaveScopeContext.Provider value={scope}>
      <div className="grid items-start gap-3 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <SetupCard
          title="Identity"
          status={
            <StatusIcon
              tone={nameStep.status === "done" ? "done" : "none"}
              label="Identity saved"
            />
          }
          bodyClassName="flex flex-col gap-4"
        >
          <SettingsRow
            label="Swarm name"
            htmlFor="setup-swarm-name"
            required
            helper={
              !name ? (
                <span className={nameInvalid ? "text-status-error-strong" : undefined}>
                  Name your swarm to continue. Your team sees it across the dashboard.
                </span>
              ) : nameSuggested ? (
                `Suggested from ${nameDomain}. Change it if your team uses another name.`
              ) : undefined
            }
          >
            <WithIndicator
              indicator={<SaveIndicator phase={nameSave.phase} error={nameSave.error} />}
            >
              <Input
                ref={nameInput}
                id="setup-swarm-name"
                placeholder="Acme"
                autoComplete="organization"
                value={nameDraft ?? name}
                onChange={(event) => setNameDraft(event.target.value)}
                onBlur={() => {
                  setNameTouched(true);
                  nameSave.commit();
                }}
                aria-invalid={nameInvalid}
                className="pr-8"
              />
            </WithIndicator>
          </SettingsRow>

          <SettingsRow
            label="Company website (optional)"
            htmlFor="setup-org-website"
            helper={
              websiteError ? (
                <span className="text-status-error-strong">{websiteError}</span>
              ) : websitePrefilled ? (
                "Filled from your email. Its logo and color brand your swarm."
              ) : (
                "Its logo and color brand your swarm, unless you pick your own."
              )
            }
          >
            <WithIndicator
              indicator={<SaveIndicator phase={websiteSave.phase} error={websiteSave.error} />}
            >
              <Input
                id="setup-org-website"
                value={websiteInput}
                placeholder="example.com"
                inputMode="url"
                autoComplete="url"
                onChange={(event) => setWebsiteDraft(event.target.value)}
                onBlur={websiteSave.commit}
                aria-invalid={websiteError !== null}
                className="pr-8"
              />
            </WithIndicator>
          </SettingsRow>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium leading-none">Logo and color</p>
            <div className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2">
              <LogoImage src={shownLogo} className="size-8" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm">{logoSource}</span>
                {color && colorValid ? (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span
                      aria-hidden="true"
                      className="size-2.5 shrink-0 rounded-full border border-border"
                      style={{ backgroundColor: color }}
                    />
                    <span className="font-mono">{color}</span>
                  </span>
                ) : null}
              </div>
              <Button
                variant="link"
                size="sm"
                className="h-auto shrink-0 px-1"
                aria-label={customizing ? undefined : "Change logo and color"}
                aria-expanded={customizing}
                aria-controls={customizing ? panelId : undefined}
                onClick={() => setCustomizing((open) => !open)}
              >
                {customizing ? "Done" : "Change"}
              </Button>
            </div>
            <AnimatedReveal open={customizing} className="-m-1 p-1">
              <div id={panelId} className="flex flex-col gap-4 pt-2">
                <SettingsRow
                  label={
                    <>
                      Logo
                      <InfoTip
                        content={
                          mode === "emoji"
                            ? "Served by emoji.family. Use Image URL to host your own."
                            : "Optional. Without one, the sidebar shows the hive mark."
                        }
                      />
                    </>
                  }
                  htmlFor={mode === "emoji" ? "setup-logo-emoji" : "setup-logo-url"}
                  helper={
                    mode === "emoji" && emojiError ? (
                      <span className="text-status-error-strong">{emojiError}</span>
                    ) : mode === "url" && urlError ? (
                      <span className="text-status-error-strong">{urlError}</span>
                    ) : undefined
                  }
                >
                  <Tabs value={mode} onValueChange={(next) => setLogoMode(next as LogoMode)}>
                    <TabsList>
                      <TabsTrigger value="emoji">Emoji</TabsTrigger>
                      <TabsTrigger value="url">Image URL</TabsTrigger>
                    </TabsList>
                    <TabsContent value="emoji" className="flex flex-col gap-2.5 pt-1">
                      <WithIndicator indicator={logoIndicator}>
                        <Input
                          id="setup-logo-emoji"
                          placeholder="Type or paste an emoji"
                          value={emojiInput}
                          // Keep one emoji: a new one typed after the old replaces it.
                          onChange={(event) =>
                            setEmojiDraft(lastEmoji(event.target.value) || event.target.value)
                          }
                          onBlur={logoSave.commit}
                          aria-invalid={emojiError ? true : undefined}
                          className="pr-8 text-base"
                        />
                      </WithIndicator>
                      <EmojiSuggestions
                        selected={emoji}
                        onPick={(next) => {
                          setEmojiDraft(next);
                          logoSave.commit();
                        }}
                      />
                    </TabsContent>
                    <TabsContent value="url" className="pt-1">
                      <WithIndicator indicator={logoIndicator}>
                        <Input
                          id="setup-logo-url"
                          inputMode="url"
                          spellCheck={false}
                          placeholder="https://acme.dev/mark.png"
                          value={urlInput}
                          onChange={(event) => setUrlDraft(event.target.value)}
                          onBlur={logoSave.commit}
                          aria-invalid={urlError ? true : undefined}
                          className="pr-8 font-mono"
                        />
                      </WithIndicator>
                    </TabsContent>
                  </Tabs>
                </SettingsRow>

                <SettingsRow
                  label={
                    <>
                      Brand color
                      <InfoTip content="Optional. Colors the swarm name in the sidebar." />
                    </>
                  }
                  htmlFor="setup-brand-color"
                  helper={
                    colorValid ? undefined : (
                      <span className="text-status-error-strong">Use hex, like #RRGGBB.</span>
                    )
                  }
                >
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap gap-1.5">
                      {AVATAR_SUGGESTED_SWATCHES.map((hex) => (
                        <button
                          key={hex}
                          type="button"
                          aria-label={AVATAR_SWATCH_NAMES[hex] ?? hex}
                          title={AVATAR_SWATCH_NAMES[hex] ?? hex}
                          aria-pressed={color.toLowerCase() === hex}
                          onClick={() => pickSwatch(hex)}
                          className={cn(
                            "size-7 rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                            color.toLowerCase() === hex &&
                              "ring-2 ring-foreground ring-offset-2 ring-offset-card",
                          )}
                          style={{ backgroundColor: hex }}
                        />
                      ))}
                    </div>
                    {/* Same control as Settings, Configuration for `kind: "color"`. */}
                    <div className="flex gap-2">
                      <Input
                        type="color"
                        aria-label="Brand color picker"
                        value={
                          colorValid && color
                            ? color
                            : (themeNameHex ?? AVATAR_COLOR_INPUT_FALLBACK)
                        }
                        onChange={(event) => setColorDraft(event.target.value)}
                        className="w-10 shrink-0 p-1"
                      />
                      <WithIndicator
                        className="flex-1"
                        indicator={
                          <SaveIndicator phase={colorSave.phase} error={colorSave.error} />
                        }
                      >
                        <Input
                          id="setup-brand-color"
                          placeholder={themeNameHex ? `${themeNameHex} (theme text)` : "#RRGGBB"}
                          maxLength={7}
                          spellCheck={false}
                          value={colorInput}
                          onChange={(event) => setColorDraft(event.target.value)}
                          onBlur={colorSave.commit}
                          aria-invalid={!colorValid}
                          className="pr-8 font-mono"
                        />
                      </WithIndicator>
                    </div>
                  </div>
                </SettingsRow>
              </div>
            </AnimatedReveal>
          </div>

          <SettingsRow
            label={
              <>
                Team size (optional)
                <SaveIndicator phase={teamSizeSave.phase} error={teamSizeSave.error} />
              </>
            }
            helper={telemetryOff ? undefined : "Picks your peers in the Home benchmark."}
          >
            <OptionChips
              aria-label="Team size"
              options={TEAM_SIZES}
              value={teamSize}
              onValueChange={(next) => {
                setTeamSizeDraft(next);
                teamSizeSave.commit();
              }}
            />
          </SettingsRow>

          <SettingsRow
            label={
              <>
                What will the swarm work on first? (optional)
                <SaveIndicator phase={useCaseSave.phase} error={useCaseSave.error} />
              </>
            }
            helper="Picks your first-task ideas in step 7."
          >
            <OptionChips
              aria-label="First use case"
              options={USE_CASES}
              groups={USE_CASE_GROUPS}
              value={useCase}
              onValueChange={(next) => {
                setUseCaseDraft(next);
                useCaseSave.commit();
              }}
            />
          </SettingsRow>
        </SetupCard>

        {/* The Logo and color row shows the same on a phone. */}
        <SetupCard
          title="Sidebar preview"
          className="sticky top-0 hidden sm:block"
          bodyClassName="rounded-b-xl bg-surface"
        >
          <SidebarPreview name={name} logo={shownLogo} color={color && colorValid ? color : null} />
        </SetupCard>
      </div>
    </AutosaveScopeContext.Provider>
  );
}

/** A logo with the sidebar's fallback: the hive mark when it is unset or does not load. */
function LogoImage({ src, className }: { src: string | null; className?: string }) {
  return (
    <img
      src={src ?? "/logo.png"}
      alt=""
      className={cn("shrink-0 rounded object-contain", className)}
      onError={(event) => {
        const img = event.currentTarget;
        if (img.src !== `${window.location.origin}/logo.png`) img.src = "/logo.png";
      }}
    />
  );
}

const PREVIEW_NAV = [
  { label: "Home", icon: House },
  { label: "Tasks", icon: ListTodo },
  { label: "Agents", icon: Bot },
];

/** The sidebar header as `app-sidebar.tsx` renders it: logo, name in the brand color. */
function SidebarPreview({
  name,
  logo,
  color,
}: {
  name: string;
  logo: string | null;
  color: string | null;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2.5 border-b border-sidebar-border px-3 py-2.5">
        <LogoImage src={logo} className="size-7" />
        <div className="min-w-0">
          <p
            className={cn(
              "truncate text-sm font-semibold leading-tight",
              !name && "text-muted-foreground",
            )}
            style={color && name ? { color } : undefined}
          >
            {name || "Name required"}
          </p>
          <p className="text-[11px] leading-tight text-muted-foreground">Mission control</p>
        </div>
      </div>
      <ul className="flex flex-col gap-0.5 p-1.5">
        {PREVIEW_NAV.map(({ label, icon: Icon }) => (
          <li
            key={label}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground",
              label === "Home" && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
