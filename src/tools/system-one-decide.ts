import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { getExecutorRegistry } from "@/workflows";
import {
  SYSTEM_ONE_DECISION_NODE_TYPE,
  SystemOneDecisionConfigSchema,
  SystemOneDecisionExecutor,
} from "@/workflows/executors/system-one-decision";
import { SYSTEM_ONE_PROVIDER_IDS } from "@/workflows/executors/system-one-providers";

/**
 * One typed decision (Jev, Clef and the other SystemOne hosts) made in the API
 * process, the same way a `system-one-decision` workflow node makes it. The
 * provider credential is read and sent here and never reaches the caller, so a
 * script can ask for a decision without a credential binding in its own realm.
 */
export const registerSystemOneDecideTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "system-one-decide",
    {
      title: "Ask a SystemOne decision model",
      annotations: { destructiveHint: false, openWorldHint: true },
      description:
        "Send a state and typed questions (noul, choice, score) to a SystemOne decision host such as Jev or Clef, and return the validated answers. " +
        "Same request, provider list, credentials and validation as the `system-one-decision` workflow node, without its human review band. " +
        "The provider credential is a global secret that stays on the server; this tool never returns it.",
      inputSchema: z.object({
        provider: z
          .enum(SYSTEM_ONE_PROVIDER_IDS)
          .optional()
          .describe(
            "Decision host (default: the SYSTEM_ONE_DEFAULT_PROVIDER global config, typesafe when unset)",
          ),
        model: z.string().min(1).optional().describe("Provider model id (default: the provider's)"),
        state: z
          .union([z.string(), z.array(z.string()), z.record(z.string(), z.unknown())])
          .describe("The state to decide on"),
        questions: z
          .record(z.string(), z.record(z.string(), z.unknown()))
          .describe(
            "Questions by id, each `{ type: 'noul' | 'choice' | 'score', instructions, criteria }`",
          ),
        timeoutMs: z
          .number()
          .int()
          .optional()
          .describe("Time budget for the call, retries included (default 30000)"),
        maxRetries: z
          .number()
          .int()
          .optional()
          .describe("Retries on transient failures inside the time budget (default 2)"),
      }),
      outputSchema: swarmToolOutputSchema({
        model: z.string().optional(),
        answers: z.record(z.string(), z.unknown()).optional(),
        usage: z.record(z.string(), z.unknown()).optional(),
        requestId: z.string().optional(),
        providerUnavailable: z
          .boolean()
          .optional()
          .describe(
            "On an error: true when this deployment refuses the provider (e.g. OpenRouter behind a gateway) and no request was sent, so a caller choosing automatically can try its next provider",
          ),
      }),
    },
    async ({ provider, model, state, questions, timeoutMs, maxRetries }, requestInfo) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. The MCP client should define the "X-Agent-ID" header.');
      }

      // `returns` mirrors the questions: the caller reads answers directly, so
      // there is no downstream port to declare.
      const returns = Object.fromEntries(
        Object.entries(questions).map(([id, question]) => [id, { type: question.type }]),
      );
      const parsed = SystemOneDecisionConfigSchema.safeParse({
        provider,
        model,
        state,
        questions,
        returns,
        timeoutMs,
        maxRetries,
      });
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        return toolErr(`Invalid decision request: ${issues}`.slice(0, 1000));
      }

      const executor = getExecutorRegistry().get(SYSTEM_ONE_DECISION_NODE_TYPE);
      if (!(executor instanceof SystemOneDecisionExecutor)) {
        return toolErr("The system-one-decision executor is not available");
      }
      const decided = await executor.decide(parsed.data);
      if (!decided.ok) {
        return toolErr(
          decided.error,
          decided.deploymentRefused ? { data: { providerUnavailable: true } } : {},
        );
      }

      const { output } = decided;
      return toolOk(`Decision from ${output.model}`, {
        data: {
          model: output.model,
          answers: output.answers,
          usage: output.usage,
          requestId: output.requestId,
        },
      });
    },
  );
};
