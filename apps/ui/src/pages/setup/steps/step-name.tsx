import { Bot, House, ListTodo } from "lucide-react";
import { useState } from "react";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useStatus } from "@/api/hooks/use-status";
import { SetupCard } from "@/components/onboarding/setup-card";
import {
  AutosaveScopeContext,
  useAutosave,
  useAutosaveScope,
  useContinueAction,
} from "@/components/onboarding/use-autosave";
import { useSetupSave } from "@/components/onboarding/use-setup-save";
import { SaveIndicator, StatusIcon, WithIndicator } from "@/components/shared/status-icon";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { SettingsRow } from "@/components/ui/settings-row";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AVATAR_COLOR_INPUT_FALLBACK, AVATAR_SUGGESTED_SWATCHES } from "@/lib/agent-color";
import { cn } from "@/lib/utils";
import { httpUrlError } from "../components/http-url";
import { DEFAULT_SWARM_NAME, initialSwarmName } from "../components/swarm-name";
import type { StepProps } from "../step-contract";
import {
  EmojiSuggestions,
  emojiLogoCandidates,
  lastEmoji,
  parseEmojiLogo,
  useEmojiImage,
} from "./name/emoji-logo";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

type LogoMode = "emoji" | "url";

/**
 * Step 2: the swarm identity (name, logo, color). Every edit saves as you
 * type. Viewing the step saves nothing: an untouched suggested name is
 * stored by Continue, which also completes the step.
 */
export function StepName({ onboarding, act, setContinueBlocker, setContinueAction }: StepProps) {
  const scope = useAutosaveScope(setContinueBlocker);
  // The shell's top bar polls `/status`; this read shares its cache.
  const { data: status } = useStatus({ pollIntervalMs: 0 });
  const { data: configs } = useConfigs({ scope: "global" });
  const { save } = useSetupSave();
  const identity = status?.identity;
  const storedName = configs?.find((c) => c.key === "SWARM_ORG_NAME")?.value;
  const storedLogo = identity?.logo_url ?? "";
  const storedEmoji = parseEmojiLogo(storedLogo);
  const nameStep = onboarding.state.steps.name;
  // Both reads decide the suggestion, so nothing stores before they answer.
  const loaded = configs !== undefined && status !== undefined;

  // `null` = untouched: follow the server value until the operator edits.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [logoMode, setLogoMode] = useState<LogoMode | null>(null);
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [emojiDraft, setEmojiDraft] = useState<string | null>(null);
  const [colorDraft, setColorDraft] = useState<string | null>(null);

  const name = (nameDraft ?? initialSwarmName(storedName, identity?.name)).trim();

  // Logo: an emoji.family URL opens in Emoji mode, any other URL in Image URL mode.
  const mode: LogoMode = logoMode ?? (storedLogo && !storedEmoji ? "url" : "emoji");
  const urlInput = urlDraft ?? storedLogo;
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

  const colorInput = colorDraft ?? identity?.brand_color ?? "";
  const color = colorInput.trim();
  const colorValid = color === "" || HEX_RE.test(color);

  async function storeName(value: string) {
    if (value !== storedName) await save([{ key: "SWARM_ORG_NAME", value, isSecret: false }]);
    const method = value === DEFAULT_SWARM_NAME ? "default_name" : "custom_name";
    if (nameStep.status !== "done" || nameStep.method !== method) {
      await act({ action: "complete", step: "name", method });
    }
  }

  const nameSave = useAutosave({
    value: name,
    // An edit saves. On a step that is not done yet, any edit also completes it.
    dirty: nameDraft !== null && (name !== storedName || nameStep.status !== "done"),
    ready: name.length > 0 && loaded,
    save: storeName,
  });
  // Untouched and not done: Continue stores the suggestion and completes the step.
  useContinueAction(
    (action) => setContinueAction(action, { unlocks: true }),
    nameDraft === null && nameStep.status !== "done" && loaded && name.length > 0
      ? () => storeName(name)
      : null,
  );

  const logoSave = useAutosave({
    value: logo.value,
    dirty: logo.touched && logo.value !== storedLogo,
    ready: logo.valid,
    save: (value) => save([{ key: "SWARM_ORG_LOGO_URL", value, isSecret: false }]),
  });
  const colorSave = useAutosave({
    value: color,
    dirty:
      colorDraft !== null && color.toLowerCase() !== (identity?.brand_color ?? "").toLowerCase(),
    ready: colorValid,
    save: (value) => save([{ key: "SWARM_BRAND_COLOR", value, isSecret: false }]),
  });

  function pickSwatch(hex: string) {
    setColorDraft(hex);
    colorSave.commit();
  }

  const logoIndicator = <SaveIndicator phase={logoSave.phase} error={logoSave.error} />;

  return (
    <AutosaveScopeContext.Provider value={scope}>
      <div className="grid items-start gap-3 sm:grid-cols-2">
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
          <SettingsRow label="Swarm name" htmlFor="setup-swarm-name" required>
            <WithIndicator
              indicator={<SaveIndicator phase={nameSave.phase} error={nameSave.error} />}
            >
              <Input
                id="setup-swarm-name"
                value={nameDraft ?? name}
                onChange={(event) => setNameDraft(event.target.value)}
                onBlur={nameSave.commit}
                aria-invalid={!name}
                className="pr-8"
              />
            </WithIndicator>
          </SettingsRow>

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
                    aria-label={`Use ${hex}`}
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
                  value={colorValid && color ? color : AVATAR_COLOR_INPUT_FALLBACK}
                  onChange={(event) => setColorDraft(event.target.value)}
                  className="w-10 shrink-0 p-1"
                />
                <WithIndicator
                  className="flex-1"
                  indicator={<SaveIndicator phase={colorSave.phase} error={colorSave.error} />}
                >
                  <Input
                    id="setup-brand-color"
                    placeholder="#RRGGBB"
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
        </SetupCard>

        <SetupCard title="Sidebar preview" bodyClassName="rounded-b-xl bg-surface">
          <SidebarPreview
            name={name || DEFAULT_SWARM_NAME}
            logo={logo.valid && logo.value ? logo.value : null}
            color={color && colorValid ? color : null}
          />
        </SetupCard>
      </div>
    </AutosaveScopeContext.Provider>
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
        <img
          src={logo ?? "/logo.png"}
          alt=""
          className="size-7 shrink-0 rounded object-contain"
          onError={(event) => {
            // Same fallback as the sidebar when a logo URL does not load.
            const img = event.currentTarget;
            if (img.src !== `${window.location.origin}/logo.png`) img.src = "/logo.png";
          }}
        />
        <div className="min-w-0">
          <p
            className="truncate text-sm font-semibold leading-tight"
            style={color ? { color } : undefined}
          >
            {name}
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
