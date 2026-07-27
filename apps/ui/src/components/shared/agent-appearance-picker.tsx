/**
 * Popover-based editor for an agent's custom avatar (icon + color), attached
 * to the avatar disc on the agent detail page's edit mode. Applies each pick
 * immediately (no separate "Save" step) via `useUpdateAgentProfile` — icon
 * and color can be set independently, and "Reset to default" sends
 * `avatar: null` to fall back to the deterministic hash-derived icon/color.
 */

import { RotateCcw } from "lucide-react";
import { useState } from "react";
import type { AgentAvatar } from "@/api/types";
import { AVATAR_SUGGESTED_SWATCHES } from "@/lib/agent-color";
import { AVATAR_ICON_CATALOG } from "@/lib/agent-icon";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";

const DEFAULT_ICON_KEY = "bot";
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export interface AgentAppearancePickerProps {
  avatar: AgentAvatar | null | undefined;
  onChange: (avatar: AgentAvatar | null) => void;
  trigger: React.ReactNode;
}

export function AgentAppearancePicker({ avatar, onChange, trigger }: AgentAppearancePickerProps) {
  const [hexDraft, setHexDraft] = useState(avatar?.color ?? "");
  const hexValid = hexDraft === "" || HEX_RE.test(hexDraft);

  function pickIcon(icon: string) {
    onChange({ type: "lucide", icon, color: avatar?.color });
  }

  function pickColor(hex: string) {
    setHexDraft(hex);
    if (!HEX_RE.test(hex)) return;
    onChange({ type: "lucide", icon: avatar?.icon ?? DEFAULT_ICON_KEY, color: hex });
  }

  function reset() {
    setHexDraft("");
    onChange(null);
  }

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) setHexDraft(avatar?.color ?? "");
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-80" align="start">
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium mb-2">Icon</p>
            <ScrollArea className="h-40 rounded-md border">
              <div className="grid grid-cols-8 gap-1 p-2">
                {Object.entries(AVATAR_ICON_CATALOG).map(([key, Icon]) => (
                  <button
                    key={key}
                    type="button"
                    title={key}
                    onClick={() => pickIcon(key)}
                    className={cn(
                      "flex items-center justify-center rounded-md p-1.5 hover:bg-accent transition-colors",
                      avatar?.icon === key && "bg-accent ring-1 ring-ring",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </button>
                ))}
              </div>
            </ScrollArea>
          </div>

          <div>
            <p className="text-sm font-medium mb-2">Color</p>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {AVATAR_SUGGESTED_SWATCHES.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  title={hex}
                  onClick={() => pickColor(hex)}
                  className={cn(
                    "h-6 w-6 rounded-full shrink-0 transition-transform hover:scale-110",
                    avatar?.color === hex &&
                      "ring-2 ring-ring ring-offset-1 ring-offset-background",
                  )}
                  style={{ backgroundColor: hex }}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label="Custom color"
                value={hexValid && hexDraft ? hexDraft : "#000000"}
                onChange={(e) => pickColor(e.target.value)}
                className="h-9 w-9 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-1"
              />
              <Input
                value={hexDraft}
                onChange={(e) => pickColor(e.target.value)}
                placeholder="#RRGGBB"
                maxLength={7}
                aria-invalid={!hexValid}
                className="h-9 font-mono text-sm"
              />
            </div>
          </div>

          <Button variant="outline" size="sm" className="w-full" onClick={reset} disabled={!avatar}>
            <RotateCcw className="h-3.5 w-3.5" />
            Reset to default
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
