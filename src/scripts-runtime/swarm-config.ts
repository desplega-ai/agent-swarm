import type { SwarmConfigPayload } from "./executors/types";
import { Redacted, type Redacted as RedactedValue } from "./redacted";

export class SwarmConfig {
  readonly apiKey: RedactedValue<string>;
  readonly agentId: RedactedValue<string>;
  readonly mcpBaseUrl: RedactedValue<string>;

  /**
   * When true, the SDK proxy rejects every method that is not on
   * `SDK_READ_ONLY_METHODS`. Set for routing dry runs so probing a handler
   * cannot create tasks, mutate config, or message anyone.
   */
  readonly readOnly: boolean;

  private readonly userValues: Map<string, RedactedValue<string>>;

  constructor(payload: SwarmConfigPayload) {
    this.readOnly = payload.system.readOnly === true;
    this.apiKey = Redacted.make(payload.system.apiKey.value, {
      type: "system",
      isSecret: payload.system.apiKey.isSecret,
    });
    this.agentId = Redacted.make(payload.system.agentId.value, {
      type: "system",
      isSecret: payload.system.agentId.isSecret,
    });
    this.mcpBaseUrl = Redacted.make(payload.system.mcpBaseUrl.value, {
      type: "system",
      isSecret: payload.system.mcpBaseUrl.isSecret,
    });
    this.userValues = new Map(
      Object.entries(payload.user ?? {}).map(([key, value]) => [
        key,
        Redacted.make(value.value, { type: "user", isSecret: value.isSecret }),
      ]),
    );
  }

  get<T = string>(key: string): RedactedValue<T> | undefined {
    return this.userValues.get(key) as RedactedValue<T> | undefined;
  }
}
