import {
  CredentialBroker,
  DEFAULT_CREDENTIAL_BINDINGS,
  type FailedCredentialBinding,
  patchFetchWithCredentialBroker,
  type ResolvedCredentialBinding,
} from "./credential-broker";

export type EgressSecretEntry = ResolvedCredentialBinding;

export async function buildEgressSecrets(): Promise<EgressSecretEntry[]> {
  const broker = new CredentialBroker(
    { listActiveBindings: () => [] },
    (configKey) => process.env[configKey],
    DEFAULT_CREDENTIAL_BINDINGS,
  );
  return await broker.resolveBindings({});
}

export function patchFetchWithEgressSubstitution(
  secrets: EgressSecretEntry[],
  failedBindings: FailedCredentialBinding[] = [],
): void {
  patchFetchWithCredentialBroker(secrets, failedBindings);
}
