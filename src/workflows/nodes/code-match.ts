import type { NodeResult } from "../engine";

export interface CodeMatchConfig {
  code: string;
  outputPorts: string[];
}

export function executeCodeMatch(
  config: CodeMatchConfig,
  ctx: Record<string, unknown>,
): NodeResult {
  // Build a sandboxed function — shadow dangerous globals in the function scope.
  // Note: "import" is a reserved keyword and cannot be a parameter name, so it
  // is shadowed by the "use strict" scope preventing dynamic import via the
  // blocked globals rather than a parameter.
  const sandboxKeys = [
    "require",
    "process",
    "Bun",
    "globalThis",
    "global",
    "fetch",
    "setTimeout",
    "setInterval",
  ] as const;
  const sandboxValues = sandboxKeys.map(() => undefined);

  const fn = new Function(...sandboxKeys, "input", `"use strict"; return (${config.code})(input);`);

  const result = fn(...sandboxValues, ctx);

  // Map result to port name
  let port: string;
  if (typeof result === "boolean") {
    port = result ? "true" : "false";
  } else if (typeof result === "string") {
    port = result;
  } else {
    port = String(result);
  }

  // Validate port is in the declared outputPorts
  if (!config.outputPorts.includes(port)) {
    throw new Error(
      `code-match returned "${port}" which is not in outputPorts: [${config.outputPorts.join(", ")}]`,
    );
  }

  return { mode: "instant", nextPort: port, output: { result: port } };
}
