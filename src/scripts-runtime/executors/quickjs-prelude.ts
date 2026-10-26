/**
 * JavaScript that the quickjs runner evaluates inside the sandbox before the
 * user bundle. It rebuilds the script `ctx` (swarm, api, mcp, stdlib, logger)
 * on top of the host functions:
 *
 *  - `__host_call(path, argsJson)`: async host call, resolves to a JSON envelope.
 *  - `__host_sync(op, json)`: sync host call, returns a JSON envelope.
 *    `crypto.random` returns that many random bytes.
 *  - `__host_log(stream, text)`: append to the captured stdout or stderr.
 *  - `__host_sleep(ms)`: resolves after `ms` on the host clock.
 *  - `__host_done(json)`: reports the final outcome of the run.
 *
 * Every value crosses the boundary as JSON. The sandbox has no other way out.
 * `SANDBOX_WEB_SHIMS` (quickjs-web-shims.ts) runs first and adds URL,
 * URLSearchParams, TextEncoder and TextDecoder.
 * `__swarm_shape` (injected before this file) lists the configured api/mcp
 * connections and the `ctx.fs` methods, so `ctx` matches the native executor exactly.
 */
export const SANDBOX_PRELUDE = String.raw`(() => {
"use strict";
const shape = globalThis.__swarm_shape;

const unwrap = (json) => {
  const envelope = JSON.parse(json);
  if (envelope.error !== undefined) {
    const error = new Error(envelope.error.message);
    if (envelope.error.name) error.name = envelope.error.name;
    throw error;
  }
  return envelope.value;
};
const hostCall = async (path, args) =>
  unwrap(await __host_call(path, JSON.stringify(args === undefined ? null : args)));
const hostSync = (op, value) => unwrap(__host_sync(op, JSON.stringify(value === undefined ? null : value)));

// ── console ──
const format = (value) => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ? value.name + ": " + value.message + "\n" + value.stack : String(value);
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
};
const logTo = (stream) => (...args) => __host_log(stream, args.map(format).join(" ") + "\n");
const console = {
  log: logTo("stdout"),
  info: logTo("stdout"),
  debug: logTo("stdout"),
  warn: logTo("stderr"),
  error: logTo("stderr"),
};

// ── timers ──
let timerSeq = 0;
const timers = new Set();
const setTimeout = (fn, ms, ...args) => {
  const id = ++timerSeq;
  timers.add(id);
  __host_sleep(Number(ms) || 0).then(() => {
    if (timers.delete(id)) fn(...args);
  });
  return id;
};
const clearTimeout = (id) => {
  timers.delete(id);
};
// Shares the timer ids with setTimeout, so either clear function stops either.
const setInterval = (fn, ms, ...args) => {
  const id = ++timerSeq;
  const delay = Math.max(1, Number(ms) || 0);
  timers.add(id);
  const tick = () =>
    __host_sleep(delay).then(() => {
      if (!timers.has(id)) return;
      tick();
      fn(...args);
    });
  tick();
  return id;
};
const clearInterval = clearTimeout;

// ── crypto (bytes come from the host CSPRNG) ──
const INTEGER_ARRAYS = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, BigInt64Array, BigUint64Array];
const getRandomValues = (array) => {
  if (!INTEGER_ARRAYS.some((type) => array instanceof type)) {
    throw new TypeError("crypto.getRandomValues: the argument must be an integer TypedArray");
  }
  new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(hostSync("crypto.random", array.byteLength));
  return array;
};
const randomUUID = () => {
  const bytes = hostSync("crypto.random", 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((b) => (b + 256).toString(16).slice(1)).join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
};
const crypto = Object.freeze({ getRandomValues, randomUUID });

// ── Redacted ──
const redactedEntries = new WeakMap();
const redactedProto = Object.freeze({
  toString() {
    return "<redacted>";
  },
  toJSON() {
    return "<redacted>";
  },
});
const entryOf = (self) => {
  const entry = redactedEntries.get(self);
  if (!entry) throw new Error("Redacted value was not in registry");
  return entry;
};
const hostRedacted = (hostId) => {
  const value = Object.create(redactedProto);
  redactedEntries.set(value, { hostId });
  return value;
};
const Redacted = Object.freeze({
  make(value, meta = { type: "user", isSecret: false }) {
    const redacted = Object.create(redactedProto);
    redactedEntries.set(redacted, { value, meta });
    return redacted;
  },
  value(self) {
    const entry = entryOf(self);
    return "hostId" in entry ? hostSync("redacted.value", entry.hostId) : entry.value;
  },
  meta(self) {
    const entry = entryOf(self);
    return "hostId" in entry ? hostSync("redacted.meta", entry.hostId) : entry.meta;
  },
  isSecret(self) {
    return Redacted.meta(self).isSecret;
  },
});

const config = Object.freeze({
  apiKey: hostRedacted("system:apiKey"),
  agentId: hostRedacted("system:agentId"),
  mcpBaseUrl: hostRedacted("system:mcpBaseUrl"),
  runtimeInstanceId: shape.hasRuntimeInstanceId ? hostRedacted("system:runtimeInstanceId") : undefined,
  extensionToken: undefined,
  get(key) {
    return hostSync("config.has", key) ? hostRedacted("user:" + key) : undefined;
  },
});

// ── fetch ──
class Headers {
  constructor(init) {
    this._map = new Map();
    const pairs = init == null ? [] : Array.isArray(init) ? init
      : typeof init.entries === "function" ? Array.from(init.entries()) : Object.entries(init);
    for (const [key, value] of pairs) this._map.set(String(key).toLowerCase(), String(value));
  }
  get(key) {
    const value = this._map.get(String(key).toLowerCase());
    return value === undefined ? null : value;
  }
  has(key) {
    return this._map.has(String(key).toLowerCase());
  }
  set(key, value) {
    this._map.set(String(key).toLowerCase(), String(value));
  }
  entries() {
    return this._map.entries();
  }
  keys() {
    return this._map.keys();
  }
  forEach(callback) {
    this._map.forEach((value, key) => callback(value, key, this));
  }
  [Symbol.iterator]() {
    return this._map.entries();
  }
}
class Response {
  constructor(raw) {
    this.status = raw.status;
    this.statusText = raw.statusText;
    this.ok = raw.ok;
    this.url = raw.url;
    this.headers = new Headers(raw.headers);
    this._body = raw.body;
    this.bodyUsed = false;
  }
  async text() {
    this.bodyUsed = true;
    return this._body;
  }
  async json() {
    this.bodyUsed = true;
    return JSON.parse(this._body);
  }
}
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const toBase64 = (bytes) => {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += BASE64[n >> 18] + BASE64[(n >> 12) & 63] + BASE64[(n >> 6) & 63] + BASE64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8);
    out += BASE64[n >> 18] + BASE64[(n >> 12) & 63] + (i + 1 < bytes.length ? BASE64[(n >> 6) & 63] : "=") + "=";
  }
  return out;
};
// Binary bodies cross the host boundary as base64; the host decodes them.
const encodeBody = (body, headers) => {
  if (body == null) return {};
  if (typeof body === "string") return { body };
  if (body instanceof globalThis.URLSearchParams) {
    if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    return { body: body.toString() };
  }
  if (body instanceof ArrayBuffer) return { bodyBase64: toBase64(new Uint8Array(body)) };
  if (ArrayBuffer.isView(body)) {
    return { bodyBase64: toBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)) };
  }
  throw new TypeError(
    "quickjs executor: fetch body must be a string, Uint8Array, ArrayBuffer or URLSearchParams (JSON.stringify objects first)",
  );
};
const toRequest = (input, init) => {
  const options = init || {};
  const url = typeof input === "string" ? input : input && (input.href || input.url) ? input.href || input.url : String(input);
  const headerMap = new Headers(options.headers);
  const body = encodeBody(options.body, headerMap);
  const headerList = Array.from(headerMap.entries());
  const headers = options.headers == null && headerList.length === 0 ? undefined : headerList;
  const request = { url, method: options.method, headers, ...body };
  if (options.retries !== undefined) request.retries = options.retries;
  if (options.timeoutMs !== undefined) request.timeoutMs = options.timeoutMs;
  return request;
};
const fetch = async (input, init) => new Response(await hostCall("fetch", [toRequest(input, init)]));

const unavailable = (name) => () => {
  throw new Error(name + " is not available in the quickjs executor (no filesystem access)");
};
const stdlib = Object.freeze({
  fetch: async (input, options) => new Response(await hostCall("stdlib.fetch", [toRequest(input, options)])),
  fetchJson: async (input, options) => hostCall("stdlib.fetchJson", [toRequest(input, options)]),
  glob: unavailable("ctx.stdlib.glob"),
  grep: unavailable("ctx.stdlib.grep"),
  table: (rows) => hostSync("table", rows),
  Redacted,
});

// ── ctx ──
const method = (path) => (...args) => hostCall(path, args);
const room = Object.freeze({
  get: method("swarm.room.get"),
  change: method("swarm.room.change"),
  reset: method("swarm.room.reset"),
  decode: method("swarm.room.decode"),
});
const swarm = new Proxy({ room, config }, {
  get(target, prop) {
    if (typeof prop !== "string") return undefined;
    if (prop in target) return target[prop];
    if (prop === "then") return undefined;
    return method("swarm." + prop);
  },
});
const registry = (kind) => {
  const out = {};
  for (const [slug, names] of Object.entries(shape[kind])) {
    const client = {};
    for (const name of names) client[name] = method(kind + "." + slug + "." + name);
    out[slug] = client;
  }
  return out;
};
// ctx.fs / ctx.sh run on the host (script-fs.ts): agent-fs at /afs, scratch memory elsewhere.
const fs = Object.freeze(Object.fromEntries(shape.fs.map((name) => [name, method("fs." + name)])));
const sh = (command, options) => hostCall("sh", options === undefined ? [command] : [command, options]);
const ctx = Object.freeze({ swarm, api: registry("api"), mcp: registry("mcp"), fs, sh, stdlib, logger: console });

const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
define("console", console);
define("setTimeout", setTimeout);
define("clearTimeout", clearTimeout);
define("setInterval", setInterval);
define("clearInterval", clearInterval);
define("crypto", crypto);
define("fetch", fetch);
define("Headers", Headers);
define("Response", Response);
define("__swarm_stdlib", stdlib);
define("__swarm_ctx", ctx);
})();
`;

/**
 * Runs the script's default export with `(args, ctx)` after the optional
 * zod `argsSchema` check, the same contract as `eval-harness.ts`.
 */
export const SANDBOX_EPILOGUE = String.raw`(async () => {
  const isStructuralSchemaNode = (schema) => {
    if (!schema || typeof schema !== "object") return false;
    const def = schema._zod && schema._zod.def;
    if (!def || typeof def !== "object") return false;
    if (def.coerce) return false;
    if (Array.isArray(def.checks) && def.checks.length > 0) return false;
    switch (def.type) {
      case "string":
      case "number":
        return !def.format;
      case "boolean":
      case "literal":
      case "enum":
        return true;
      case "optional":
      case "nullable":
        return isStructuralSchemaNode(def.innerType);
      case "array":
        return isStructuralSchemaNode(def.element);
      case "object": {
        const rawShape = typeof def.shape === "function" ? def.shape() : def.shape;
        if (!rawShape || typeof rawShape !== "object") return false;
        return Object.values(rawShape).every(isStructuralSchemaNode);
      }
      default:
        return false;
    }
  };
  const isHostValidationEquivalent = (schema, value) => {
    if (!schema || typeof schema !== "object") return false;
    const def = schema._zod && schema._zod.def;
    if (!def || typeof def !== "object") return false;
    if (def.coerce) return false;
    if (Array.isArray(def.checks) && def.checks.length > 0) return false;
    switch (def.type) {
      case "string":
        return typeof value === "string" && !def.format;
      case "number":
        return typeof value === "number" && Number.isFinite(value) && !def.format;
      case "boolean":
        return typeof value === "boolean";
      case "literal": {
        const rawValues = def.values;
        const values = Array.isArray(rawValues)
          ? rawValues
          : rawValues instanceof Set
            ? Array.from(rawValues)
            : [];
        return (
          values.length > 0 &&
          values.some((v) => v === value && typeof v !== "bigint" && typeof v !== "symbol")
        );
      }
      case "enum": {
        if (schema._zod && schema._zod.values instanceof Set) {
          return schema._zod.values.has(value);
        }
        const entriesObj = def.entries && typeof def.entries === "object" ? def.entries : null;
        if (!entriesObj) return false;
        const entries = Object.values(entriesObj).filter(
          (v) => !(typeof v === "string" && typeof entriesObj[v] === "number"),
        );
        return entries.length > 0 && entries.includes(value);
      }
      case "optional":
        return value === undefined
          ? isStructuralSchemaNode(def.innerType)
          : isHostValidationEquivalent(def.innerType, value);
      case "nullable":
        return value === null
          ? isStructuralSchemaNode(def.innerType)
          : isHostValidationEquivalent(def.innerType, value);
      case "array":
        return (
          Array.isArray(value) &&
          isStructuralSchemaNode(def.element) &&
          value.every((item) => isHostValidationEquivalent(def.element, item))
        );
      case "object": {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
        const shape = typeof def.shape === "function" ? def.shape() : def.shape;
        if (!shape || typeof shape !== "object") return false;
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(shape, key)) return false;
        }
        for (const [key, propSchema] of Object.entries(shape)) {
          if (!Object.hasOwn(value, key) && key in value) return false;
          const propValue = value[key];
          if (!isHostValidationEquivalent(propSchema, propValue)) return false;
        }
        return true;
      }
      default:
        return false;
    }
  };
  const mod = globalThis.__swarm_module;
  if (!mod || typeof mod.default !== "function") {
    throw new Error(
      "Swarm script must export a default function. Script must export default async function (args, ctx): args FIRST, ctx second.",
    );
  }
  const hostValidatedArgs = globalThis.__swarm_host_validated_args === true;
  let args = globalThis.__swarm_args;
  if (
    mod.argsSchema &&
    typeof mod.argsSchema === "object" &&
    "parse" in mod.argsSchema &&
    !(hostValidatedArgs && isHostValidationEquivalent(mod.argsSchema, args))
  ) {
    try {
      args = mod.argsSchema.parse(args);
    } catch (error) {
      if (error && typeof error === "object" && Array.isArray(error.issues)) {
        const issues = error.issues
          .map((issue) => "  " + (issue.path.length ? issue.path.join(".") : "(root)") + ": " + issue.message)
          .join("\n");
        throw new Error("argsSchema validation failed:\n" + issues);
      }
      throw error;
    }
  }
  return await mod.default(args, globalThis.__swarm_ctx);
})().then(
  (value) => {
    let json;
    try {
      json = JSON.stringify({ ok: true, result: value === undefined ? null : value });
    } catch (error) {
      json = JSON.stringify({
        ok: false,
        error: { name: "TypeError", message: "Script result is not JSON-serializable: " + error.message, stack: "" },
      });
    }
    __host_done(json);
  },
  (error) =>
    __host_done(
      JSON.stringify({
        ok: false,
        error: {
          name: (error && error.name) || "Error",
          message: error && error.message !== undefined ? String(error.message) : String(error),
          stack: (error && error.stack) || "",
        },
      }),
    ),
);
`;
