import type { ProviderMetaMap, ProviderName } from "@/types";

export function parseProviderMeta<TProvider extends ProviderName>(
  rawProvider: TProvider | null | undefined,
  rawMeta: string | undefined | null,
): ProviderMetaMap[TProvider] | undefined {
  if (!rawMeta || !rawProvider) return undefined;
  return JSON.parse(rawMeta) as ProviderMetaMap[TProvider];
}
