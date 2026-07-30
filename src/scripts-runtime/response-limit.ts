export const SCRIPT_SDK_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024;

function responseTooLarge(operation: string, limitBytes: number, observedBytes: number): Error {
  return new Error(
    `Script SDK response for ${operation} exceeded the ${limitBytes}-byte hard limit ` +
      `(${observedBytes} bytes observed); narrow the query or paginate the request.`,
  );
}

/**
 * Read and decode a script-internal SDK response without allowing an
 * unbounded body to accumulate in the sandbox heap.
 *
 * The 64 MiB default is intentionally far above the 10 KB model-context
 * ceiling while leaving headroom inside the runtime's 512 MiB process limit
 * for UTF-16 strings, parsed JSON objects, user code, and runtime overhead.
 */
export async function readScriptSdkJsonResponse(
  response: Response,
  operation: string,
  limitBytes = SCRIPT_SDK_RESPONSE_LIMIT_BYTES,
): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > limitBytes) {
    await response.body?.cancel().catch(() => {});
    throw responseTooLarge(operation, limitBytes, contentLength);
  }

  if (!response.body) return {};

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > limitBytes) {
      await reader.cancel().catch(() => {});
      throw responseTooLarge(operation, limitBytes, receivedBytes);
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());

  const text = parts.join("");
  return text ? JSON.parse(text) : {};
}
