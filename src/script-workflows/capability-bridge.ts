import { SCRIPT_SDK_RESPONSE_LIMIT_BYTES } from "../scripts-runtime/response-limit";

type CapabilityRequest = {
  type: "invoke";
  id: string;
  path: string;
  argsJson: string;
};

type SerializedError = {
  name: string;
  message: string;
};

type CapabilityResponse =
  | { type: "result"; id: string; resultJson: string }
  | { type: "error"; id: string; error: SerializedError };

export type CapabilityDispatch = (path: string, argsJson: string) => Promise<string>;
export type CapabilitySend = (message: string) => void | Promise<void>;

// Generous enough for workflow fan-out while bounding guest-retained promises and host work.
export const MAX_PENDING_CAPABILITY_CALLS = 64;

export type CapabilityClient = {
  invokeTool(path: string, argsJson: string): Promise<string>;
  handleMessage(message: unknown): void;
  disconnect(error?: Error): void;
  pendingCount(): number;
};

function protocolError(kind: "request" | "response", detail: string): Error {
  return new Error(`Malformed capability ${kind}: ${detail}`);
}

function parseJsonObject(message: unknown, kind: "request" | "response"): Record<string, unknown> {
  if (typeof message !== "string") {
    throw protocolError(kind, "expected a JSON string");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    throw protocolError(kind, "expected valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw protocolError(kind, "expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function assertJsonString(value: string, kind: "request" | "response", field: string): void {
  try {
    JSON.parse(value);
  } catch {
    throw protocolError(kind, `\`${field}\` must contain valid JSON`);
  }
}

function parseRequest(message: unknown): CapabilityRequest {
  const value = parseJsonObject(message, "request");
  if (value.type !== "invoke") throw protocolError("request", "expected type `invoke`");
  if (typeof value.id !== "string" || !value.id) {
    throw protocolError("request", "expected non-empty string `id`");
  }
  if (typeof value.path !== "string" || !value.path) {
    throw protocolError("request", "expected non-empty string `path`");
  }
  if (typeof value.argsJson !== "string") {
    throw protocolError("request", "expected string `argsJson`");
  }
  assertJsonString(value.argsJson, "request", "argsJson");
  return value as CapabilityRequest;
}

function parseResponse(message: unknown): CapabilityResponse {
  const value = parseJsonObject(message, "response");
  if (typeof value.id !== "string" || !value.id) {
    throw protocolError("response", "expected non-empty string `id`");
  }
  if (value.type === "result") {
    if (typeof value.resultJson !== "string") {
      throw protocolError("response", "expected string `resultJson`");
    }
    assertJsonString(value.resultJson, "response", "resultJson");
    return value as CapabilityResponse;
  }
  if (value.type === "error") {
    const error = value.error;
    if (
      !error ||
      typeof error !== "object" ||
      Array.isArray(error) ||
      typeof (error as Record<string, unknown>).name !== "string" ||
      typeof (error as Record<string, unknown>).message !== "string"
    ) {
      throw protocolError("response", "expected a serialized `error`");
    }
    return value as CapabilityResponse;
  }
  throw protocolError("response", "expected type `result` or `error`");
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message,
    };
  }
  return { name: "Error", message: String(error) };
}

function deserializeError(error: SerializedError): Error {
  const deserialized = new Error(error.message);
  deserialized.name = error.name;
  return deserialized;
}

function resultTooLarge(path: string, limitBytes: number, observedBytes: number): Error {
  return new Error(
    `Capability result for ${path} exceeded the ${limitBytes}-byte hard limit ` +
      `(${observedBytes} bytes observed); narrow the query or paginate the request.`,
  );
}

function encodeResponseWithinLimit(
  response: CapabilityResponse,
  request: CapabilityRequest,
  limitBytes: number,
): string {
  const encoded = JSON.stringify(response);
  const observedBytes = new TextEncoder().encode(encoded).byteLength;
  if (observedBytes <= limitBytes) return encoded;

  const fallback = JSON.stringify({
    type: "error",
    id: request.id,
    error: serializeError(resultTooLarge(request.path, limitBytes, observedBytes)),
  } satisfies CapabilityResponse);
  if (new TextEncoder().encode(fallback).byteLength > limitBytes) {
    throw new Error(`Capability response limit ${limitBytes} is too small for an error envelope`);
  }
  return fallback;
}

export async function handleCapabilityRequest(
  message: unknown,
  dispatch: CapabilityDispatch,
  send?: CapabilitySend,
  limitBytes = SCRIPT_SDK_RESPONSE_LIMIT_BYTES,
): Promise<string> {
  const request = parseRequest(message);
  let response: string;
  try {
    const resultJson = await dispatch(request.path, request.argsJson);
    if (typeof resultJson !== "string") {
      throw new Error("Capability dispatch must return a JSON string");
    }
    assertJsonString(resultJson, "response", "resultJson");
    const resultBytes = new TextEncoder().encode(resultJson).byteLength;
    if (resultBytes > limitBytes) {
      throw resultTooLarge(request.path, limitBytes, resultBytes);
    }
    response = encodeResponseWithinLimit(
      { type: "result", id: request.id, resultJson },
      request,
      limitBytes,
    );
  } catch (error) {
    response = encodeResponseWithinLimit(
      { type: "error", id: request.id, error: serializeError(error) },
      request,
      limitBytes,
    );
  }
  await send?.(response);
  return response;
}

export function createCapabilityClient(send: CapabilitySend): CapabilityClient {
  let nextId = 1;
  let disconnected: Error | undefined;
  const pending = new Map<
    string,
    { resolve: (resultJson: string) => void; reject: (error: Error) => void }
  >();

  return {
    invokeTool(path, argsJson) {
      if (disconnected) return Promise.reject(disconnected);
      if (!path) return Promise.reject(new Error("Capability path must not be empty"));
      if (pending.size >= MAX_PENDING_CAPABILITY_CALLS) {
        return Promise.reject(
          new Error(`Capability pending call limit of ${MAX_PENDING_CAPABILITY_CALLS} exceeded`),
        );
      }
      try {
        assertJsonString(argsJson, "request", "argsJson");
      } catch (error) {
        return Promise.reject(error);
      }

      const id = String(nextId++);
      const request = JSON.stringify({
        type: "invoke",
        id,
        path,
        argsJson,
      } satisfies CapabilityRequest);
      return new Promise<string>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          Promise.resolve(send(request)).catch((error) => {
            if (!pending.delete(id)) return;
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    handleMessage(message) {
      const response = parseResponse(message);
      const call = pending.get(response.id);
      if (!call) throw protocolError("response", `unknown request id \`${response.id}\``);
      pending.delete(response.id);
      if (response.type === "result") call.resolve(response.resultJson);
      else call.reject(deserializeError(response.error));
    },

    disconnect(error = new Error("Capability bridge disconnected")) {
      if (disconnected) return;
      disconnected = error;
      for (const call of pending.values()) call.reject(error);
      pending.clear();
    },

    pendingCount() {
      return pending.size;
    },
  };
}
