import type { RequestInfo } from "../tools/utils";
import { type CreateTaskOptions, CreateTaskOptionsSchema } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import type { TaskCreateModify, TaskCreateOrigin } from "./contract";
import { dispatchPre, extensionIdForAgent, listRegistered } from "./dispatcher";

const MODIFIABLE_OPTION_KEYS = [
  "agentId",
  "creatorAgentId",
  "source",
  "taskType",
  "tags",
  "priority",
  "dependsOn",
  "offeredTo",
  "vcsProvider",
  "vcsRepo",
  "vcsEventType",
  "vcsNumber",
  "vcsCommentId",
  "vcsAuthor",
  "vcsUrl",
  "vcsInstallationId",
  "vcsNodeId",
  "agentmailInboxId",
  "agentmailMessageId",
  "agentmailThreadId",
  "mentionMessageId",
  "mentionChannelId",
  "dir",
  "model",
  "modelTier",
  "effort",
  "outputSchema",
  "followUpConfig",
  "bypassTrackerContextDedup",
] as const satisfies readonly Exclude<keyof TaskCreateModify, "description">[];

type AssertNever<T extends never> = T;
type _AllModifiableOptionKeysCovered = AssertNever<
  Exclude<keyof TaskCreateModify, "description" | (typeof MODIFIABLE_OPTION_KEYS)[number]>
>;

const MODIFIABLE_OPTION_KEY_SET = new Set<string>(MODIFIABLE_OPTION_KEYS);

type ApplyPreTaskCreateArgs = {
  description: string;
  options: CreateTaskOptions;
  origin: TaskCreateOrigin;
  requestInfo?: RequestInfo;
};

export type ApplyPreTaskCreateResult =
  | {
      kind: "blocked";
      reason: string;
      extension: { id: string; name: string };
    }
  | { kind: "proceed"; description: string; options: CreateTaskOptions };

function warnDroppedKey(extensionName: string, key: string): void {
  console.warn(
    scrubSecrets(
      `[extensions] pre.task.create ignored disallowed key "${key}" from extension "${extensionName}"`,
    ),
  );
}

export async function applyPreTaskCreate(
  args: ApplyPreTaskCreateArgs,
): Promise<ApplyPreTaskCreateResult> {
  const creatingExtensionId = extensionIdForAgent(args.requestInfo?.agentId);
  const creatingExtension = creatingExtensionId
    ? listRegistered().find((loaded) => loaded.record.id === creatingExtensionId)
    : undefined;
  const origin = creatingExtension
    ? (`extension:${creatingExtension.record.name}` as const)
    : args.origin;

  const result = await dispatchPre(
    "pre.task.create",
    {
      description: args.description,
      options: args.options,
      origin,
      requestInfo: args.requestInfo,
    },
    {
      skipExtensionId: creatingExtensionId,
      transformModify: ({ data, currentPayload, extension }) => {
        const currentOptions = (currentPayload.options ?? {}) as CreateTaskOptions;
        const filtered: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(data)) {
          if (key === "description") {
            if (typeof value !== "string" || value.trim().length === 0) {
              throw new Error("Extension task description must be a non-empty string");
            }
            filtered.description = value;
            continue;
          }
          if (
            !MODIFIABLE_OPTION_KEY_SET.has(key) ||
            (key === "dir" && currentOptions.parentTaskId)
          ) {
            warnDroppedKey(extension.name, key);
            continue;
          }
          filtered[key] = value;
        }

        const { description: _description, ...optionChanges } = filtered;
        CreateTaskOptionsSchema.parse({ ...currentOptions, ...optionChanges });
        return filtered;
      },
    },
  );

  if (result.action === "block") {
    return {
      kind: "blocked",
      reason: result.reason,
      extension: result.extension,
    };
  }
  if (result.action === "continue") {
    return { kind: "proceed", description: args.description, options: args.options };
  }

  const { description, ...optionChanges } = result.data;
  return {
    kind: "proceed",
    description: description ?? args.description,
    options: CreateTaskOptionsSchema.parse({ ...args.options, ...optionChanges }),
  };
}
