import { describe, expect, test } from "bun:test";
import { getAgentColorToken, resolveAgentColor } from "../../apps/ui/src/lib/agent-color";
import {
  AVATAR_ICON_CATALOG,
  getAgentIcon,
  MAX_AVATAR_ICON_SEARCH_RESULTS,
  resolveAgentIcon,
  searchAvatarIcons,
  WORKER_ICONS,
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
    test("keeps the 30-entry worker pool and its established order", () => {
      expect(WORKER_ICONS).toEqual([
        AVATAR_ICON_CATALOG.bot,
        AVATAR_ICON_CATALOG.cat,
        AVATAR_ICON_CATALOG.dog,
        AVATAR_ICON_CATALOG.bird,
        AVATAR_ICON_CATALOG.fish,
        AVATAR_ICON_CATALOG.bug,
        AVATAR_ICON_CATALOG.snail,
        AVATAR_ICON_CATALOG.turtle,
        AVATAR_ICON_CATALOG.squirrel,
        AVATAR_ICON_CATALOG.cherry,
        AVATAR_ICON_CATALOG.apple,
        AVATAR_ICON_CATALOG.carrot,
        AVATAR_ICON_CATALOG.leaf,
        AVATAR_ICON_CATALOG.sprout,
        AVATAR_ICON_CATALOG["tree-deciduous"],
        AVATAR_ICON_CATALOG.flower,
        AVATAR_ICON_CATALOG.mountain,
        AVATAR_ICON_CATALOG.sun,
        AVATAR_ICON_CATALOG.moon,
        AVATAR_ICON_CATALOG.cloud,
        AVATAR_ICON_CATALOG.snowflake,
        AVATAR_ICON_CATALOG.sparkles,
        AVATAR_ICON_CATALOG.star,
        AVATAR_ICON_CATALOG.rocket,
        AVATAR_ICON_CATALOG.plane,
        AVATAR_ICON_CATALOG.anchor,
        AVATAR_ICON_CATALOG.compass,
        AVATAR_ICON_CATALOG.telescope,
        AVATAR_ICON_CATALOG.atom,
        AVATAR_ICON_CATALOG.crown,
      ]);
    });
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

    test("keeps fixed seeds on their established fallback icons", () => {
      expect(getAgentIcon({ agentId: "fixed-seed-alpha" })).toBe(AVATAR_ICON_CATALOG.snail);
      expect(getAgentIcon({ agentId: "fixed-seed-beta" })).toBe(AVATAR_ICON_CATALOG.moon);
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

  describe("avatar icon picker search", () => {
    test("returns the exact familiar shortlist for an empty query, not just its length", () => {
      // Explicit contents (not just `.toHaveLength(64)`) so this can't silently
      // drift to a different 64 if AVATAR_ICON_CATALOG is ever reordered.
      const results = searchAvatarIcons("");
      expect(results.iconResults).toEqual([
        "bot",
        "cat",
        "dog",
        "bird",
        "fish",
        "bug",
        "snail",
        "turtle",
        "squirrel",
        "rabbit",
        "cherry",
        "apple",
        "carrot",
        "leaf",
        "sprout",
        "tree-deciduous",
        "flower",
        "mountain",
        "sun",
        "moon",
        "cloud",
        "snowflake",
        "sparkles",
        "star",
        "rocket",
        "plane",
        "anchor",
        "compass",
        "telescope",
        "atom",
        "crown",
        "award",
        "book",
        "box",
        "briefcase",
        "camera",
        "coffee",
        "diamond",
        "droplet",
        "feather",
        "flag",
        "flame",
        "gem",
        "ghost",
        "gift",
        "globe",
        "heart",
        "key",
        "lock",
        "map",
        "music",
        "package",
        "palette",
        "pizza",
        "puzzle",
        "shield",
        "skull",
        "sword",
        "target",
        "trophy",
        "umbrella",
        "wand",
        "zap",
        "wrench",
      ]);
      expect(results.totalMatches).toBe(64);
    });

    test("normalizes case, spaces, and hyphens", () => {
      expect(searchAvatarIcons("TREE DECIDUOUS").iconResults).toContain("tree-deciduous");
      expect(searchAvatarIcons("tree-deciduous").iconResults).toContain("tree-deciduous");
    });

    test("returns no choices for an unmatched query", () => {
      expect(searchAvatarIcons("not-an-icon-at-all")).toEqual({ iconResults: [], totalMatches: 0 });
    });

    test("caps broad searches at 100 choices while retaining the match total", () => {
      const results = searchAvatarIcons("a");
      expect(results.totalMatches).toBeGreaterThan(MAX_AVATAR_ICON_SEARCH_RESULTS);
      expect(results.iconResults).toHaveLength(MAX_AVATAR_ICON_SEARCH_RESULTS);
    });

    test("the catalog has no duplicate-glyph deprecated-alias pairs", () => {
      // Every icon component in the catalog should be unique — a deprecated
      // lucide alias re-exports the SAME component as its canonical name, so
      // two catalog keys pointing at the same component is exactly that bug.
      const seen = new Map<unknown, string>();
      const dupes: Array<{ key: string; dupOf: string }> = [];
      for (const [key, icon] of Object.entries(AVATAR_ICON_CATALOG)) {
        const existing = seen.get(icon);
        if (existing) dupes.push({ key, dupOf: existing });
        else seen.set(icon, key);
      }
      expect(dupes).toEqual([]);
    });

    test("covers previously-unreachable d-z avatar-worthy searches", () => {
      // Round-3 fix: the catalog used to be an alphabetical head-slice
      // (a/b/c only), so none of these ever returned a result.
      for (const query of [
        "wrench",
        "gamepad",
        "sword",
        "rocket",
        "crown",
        "heart",
        "star",
        "zap",
      ]) {
        expect(searchAvatarIcons(query).totalMatches).toBeGreaterThan(0);
      }
      for (const query of ["ghost", "cat", "dog", "pizza", "music"]) {
        expect(searchAvatarIcons(query).totalMatches).toBeGreaterThan(0);
      }
      // Spot-check letters that were entirely absent before this round.
      for (const query of ["guitar", "octagon", "volleyball", "wheat"]) {
        expect(searchAvatarIcons(query).totalMatches).toBeGreaterThan(0);
      }
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
