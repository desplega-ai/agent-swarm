import {
  CredentialBroker,
  defaultCredentialBindings,
  type FailedCredentialBinding,
  patchFetchWithCredentialBroker,
  type ResolvedCredentialBinding,
} from "./credential-broker";

export type EgressSecretEntry = ResolvedCredentialBinding;

export async function buildEgressSecrets(): Promise<EgressSecretEntry[]> {
  const broker = new CredentialBroker(
    { listActiveBindings: async () => [] },
    (configKey) => process.env[configKey],
    defaultCredentialBindings(),
  );
  return await broker.resolveBindings({});
}

export function patchFetchWithEgressSubstitution(
  secrets: EgressSecretEntry[],
  failedBindings: FailedCredentialBinding[] = [],
): void {
  patchFetchWithCredentialBroker(secrets, failedBindings);
}
