/**
 * `create_page` MCP tool — capability-gated ("pages") agent-facing entry
 * point for the db-backed pages feature. Creates or updates a page row in
 * SQLite and returns shareable URLs.
 *
 * Upsert semantics: keyed by `(agentId, slug)`. If a row already exists,
 * the tool calls `snapshotPage` (preserving pre-update content as a version
 * row) then `updatePage` — mirroring the HTTP `PUT /api/pages/:id` flow.
 * First-create skips the snapshot (no prior state).
 *
 * Slug derivation: explicit `slug` wins; otherwise kebab-case the title; if
 * the title slugifies to empty (e.g. all symbols), fall back to the
 * generated page id.
 *
 * Design fields: `theme`, `themeTokens` and `designVersion` set how an HTML
 * page is styled. A new page gets designVersion 2. On an upsert, an omitted
 * field keeps the stored value, and `null` clears `theme` / `themeTokens`.
 *
 * Architecture note: this tool runs on the API server (per
 * `src/server.ts:155`+ pattern) and accesses `src/be/db` directly. The
 * worker-side DB-boundary invariant doesn't apply because `src/tools/*`
 * lives on the API side.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { authorizeAssetKeyWrite } from "@/be/asset-key-auth";
import { resolveTaskAuditUserId } from "@/be/audit-user";
import { createPage, getPage, getPageBySlug, updatePage } from "@/be/db";
import { getPageEditCounter } from "@/be/db/page-versions";
import { classAttributeValues, countColorLiterals } from "@/pages/color-literals";
import { snapshotPage } from "@/pages/version";
import { readThemeFields } from "@/themes/page-fields";
import { PAGE_THEME_COLOR_TOKENS } from "@/themes/tokens";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import {
  AssetKeySchema,
  type Page,
  PageAuthModeSchema,
  PageContentTypeSchema,
  PageThemeTokensInputSchema,
} from "@/types";
import { getAppUrl, getPublicMcpBaseUrl } from "@/utils/constants";

/** Same slugifier used by the HTTP createPage handler. */
function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug;
}

function getApiBaseUrl(): string {
  return getPublicMcpBaseUrl();
}

function getAppBaseUrl(): string {
  return getAppUrl();
}

/** A `swarm-` primitive class inside one class attribute value. */
const SWARM_CLASS = /(?:^|\s)swarm-/;
const COLOR_TOKEN_REFERENCE = /var\(\s*--color-/i;
const PAGE_COLOR_TOKENS: ReadonlySet<string> = new Set<string>(PAGE_THEME_COLOR_TOKENS);

/** The body uses a `swarm-` class or a `var(--color-...)` token, which only design version 2 styles. */
function bodyUsesDesignSystem(html: string): boolean {
  return (
    COLOR_TOKEN_REFERENCE.test(html) ||
    classAttributeValues(html).some((value) => SWARM_CLASS.test(value))
  );
}

/** The stored overrides set light colors and no dark colors, so dark mode keeps the preset's colors. */
function hasLightOnlyColors(tokens: Page["themeTokens"]): boolean {
  if (!tokens) return false;
  const isColor = (name: string) => PAGE_COLOR_TOKENS.has(name);
  return Object.keys(tokens.light).some(isColor) && !Object.keys(tokens.dark).some(isColor);
}

export const registerCreatePageTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "create_page",
    {
      title: "Create or update a page",
      description:
        "Stores an HTML or JSON page in the swarm and returns shareable URLs. " +
        "Calls are upsert-by-(agent, slug): if you previously created a page " +
        "with the same slug, its prior state is snapshotted and the row is " +
        "updated. Use this for static reports, dashboards, or JSON action " +
        "specs that don't need a long-lived process. " +
        "HTML pages use the swarm design system (designVersion 2): theme " +
        "tokens such as var(--color-primary), the swarm-* primitives, and " +
        "Tailwind v4 utilities such as bg-card and text-muted-foreground. " +
        "Set `theme` to a preset id or pass `themeTokens` (a token map, or a " +
        'CSS variable block with format "css") to restyle the whole page. ' +
        "Do not hardcode colors: inside the dashboard the page follows the " +
        "viewer's theme and dark mode. Pages created before designVersion 2 " +
        "keep the old look; pass designVersion: 2 when you rewrite one.",
      annotations: { destructiveHint: false },
      inputSchema: z.object({
        key: AssetKeySchema.optional().describe(
          "Logical namespace. Defaults to a shared/page:<id>/ resource key.",
        ),
        title: z.string().min(1).describe("Human-readable title shown in listings."),
        slug: z
          .string()
          .min(1)
          .optional()
          .describe(
            "URL slug. Defaults to the kebab-cased title. Same slug → updates the existing row.",
          ),
        body: z
          .string()
          .min(1)
          .describe(
            "Full page body (HTML document, SVG image, or JSON-render spec, per contentType).",
          ),
        contentType: PageContentTypeSchema.describe(
          "'text/html' and 'image/svg+xml' render directly at /p/:id; 'application/json' is rendered by the SPA.",
        ),
        authMode: PageAuthModeSchema.default("authed").describe(
          "'authed' — requires page-session cookie (default); 'public' — no gate and must be explicit; 'password' — requires key.",
        ),
        password: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Plaintext password, hashed before storage. Only meaningful for authMode='password'.",
          ),
        description: z
          .string()
          .optional()
          .describe("Optional short description, used in listings + OG-tag unfurl."),
        needsCredentials: z
          .array(z.object({ name: z.string(), description: z.string() }))
          .optional()
          .describe(
            "Declared credential needs for JSON pages (renderer ignores for v1 — reserved for follow-up).",
          ),
        theme: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Theme preset id that restyles the whole page, for example paper, github or hive. An unknown id returns an error that lists every preset. Omit to follow the viewer's theme (on update, to keep the stored one). Pass null to clear it.",
          ),
        themeTokens: PageThemeTokensInputSchema.nullable()
          .optional()
          .describe(
            'Per-page token overrides, applied on top of the preset. Send { light, dark } maps of token name to CSS value (for example { light: { "--color-primary": "oklch(0.55 0.2 260)" } }), or { format: "css", css } with a CSS variable block (:root, .dark, @theme) as shadcn, tweakcn and Tailwind v4 export it. Stored normalized. Names outside the token contract, and values that reference a variable outside it, are ignored and reported in the result. Replaces the stored overrides. Omit to keep them on update. Pass null to clear them.',
          ),
        designVersion: z
          .number()
          .int()
          .min(1)
          .max(2)
          .optional()
          .describe(
            "Design system version. 2 is the swarm design system and the default for new pages. 1 is the original look that older pages keep. Omit on update to keep the stored value.",
          ),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        id: z.string().optional(),
        key: AssetKeySchema.optional(),
        version: z.number().optional(),
        app_url: z.string().optional(),
        api_url: z.string().optional(),
        designVersion: z.number().optional(),
        ignoredTokens: z.array(z.string()).optional(),
        colorLiteralCount: z.number().optional(),
        usesDesignSystem: z.boolean().optional(),
        lightOnlyColors: z.boolean().optional(),
      }),
    },
    async (input, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        const msg = "Agent ID required. Set the X-Agent-ID header on the MCP request.";
        return toolErr(msg);
      }

      const themeFields = readThemeFields(input);
      if ("error" in themeFields) return toolErr(themeFields.error);

      const slug = input.slug ?? slugify(input.title);
      const finalSlug = slug || "page"; // Fallback if title slugifies to empty.

      // Hash password if provided. We always hash (even for non-password
      // modes) so the column reflects what the caller intended; the mode
      // governs whether the hash is checked at /p/:id serve time.
      let passwordHash: string | undefined;
      if (input.password) {
        passwordHash = await Bun.password.hash(input.password, "bcrypt");
      }

      // `needsCredentials` is declared as `[{name, description}]` on the
      // wire but the DB column accepts string[] (current schema). Flatten
      // to names for v1 — the renderer ignores it anyway. Step-8 may
      // revisit.
      const needsCredentialsNames = input.needsCredentials?.map((c) => c.name);

      // Upsert. Look up existing row by (agentId, slug).
      const existing = await getPageBySlug(requestInfo.agentId, finalSlug);
      const trustedUserId = await resolveTaskAuditUserId(
        requestInfo.sourceTaskId,
        requestInfo.agentId,
      );
      let assetKey: string | undefined;
      try {
        if (input.key !== undefined || !existing) {
          assetKey = input.key ? await authorizeAssetKeyWrite(input.key, trustedUserId) : undefined;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return toolErr(msg, {
          data: { yourAgentId: requestInfo.agentId, id: existing?.id ?? "" },
        });
      }

      let id: string;
      if (existing) {
        // Snapshot first — failure must NOT block the update.
        try {
          await snapshotPage(existing.id, requestInfo.agentId);
        } catch {
          // intentional empty
        }
        const updated = await updatePage(existing.id, {
          key: assetKey,
          title: input.title,
          description: input.description,
          contentType: input.contentType,
          authMode: input.authMode,
          passwordHash: passwordHash ?? null,
          body: input.body,
          needsCredentials: needsCredentialsNames ?? null,
          // Omitted design fields keep the stored values.
          theme: themeFields.theme,
          themeTokens: themeFields.themeTokens,
          designVersion: input.designVersion,
        });
        if (!updated) {
          const msg = `Failed to update existing page ${existing.id}.`;
          return toolErr(msg, {
            data: { yourAgentId: requestInfo.agentId, id: existing.id },
          });
        }
        id = updated.id;
      } else {
        try {
          const created = await createPage({
            key: assetKey,
            agentId: requestInfo.agentId,
            slug: finalSlug,
            title: input.title,
            description: input.description,
            contentType: input.contentType,
            authMode: input.authMode,
            passwordHash,
            body: input.body,
            needsCredentials: needsCredentialsNames,
            theme: themeFields.theme,
            themeTokens: themeFields.themeTokens,
            designVersion: input.designVersion,
          });
          id = created.id;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          const msg = `Failed to create page: ${detail}`;
          return toolErr(msg, { data: { yourAgentId: requestInfo.agentId, id: "" } });
        }
      }

      // Re-read after write so the page exists (defensive). 1 round-trip;
      // page row is small. If it's missing here something's badly wrong.
      const fresh = await getPage(id);
      if (!fresh) {
        const msg = `Page ${id} disappeared between write and read.`;
        return toolErr(msg, { data: { yourAgentId: requestInfo.agentId, id } });
      }

      const apiUrl = `${getApiBaseUrl()}/p/${id}`;
      const appUrl = `${getAppBaseUrl()}/pages/${id}`;
      const version = await getPageEditCounter(id);

      // Judged on the saved page, so an upsert that keeps an older design
      // version is judged by the version it keeps. The NUDGES entry for this
      // tool reads these flags. Only HTML pages get the design system head.
      const designFlags =
        fresh.contentType === "text/html"
          ? {
              usesDesignSystem:
                typeof input.theme === "string" ||
                Boolean(input.themeTokens) ||
                bodyUsesDesignSystem(fresh.body),
              lightOnlyColors: hasLightOnlyColors(fresh.themeTokens),
              ...(fresh.designVersion >= 2
                ? { colorLiteralCount: countColorLiterals(fresh.body) }
                : {}),
            }
          : {};
      const { ignored } = themeFields;

      return toolOk(
        `Page "${input.title}" saved (slug=${finalSlug}, version=${version}, designVersion=${fresh.designVersion}).` +
          (ignored.length > 0
            ? " Some theme tokens were ignored (outside the page token contract or referencing a variable outside it)."
            : ""),
        {
          details:
            `API: ${apiUrl}\n  App: ${appUrl}` +
            (ignored.length > 0 ? `\n  Ignored theme tokens: ${ignored.join(", ")}` : ""),
          data: {
            yourAgentId: requestInfo.agentId,
            id,
            key: fresh.key,
            version,
            app_url: appUrl,
            api_url: apiUrl,
            designVersion: fresh.designVersion,
            ...(ignored.length > 0 ? { ignoredTokens: ignored } : {}),
            ...designFlags,
          },
        },
      );
    },
  );
};
