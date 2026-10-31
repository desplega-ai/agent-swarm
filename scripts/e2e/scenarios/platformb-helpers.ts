import { asRecord, expect, expectStatus } from "../http";
import type { McpConnection } from "../mcp";
import type { ScenarioContext } from "../run";

/** What an MCP tool answered, flattened so assertions read the same for every tool. */
export type ToolOutcome = {
  isError: boolean;
  /** The text content blocks, joined. */
  text: string;
  /** `structuredContent.message`, or "" when the tool sent none. */
  message: string;
  /** The whole `structuredContent` record. */
  data: Record<string, unknown>;
};

/**
 * Calls an MCP tool and flattens the result. A call the server rejects before the tool runs
 * (input validation, unknown tool) comes back as an error outcome instead of a throw, so a
 * negative-path assertion reads the same as any other tool failure.
 */
export async function callTool(
  connection: McpConnection,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  let raw: Record<string, unknown>;
  try {
    raw = asRecord(await connection.callTool(name, args));
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { isError: true, text, message: text, data: {} };
  }
  const content = Array.isArray(raw.content) ? raw.content : [];
  const text = content
    .map((item) => {
      const block = asRecord(item);
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .join("\n");
  const data =
    typeof raw.structuredContent === "object" &&
    raw.structuredContent !== null &&
    !Array.isArray(raw.structuredContent)
      ? (raw.structuredContent as Record<string, unknown>)
      : {};
  return {
    isError: raw.isError === true,
    text,
    message: typeof data.message === "string" ? data.message : "",
    data,
  };
}

/** The tool succeeded and both channels agree: `success: true` and the message is in the text. */
export function expectToolOk(outcome: ToolOutcome, label: string): ToolOutcome {
  expect(!outcome.isError, `${label}: tool returned isError: ${outcome.text.slice(0, 300)}`);
  expect(outcome.data.success === true, `${label}: structuredContent.success is not true`);
  expect(outcome.message.length > 0, `${label}: structuredContent.message is empty`);
  expect(outcome.text.includes(outcome.message), `${label}: text content lacks the message`);
  return outcome;
}

/** The tool failed with a message that contains `needle`, on both channels. */
export function expectToolError(outcome: ToolOutcome, needle: string, label: string): ToolOutcome {
  expect(outcome.isError, `${label}: tool did not return isError (${outcome.text.slice(0, 200)})`);
  expect(outcome.data.success === false, `${label}: structuredContent.success is not false`);
  expect(
    outcome.message.includes(needle) && outcome.text.includes(needle),
    `${label}: expected "${needle}", got "${outcome.message}" / "${outcome.text.slice(0, 200)}"`,
  );
  return outcome;
}

export async function registerWorker(ctx: ScenarioContext, name: string): Promise<string> {
  const response = await ctx.api("POST", "/api/agents", {
    body: { name, role: "worker", status: "online" },
  });
  expectStatus(response, [201], `register worker ${name}`);
  return asString(asRecord(response.json).id, `worker ${name} id`);
}

/**
 * Registers a lead for the scenario that needs lead-only behaviour. Pair it with
 * `retireAgent` in a finally block: an offline lead stays out of routing for later scenarios.
 */
export async function registerLead(ctx: ScenarioContext, name: string): Promise<string> {
  const response = await ctx.api("POST", "/api/agents", { body: { name, isLead: true } });
  expectStatus(response, [201], `register lead ${name}`);
  return asString(asRecord(response.json).id, `lead ${name} id`);
}

/** Marks a static agent offline (`POST /close`, 204). Errors are swallowed: this is cleanup. */
export async function retireAgent(ctx: ScenarioContext, agentId: string | undefined) {
  if (!agentId) return;
  await ctx.api("POST", "/close", { agentId, body: {} }).catch(() => undefined);
}

function asString(value: unknown, label: string): string {
  expect(typeof value === "string" && value.length > 0, `${label} is not a non-empty string`);
  return value;
}

/** Runs cleanup steps in order; collects failures and throws them together at the end. */
export class Cleanup {
  private readonly steps: { label: string; action: () => unknown | Promise<unknown> }[] = [];

  add(label: string, action: () => unknown | Promise<unknown>) {
    this.steps.push({ label, action });
  }

  /**
   * Runs `body`, then the cleanup steps. When `body` throws, cleanup still runs and the body's
   * error wins. When `body` passes, a failing cleanup step fails the scenario.
   */
  async around(body: () => Promise<void>) {
    try {
      await body();
    } catch (error) {
      await this.run().catch(() => undefined);
      throw error;
    }
    await this.run();
  }

  /** Runs the steps last-in first-out. A failing step does not stop the rest. */
  async run() {
    const failures: { label: string; error: unknown }[] = [];
    for (const step of this.steps.reverse()) {
      try {
        await step.action();
      } catch (error) {
        failures.push({ label: step.label, error });
      }
    }
    this.steps.length = 0;
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.error),
        `Cleanup failed: ${failures.map((failure) => failure.label).join(", ")}`,
      );
    }
  }
}
