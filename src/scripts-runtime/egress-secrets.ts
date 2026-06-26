import {
  CredentialBroker,
  DEFAULT_CREDENTIAL_BINDINGS,
  patchFetchWithCredentialBroker,
  type ResolvedCredentialBinding,
} from "./credential-broker";

export type EgressSecretEntry = ResolvedCredentialBinding;

export function buildEgressSecrets(): EgressSecretEntry[] {
  const broker = new CredentialBroker(
    { listActiveBindings: () => [] },
    (configKey) => process.env[configKey],
    DEFAULT_CREDENTIAL_BINDINGS,
  );
  return broker.resolveBindings({});
}

export function patchFetchWithEgressSubstitution(secrets: EgressSecretEntry[]): void {
  patchFetchWithCredentialBroker(secrets);
}
