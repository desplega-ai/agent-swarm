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
 * Architecture note: this tool runs on the API server (per
 * `src/server.ts:155`+ pattern) and accesses `src/be/db` directly. The
 * worker-side DB-boundary invariant doesn't apply because `src/tools/*`
 * lives on the API side.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { authorizeAssetKeyWrite } from "@/be/asset-key-auth";
import { resolveTaskAuditUserId } from "@/be/audit-user";
import { createPage, getPage, getPageBySlug, getPageVersions, updatePage } from "@/be/db";
import { snapshotPage } from "@/pages/version";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { AssetKeySchema, PageAuthModeSchema, PageContentTypeSchema } from "@/types";
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

/**
 * Edit counter for a page — `MAX(page_versions.version) + 1`. Returned to
 * the agent as `version` so they have a monotonic "this page has been
 * edited N times" signal. Mirrors the value returned by
 * `PUT /api/pages/:id` (see src/http/pages.ts:pageEditCounter).
 */
function pageEditCounter(pageId: string): number {
  const versions = getPageVersions(pageId);
  return versions.length > 0 ? versions[0]!.version + 1 : 1;
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
        "specs that don't need a long-lived process.",
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
          .describe("Full page body (HTML document or JSON-render spec, per contentType)."),
        contentType: PageContentTypeSchema.describe(
          "'text/html' renders directly at /p/:id; 'application/json' is rendered by the SPA.",
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
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        id: z.string().optional(),
        key: AssetKeySchema.optional(),
        version: z.number().optional(),
        app_url: z.string().optional(),
        api_url: z.string().optional(),
      }),
    },
    async (input, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        const msg = "Agent ID required. Set the X-Agent-ID header on the MCP request.";
        return toolErr(msg);
      }

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
      const existing = getPageBySlug(requestInfo.agentId, finalSlug);
      const trustedUserId = resolveTaskAuditUserId(requestInfo.sourceTaskId, requestInfo.agentId);
      let assetKey: string | undefined;
      try {
        if (input.key !== undefined || !existing) {
          assetKey = input.key ? authorizeAssetKeyWrite(input.key, trustedUserId) : undefined;
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
          snapshotPage(existing.id, requestInfo.agentId);
        } catch {
          // intentional empty
        }
        const updated = updatePage(existing.id, {
          key: assetKey,
          title: input.title,
          description: input.description,
          contentType: input.contentType,
          authMode: input.authMode,
          passwordHash: passwordHash ?? null,
          body: input.body,
          needsCredentials: needsCredentialsNames ?? null,
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
          const created = createPage({
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
      const fresh = getPage(id);
      if (!fresh) {
        const msg = `Page ${id} disappeared between write and read.`;
        return toolErr(msg, { data: { yourAgentId: requestInfo.agentId, id } });
      }

      const apiUrl = `${getApiBaseUrl()}/p/${id}`;
      const appUrl = `${getAppBaseUrl()}/pages/${id}`;
      const version = pageEditCounter(id);

      return toolOk(`Page "${input.title}" saved (slug=${finalSlug}, version=${version}).`, {
        details: `API: ${apiUrl}\n  App: ${appUrl}`,
        data: {
          yourAgentId: requestInfo.agentId,
          id,
          key: fresh.key,
          version,
          app_url: appUrl,
          api_url: apiUrl,
        },
      });
    },
  );
};
