import { z } from "zod";

export const argsSchema = z.object({
  data: z.unknown().describe("Any JSON value to query (object, array, or scalar)"),
  query: z
    .string()
    .describe(
      "jq-style path: dot fields, [n] index, [] iterate, | pipe, and keys/values/length/type",
    ),
});

function getProp(value: any, key: string): any {
  if (value == null) return undefined;
  if (typeof value !== "object") return undefined;
  return value[key];
}

function applyToken(stream: any[], token: string): any[] {
  const next: any[] = [];
  for (const value of stream) {
    if (token === "[]") {
      if (Array.isArray(value)) {
        for (const item of value) next.push(item);
      } else if (value && typeof value === "object") {
        for (const k of Object.keys(value)) next.push(value[k]);
      }
      continue;
    }
    const idx = token.match(/^\[(-?\d+)\]$/);
    if (idx) {
      let i = Number.parseInt(idx[1] as string, 10);
      if (Array.isArray(value) && i < 0) i += value.length;
      next.push(Array.isArray(value) ? value[i] : undefined);
      continue;
    }
    const quoted = token.match(/^\["([^"]*)"\]$/);
    if (quoted) {
      next.push(getProp(value, quoted[1] as string));
      continue;
    }
    const field = token.match(/^\.([a-zA-Z_$][\w$]*)$/);
    if (field) {
      next.push(getProp(value, field[1] as string));
      continue;
    }
    if (token === "." || token === "") {
      next.push(value);
      continue;
    }
    throw "unrecognized path token: " + token;
  }
  return next;
}

function applyFunction(stream: any[], name: string): any[] {
  return stream.map((value: any) => {
    if (name === "length") {
      if (Array.isArray(value) || typeof value === "string") return value.length;
      if (value && typeof value === "object") return Object.keys(value).length;
      return 0;
    }
    if (name === "keys") {
      return value && typeof value === "object" ? Object.keys(value) : [];
    }
    if (name === "values") {
      if (Array.isArray(value)) return value;
      return value && typeof value === "object" ? Object.values(value) : [];
    }
    if (name === "type") {
      if (value === null) return "null";
      if (Array.isArray(value)) return "array";
      return typeof value;
    }
    throw "unknown function: " + name;
  });
}

function applyStage(stream: any[], stage: string): any[] {
  const trimmed = stage.trim();
  if (/^(keys|values|length|type)$/.test(trimmed)) {
    return applyFunction(stream, trimmed);
  }
  let rest = trimmed;
  let current = stream;
  if (rest === "." || rest === "") return current;
  while (rest.length > 0) {
    const m = rest.match(/^(\[\]|\[-?\d+\]|\["[^"]*"\]|\.[a-zA-Z_$][\w$]*|\.)/);
    if (!m) throw "could not parse path near: " + rest;
    const token = m[1] as string;
    current = applyToken(current, token);
    rest = rest.slice(token.length);
  }
  return current;
}

/** Run a jq-style path/filter query over a JSON value — replaces curl|jq pipelines. */
export default async function jsonQuery(args: any, _ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const { query } = parsed.data;

  let data: any = parsed.data.data;
  if (typeof data === "string") {
    const t = data.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        data = JSON.parse(t);
      } catch {
        // Leave as a plain string if it is not valid JSON.
      }
    }
  }

  try {
    let stream: any[] = [data];
    for (const stage of query.split("|")) {
      stream = applyStage(stream, stage);
    }
    const result = stream.length === 1 ? stream[0] : stream;
    return { result, matches: stream.length };
  } catch (err) {
    return { error: typeof err === "string" ? err : "query failed" };
  }
}
