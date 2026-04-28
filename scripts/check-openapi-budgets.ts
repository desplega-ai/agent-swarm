// Phase 6 OpenAPI freshness gate: assert the budget + pricing operation
// shapes are present in `openapi.json` after regeneration.
//
// Exits 0 on pass, 1 on fail. CI can later wire this into the merge gate.

import { readFileSync } from "node:fs";

interface Schema {
  type?: string;
  properties?: Record<string, Schema>;
  $ref?: string;
  required?: string[];
}

interface Operation {
  parameters?: Array<{ name: string; in: string; schema: Schema }>;
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
}

interface OpenApiSpec {
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema> };
}

const spec = JSON.parse(readFileSync("openapi.json", "utf8")) as OpenApiSpec;

const failures: string[] = [];

function getRequestSchema(op?: Operation): Schema | undefined {
  return op?.requestBody?.content?.["application/json"]?.schema;
}

function getResponseSchema(op: Operation | undefined, status: string): Schema | undefined {
  return op?.responses?.[status]?.content?.["application/json"]?.schema;
}

// Resolve $ref in components.schemas if necessary.
function resolveRef(schema: Schema | undefined): Schema | undefined {
  if (!schema) return undefined;
  if (schema.$ref) {
    const name = schema.$ref.replace(/^#\/components\/schemas\//, "");
    return spec.components?.schemas?.[name];
  }
  return schema;
}

function expectProp(label: string, schema: Schema | undefined, prop: string, type: string): void {
  const resolved = resolveRef(schema);
  const sub = resolved?.properties?.[prop];
  const actualType = sub?.type;
  if (actualType !== type) {
    failures.push(
      `${label}: expected property '${prop}' of type '${type}', got '${actualType ?? "<missing>"}'`,
    );
  }
}

// ── /api/budgets PUT body shape: { dailyBudgetUsd: number } ──
{
  const op = spec.paths["/api/budgets/{scope}/{scopeId}"]?.put;
  if (!op) failures.push("/api/budgets/{scope}/{scopeId}: PUT operation missing");
  else {
    expectProp("/api/budgets PUT body", getRequestSchema(op), "dailyBudgetUsd", "number");
  }
}

// ── /api/budgets GET 200 response: { budgets: array } ──
{
  const op = spec.paths["/api/budgets"]?.get;
  if (!op) failures.push("/api/budgets: GET operation missing");
  else {
    const schema = getResponseSchema(op, "200");
    expectProp("/api/budgets GET 200", schema, "budgets", "array");
  }
}

// ── /api/pricing/{provider}/{model}/{tokenClass} POST body shape ──
{
  const op = spec.paths["/api/pricing/{provider}/{model}/{tokenClass}"]?.post;
  if (!op) failures.push("/api/pricing/.../tokenClass POST operation missing");
  else {
    expectProp(
      "/api/pricing/.../tokenClass POST body",
      getRequestSchema(op),
      "pricePerMillionUsd",
      "number",
    );
    expectProp(
      "/api/pricing/.../tokenClass POST body",
      getRequestSchema(op),
      "effectiveFrom",
      "number",
    );
  }
}

// ── /api/pricing GET 200 response: { rows: array } ──
{
  const op = spec.paths["/api/pricing"]?.get;
  if (!op) failures.push("/api/pricing: GET operation missing");
  else {
    const schema = getResponseSchema(op, "200");
    expectProp("/api/pricing GET 200", schema, "rows", "array");
  }
}

// ── /api/pricing/.../active GET 200 response: PricingRow shape ──
{
  const op = spec.paths["/api/pricing/{provider}/{model}/{tokenClass}/active"]?.get;
  if (!op) failures.push("/api/pricing/.../active: GET operation missing");
  else {
    const schema = getResponseSchema(op, "200");
    expectProp("/api/pricing/.../active GET 200", schema, "pricePerMillionUsd", "number");
    expectProp("/api/pricing/.../active GET 200", schema, "effectiveFrom", "number");
    expectProp("/api/pricing/.../active GET 200", schema, "provider", "string");
    expectProp("/api/pricing/.../active GET 200", schema, "model", "string");
    expectProp("/api/pricing/.../active GET 200", schema, "tokenClass", "string");
  }
}

if (failures.length > 0) {
  console.error("[check-openapi-budgets] FAIL:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("[check-openapi-budgets] OK — budget + pricing schema shapes present in openapi.json");
