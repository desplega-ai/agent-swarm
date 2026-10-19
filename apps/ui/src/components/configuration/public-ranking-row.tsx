import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useConfigs } from "@/api/hooks/use-config-api";
import {
  useEnableTelemetry,
  useRanking,
  useRankingOptIn,
  useRankingOptOut,
} from "@/api/hooks/use-org-profile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RANKING_TAXONOMY } from "../../../../../src/telemetry-contract/ranking-taxonomy.gen";

const NO_SUBCATEGORY = "__none__";
const FIELD_LABELS = {
  SWARM_ORG_NAME: "Organization name",
  SWARM_ORG_WEBSITE: "Company website",
} as const;
const CATEGORIES = Object.keys(RANKING_TAXONOMY) as Array<keyof typeof RANKING_TAXONOMY>;

/**
 * Settings → Branding: opt into the public ranking on agent-swarm.dev/ranking.
 * Needs telemetry on and a real organization name and website; the name and
 * domain shown on the page are copied from them. Joining still takes a merged
 * `community/ranking/<domain>.json` PR, which the button prefills.
 */
export function PublicRankingRow() {
  const { data: configs } = useConfigs({ scope: "global" });
  const value = (key: string) => configs?.find((entry) => entry.key === key)?.value.trim() || "";
  // Keyed on the identity edited in the rows above, so a save refreshes eligibility.
  const { data: state, refetch } = useRanking(
    `${value("SWARM_ORG_NAME")}|${value("SWARM_ORG_WEBSITE")}`,
  );
  const optIn = useRankingOptIn();
  const optOut = useRankingOptOut();
  const enableTelemetry = useEnableTelemetry();

  const [category, setCategory] = useState<string>("engineering");
  const [subcategory, setSubcategory] = useState<string>(NO_SUBCATEGORY);
  const [description, setDescription] = useState("");
  const [sourceCodeUrl, setSourceCodeUrl] = useState("");

  // Prefill the form from the stored listing.
  const listing = state?.listing;
  useEffect(() => {
    if (!listing) return;
    setCategory(listing.category);
    setSubcategory(listing.subcategory ?? NO_SUBCATEGORY);
    setDescription(listing.description ?? "");
    setSourceCodeUrl(listing.sourceCodeUrl ?? "");
  }, [listing]);

  const subcategories: readonly string[] =
    RANKING_TAXONOMY[category as keyof typeof RANKING_TAXONOMY] ?? [];

  function submit() {
    optIn.mutate(
      {
        category,
        subcategory: subcategory === NO_SUBCATEGORY ? null : subcategory,
        description: description.trim() || null,
        sourceCodeUrl: sourceCodeUrl.trim() || null,
      },
      {
        onSuccess: (result) => {
          toast.success("Listing sent. Open the PR to get ranked.");
          window.open(result.prUrl, "_blank", "noopener,noreferrer");
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  function leave() {
    optOut.mutate(undefined, {
      onSuccess: () => toast.success("Left the ranking. The entry hides at the next refresh."),
      onError: (error) => toast.error(error.message),
    });
  }

  const pending = optIn.isPending || optOut.isPending;
  const enabled = state?.enabled ?? false;

  return (
    <div id="setting-PUBLIC_RANKING_ENABLED" className="scroll-mt-6 space-y-3 py-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">Public ranking on agent-swarm.dev</span>
          <code className="font-mono text-[10px] text-muted-foreground select-text">
            PUBLIC_RANKING_ENABLED
          </code>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Rank this install by tokens used on agent-swarm.dev/ranking. Your exact token totals, and
          tokens per model, become public. Each worker session sends its token counts, model and
          provider through telemetry. Listing also takes a merged PR to desplega-ai/agent-swarm.
        </p>
      </div>

      {!state ? null : !state.telemetryOn ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs text-muted-foreground">The ranking counts tokens from telemetry.</p>
          <Button
            size="sm"
            variant="outline"
            disabled={enableTelemetry.isPending}
            onClick={() =>
              enableTelemetry.mutate("settings", {
                onSuccess: () => void refetch(),
                onError: (error) => toast.error(error.message),
              })
            }
          >
            Turn on telemetry
          </Button>
        </div>
      ) : state.missing.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Set these first:</p>
          <ul className="list-disc space-y-1 pl-5 text-xs">
            {state.missing.map((key) => (
              <li key={key}>
                <a className="underline" href={`#setting-${key}`}>
                  {FIELD_LABELS[key]}
                </a>
                {key === "SWARM_ORG_NAME" ? " (the placeholder Swarm does not count)" : null}
              </li>
            ))}
          </ul>
          <Button size="sm" disabled>
            Get ranked
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs">
            Listed as <span className="font-medium">{state.name}</span> ·{" "}
            <span className="font-mono">{state.domain}</span>
            {state.listing && !state.listingMatchesDomain
              ? ". Your website changed since the last listing, so this needs a new PR."
              : null}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="ranking-category" className="text-xs">
                Category
              </Label>
              <Select
                value={category}
                disabled={pending}
                onValueChange={(next) => {
                  setCategory(next);
                  setSubcategory(NO_SUBCATEGORY);
                }}
              >
                <SelectTrigger id="ranking-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((key) => (
                    <SelectItem key={key} value={key}>
                      {key}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ranking-subcategory" className="text-xs">
                Subcategory
              </Label>
              <Select
                value={subcategory}
                disabled={pending || subcategories.length === 0}
                onValueChange={setSubcategory}
              >
                <SelectTrigger id="ranking-subcategory">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_SUBCATEGORY}>None</SelectItem>
                  {subcategories.map((key) => (
                    <SelectItem key={key} value={key}>
                      {key}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ranking-description" className="text-xs">
                Description (optional)
              </Label>
              <Input
                id="ranking-description"
                maxLength={160}
                value={description}
                disabled={pending}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="QA and release automation for our web apps"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ranking-source" className="text-xs">
                Source code URL (optional)
              </Label>
              <Input
                id="ranking-source"
                maxLength={200}
                value={sourceCodeUrl}
                disabled={pending}
                onChange={(event) => setSourceCodeUrl(event.target.value)}
                placeholder="https://github.com/example/agents"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={pending} onClick={submit}>
              {enabled ? "Update listing" : "Get ranked"}
            </Button>
            {enabled ? (
              <Button size="sm" variant="outline" disabled={pending} onClick={leave}>
                Leave the ranking
              </Button>
            ) : null}
            {state.prUrl ? (
              <a
                className="text-xs underline"
                href={state.prUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open the ranking PR
              </a>
            ) : null}
          </div>
          {state.fileJson ? (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                Or add <code>community/ranking/{state.domain}.json</code> by hand
              </summary>
              <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 font-mono text-[11px]">
                {state.fileJson}
              </pre>
            </details>
          ) : null}
        </div>
      )}
    </div>
  );
}
