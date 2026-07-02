// Phase 6: REST surface for the append-only `pricing` price book.
//
// Append-only by design: operators add a NEW row with a later
// `effective_from` rather than mutating an existing row. There is no PUT.
// The only write endpoints are POST (insert) and DELETE (typo correction).
//
// Every POST and DELETE writes a row to `agent_log` with eventType
// `pricing.inserted` / `pricing.deleted` for compliance auditing. The raw
// API key is never logged — only a short SHA-256 fingerprint.

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  createLogEntry,
  deletePricingRow,
  getActivePricingRow,
  getAllPricingRows,
  getPricingRows,
  insertPricingRow,
} from "../be/db";
import { PricingProviderSchema, PricingRowSchema, PricingTokenClassSchema } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function apiKeyFingerprint(req: IncomingMessage): string {
  const authHeader = req.headers.authorization;
  const providedKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!providedKey) return "";
  const digest = createHash("sha256").update(providedKey).digest("hex").slice(0, 8);
  return scrubSecrets(digest);
}

// ─── Route Definitions ───────────────────────────────────────────────────────

const PricingTriplePathParams = z.object({
  provider: PricingProviderSchema,
  model: z.string().min(1),
  tokenClass: PricingTokenClassSchema,
});

const listAllPricing = route({
  method: "get",
  path: "/api/pricing",
  pattern: ["api", "pricing"],
  summary: "List every pricing row across all providers",
  tags: ["Pricing"],
  responses: {
    200: { description: "Pricing rows", schema: z.object({ rows: z.array(PricingRowSchema) }) },
  },
});

const listPricingForTriple = route({
  method: "get",
  path: "/api/pricing/{provider}/{model}/{tokenClass}",
  pattern: ["api", "pricing", null, null, null],
  summary: "List pricing history for a (provider, model, tokenClass) triple",
  tags: ["Pricing"],
  params: PricingTriplePathParams,
  responses: {
    200: { description: "Pricing rows (latest first)" },
  },
});

const getActivePricing = route({
  method: "get",
  path: "/api/pricing/{provider}/{model}/{tokenClass}/active",
  pattern: ["api", "pricing", null, null, null, "active"],
  summary: "Get the currently active pricing row",
  tags: ["Pricing"],
  params: PricingTriplePathParams,
  responses: {
    200: { description: "Active pricing row", schema: PricingRowSchema },
    404: { description: "No pricing row in effect" },
  },
});

const insertPricing = route({
  method: "post",
  path: "/api/pricing/{provider}/{model}/{tokenClass}",
  pattern: ["api", "pricing", null, null, null],
  summary: "Append a new pricing row",
  tags: ["Pricing"],
  params: PricingTriplePathParams,
  body: z.object({
    pricePerMillionUsd: z.number().nonnegative(),
    effectiveFrom: z.number().nonnegative().optional(),
  }),
  responses: {
    201: { description: "Pricing row inserted", schema: PricingRowSchema },
    400: { description: "Validation error" },
    409: { description: "Duplicate (provider, model, tokenClass, effectiveFrom)" },
  },
});

const deletePricing = route({
  method: "delete",
  path: "/api/pricing/{provider}/{model}/{tokenClass}/{effectiveFrom}",
  pattern: ["api", "pricing", null, null, null, null],
  summary: "Delete a pricing row (typo correction)",
  tags: ["Pricing"],
  // `effectiveFrom` is parsed as a numeric string in the path. Using
  // z.string() (instead of z.coerce.number()) keeps the OpenAPI spec valid:
  // `z.coerce.number()` emits a non-required path parameter which trips
  // swagger-cli validation. We re-parse to a number in the handler.
  params: PricingTriplePathParams.extend({
    effectiveFrom: z.string().regex(/^\d+$/, "effectiveFrom must be a non-negative integer"),
  }),
  responses: {
    204: { description: "Pricing row deleted" },
    404: { description: "Pricing row not found" },
  },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handlePricing(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  _myAgentId: string | undefined,
): Promise<boolean> {
  // GET /api/pricing
  if (listAllPricing.match(req.method, pathSegments)) {
    const parsed = await listAllPricing.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    json(res, { rows: getAllPricingRows() });
    return true;
  }

  // GET /api/pricing/{provider}/{model}/{tokenClass}/active — must come BEFORE
  // the 5-segment variants below so the `active` literal is resolved first.
  if (getActivePricing.match(req.method, pathSegments)) {
    const parsed = await getActivePricing.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const row = getActivePricingRow(
      parsed.params.provider,
      parsed.params.model,
      parsed.params.tokenClass,
      Date.now(),
    );
    if (!row) {
      jsonError(res, "No pricing row in effect", 404);
      return true;
    }
    json(res, row);
    return true;
  }

  // DELETE /api/pricing/{provider}/{model}/{tokenClass}/{effectiveFrom}
  // (6-segment delete, matched before the 5-segment list/insert)
  if (deletePricing.match(req.method, pathSegments)) {
    const parsed = await deletePricing.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const effectiveFrom = Number.parseInt(parsed.params.effectiveFrom, 10);
    const deleted = deletePricingRow(
      parsed.params.provider,
      parsed.params.model,
      parsed.params.tokenClass,
      effectiveFrom,
    );
    if (!deleted) {
      jsonError(res, "Pricing row not found", 404);
      return true;
    }

    createLogEntry({
      eventType: "pricing.deleted",
      metadata: {
        provider: parsed.params.provider,
        model: parsed.params.model,
        tokenClass: parsed.params.tokenClass,
        effectiveFrom,
        apiKeyFingerprint: apiKeyFingerprint(req),
      },
    });

    res.writeHead(204);
    res.end();
    return true;
  }

  // GET /api/pricing/{provider}/{model}/{tokenClass}
  if (listPricingForTriple.match(req.method, pathSegments)) {
    const parsed = await listPricingForTriple.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const rows = getPricingRows(
      parsed.params.provider,
      parsed.params.model,
      parsed.params.tokenClass,
    );
    json(res, { rows });
    return true;
  }

  // POST /api/pricing/{provider}/{model}/{tokenClass}
  if (insertPricing.match(req.method, pathSegments)) {
    const parsed = await insertPricing.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const effectiveFrom = parsed.body.effectiveFrom ?? Date.now();

    try {
      const row = insertPricingRow({
        provider: parsed.params.provider,
        model: parsed.params.model,
        tokenClass: parsed.params.tokenClass,
        effectiveFrom,
        pricePerMillionUsd: parsed.body.pricePerMillionUsd,
      });

      createLogEntry({
        eventType: "pricing.inserted",
        metadata: {
          provider: parsed.params.provider,
          model: parsed.params.model,
          tokenClass: parsed.params.tokenClass,
          effectiveFrom,
          pricePerMillionUsd: parsed.body.pricePerMillionUsd,
          apiKeyFingerprint: apiKeyFingerprint(req),
        },
      });

      json(res, row, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // bun:sqlite raises SQLITE_CONSTRAINT for PK collision. Surface as 409.
      if (message.includes("UNIQUE constraint") || message.includes("constraint")) {
        jsonError(
          res,
          "Duplicate pricing row for (provider, model, tokenClass, effectiveFrom). Use a different effectiveFrom.",
          409,
        );
        return true;
      }
      jsonError(res, "Failed to insert pricing row", 500);
    }
    return true;
  }

  return false;
}
