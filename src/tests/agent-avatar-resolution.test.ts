import { describe, expect, test } from "bun:test";
import { getAgentColorToken, resolveAgentColor } from "../../apps/ui/src/lib/agent-color";
import {
  AVATAR_ICON_CATALOG,
  getAgentIcon,
  resolveAgentIcon,
} from "../../apps/ui/src/lib/agent-icon";

/**
 * Covers the pure avatar-resolution logic behind the customizable agent
 * avatar feature (icon + color). These are the deterministic building
 * blocks consumed by `agent-avatar.tsx` and the appearance picker — no React
 * rendering involved, so they're testable with the existing `bun test`
 * harness (apps/ui has no component-test infra; see PR discussion).
 */
describe("agent avatar resolution", () => {
  describe("getAgentIcon (deterministic fallback)", () => {
    test("lead always resolves to Crown, regardless of id", () => {
      expect(getAgentIcon({ agentId: "any-id", isLead: true })).toBe(AVATAR_ICON_CATALOG.crown);
      expect(getAgentIcon({ role: "lead", agentId: "any-id" })).toBe(AVATAR_ICON_CATALOG.crown);
      expect(getAgentIcon({ agentName: "Lead", agentId: "any-id" })).toBe(
        AVATAR_ICON_CATALOG.crown,
      );
    });

    test("same agentId always resolves to the same icon (deterministic)", () => {
      const first = getAgentIcon({ agentId: "agent-123" });
      const second = getAgentIcon({ agentId: "agent-123" });
      expect(first).toBe(second);
    });

    test("different agentIds can resolve to different icons", () => {
      // Not a strict guarantee for every pair (hash collisions are possible),
      // but across a spread of ids we should see more than one icon.
      const icons = new Set(
        Array.from({ length: 20 }, (_, i) => getAgentIcon({ agentId: `worker-${i}` })),
      );
      expect(icons.size).toBeGreaterThan(1);
    });

    test("empty/missing seed falls back to Bot", () => {
      expect(getAgentIcon({})).toBe(AVATAR_ICON_CATALOG.bot);
      expect(getAgentIcon({ agentId: "", agentName: "" })).toBe(AVATAR_ICON_CATALOG.bot);
    });
  });

  describe("resolveAgentIcon (custom avatar overrides deterministic fallback)", () => {
    test("a known catalog icon wins over the deterministic fallback", () => {
      const avatar = { type: "lucide" as const, icon: "trophy" };
      const fallback = { agentId: "some-agent" };
      expect(resolveAgentIcon(avatar, fallback)).toBe(AVATAR_ICON_CATALOG.trophy);
      // Sanity check it's actually overriding, not coincidentally equal.
      expect(resolveAgentIcon(avatar, fallback)).not.toBe(getAgentIcon(fallback));
    });

    test("an unknown icon name falls back to the deterministic default", () => {
      const avatar = { type: "lucide" as const, icon: "not-a-real-icon" };
      const fallback = { agentId: "some-agent" };
      expect(resolveAgentIcon(avatar, fallback)).toBe(getAgentIcon(fallback));
    });

    test("null/undefined avatar (reset to default) falls back to the deterministic default", () => {
      const fallback = { agentId: "some-agent", isLead: false };
      expect(resolveAgentIcon(null, fallback)).toBe(getAgentIcon(fallback));
      expect(resolveAgentIcon(undefined, fallback)).toBe(getAgentIcon(fallback));
    });
  });

  describe("getAgentColorToken (deterministic fallback)", () => {
    test("lead always resolves to primary", () => {
      expect(getAgentColorToken({ role: "lead", agentId: "x" })).toBe("primary");
      expect(getAgentColorToken({ agentName: "Lead", agentId: "x" })).toBe("primary");
    });

    test("same agentId always resolves to the same token (deterministic)", () => {
      expect(getAgentColorToken({ agentId: "agent-abc" })).toBe(
        getAgentColorToken({ agentId: "agent-abc" }),
      );
    });

    test("empty/missing seed falls back to action-default", () => {
      expect(getAgentColorToken({})).toBe("action-default");
    });
  });

  describe("resolveAgentColor (custom hex overrides deterministic fallback)", () => {
    test("a custom hex wins over the deterministic token", () => {
      const avatar = { type: "lucide" as const, icon: "star", color: "#ff00aa" };
      const fallback = { agentId: "some-agent" };
      expect(resolveAgentColor(avatar, fallback)).toEqual({ kind: "custom", hex: "#ff00aa" });
    });

    test("a lucide avatar with no color falls back to the deterministic token", () => {
      const avatar = { type: "lucide" as const, icon: "star" };
      const fallback = { agentId: "some-agent" };
      expect(resolveAgentColor(avatar, fallback)).toEqual({
        kind: "token",
        token: getAgentColorToken(fallback),
      });
    });

    test("an empty-string color is treated as unset (falls back)", () => {
      const avatar = { type: "lucide" as const, icon: "star", color: "" };
      const fallback = { agentId: "some-agent" };
      expect(resolveAgentColor(avatar, fallback)).toEqual({
        kind: "token",
        token: getAgentColorToken(fallback),
      });
    });

    test("null/undefined avatar (reset to default) falls back to the deterministic token", () => {
      const fallback = { agentId: "some-agent" };
      expect(resolveAgentColor(null, fallback)).toEqual({
        kind: "token",
        token: getAgentColorToken(fallback),
      });
      expect(resolveAgentColor(undefined, fallback)).toEqual({
        kind: "token",
        token: getAgentColorToken(fallback),
      });
    });
  });
});
