/**
 * JavaScript that the quickjs runner evaluates inside the sandbox before the
 * user bundle. It rebuilds the script `ctx` (swarm, api, mcp, stdlib, logger)
 * on top of the host functions:
 *
 *  - `__host_call(path, argsJson)`: async host call, resolves to a JSON envelope.
 *  - `__host_sync(op, json)`: sync host call, returns a JSON envelope.
 *  - `__host_log(stream, text)`: append to the captured stdout or stderr.
 *  - `__host_sleep(ms)`: resolves after `ms` on the host clock.
 *  - `__host_done(json)`: reports the final outcome of the run.
 *
 * Every value crosses the boundary as JSON. The sandbox has no other way out.
 * `__swarm_shape` (injected before this file) lists the configured api/mcp
 * connections so `ctx.api.<slug>` matches the native executor exactly.
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

// ── fetch (text bodies only) ──
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
const toRequest = (input, init) => {
  const options = init || {};
  const url = typeof input === "string" ? input : input && (input.href || input.url) ? input.href || input.url : String(input);
  if (options.body != null && typeof options.body !== "string") {
    throw new TypeError("quickjs executor: fetch body must be a string (JSON.stringify it first)");
  }
  const headers = options.headers == null ? undefined : Array.from(new Headers(options.headers).entries());
  const request = { url, method: options.method, headers, body: options.body == null ? undefined : options.body };
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
const ctx = Object.freeze({ swarm, api: registry("api"), mcp: registry("mcp"), stdlib, logger: console });

const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
define("console", console);
define("setTimeout", setTimeout);
define("clearTimeout", clearTimeout);
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
  const mod = globalThis.__swarm_module;
  if (!mod || typeof mod.default !== "function") {
    throw new Error(
      "Swarm script must export a default function. Script must export default async function (args, ctx): args FIRST, ctx second.",
    );
  }
  let args = globalThis.__swarm_args;
  if (mod.argsSchema && typeof mod.argsSchema === "object" && "parse" in mod.argsSchema) {
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
