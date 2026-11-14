// Import the fetch patch from its own module, not the `./credential-broker`
// barrel: the barrel loads `types.ts`, and with it zod (about 25 ms), into
// every native harness run, which only needs the patch. The broker is loaded
// on demand by the API-side caller below.
import { patchFetchWithCredentialBroker } from "./credential-broker/fetch-patch";
import type { FailedCredentialBinding, ResolvedCredentialBinding } from "./credential-broker/types";

export type EgressSecretEntry = ResolvedCredentialBinding;

export async function buildEgressSecrets(): Promise<EgressSecretEntry[]> {
  const [{ CredentialBroker }, { defaultCredentialBindings }] = await Promise.all([
    import("./credential-broker/broker"),
    import("./credential-broker/default-bindings"),
  ]);
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
