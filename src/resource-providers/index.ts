import {
  type ResourceProvider,
  ResourceProviderError,
  type ResourceProviderSelection,
} from "./types";

/** Load only the selected adapter. Live adapters arrive in later phases. */
export async function createResourceProvider(
  selection: ResourceProviderSelection,
): Promise<ResourceProvider> {
  switch (selection.provider) {
    case "fake": {
      const { createFakeResourceProvider } = await import("./fake");
      return createFakeResourceProvider(selection.kind);
    }
    case "e2b":
    case "browser-use":
      throw new ResourceProviderError(
        "unsupported",
        "This resource provider is not available yet.",
      );
  }
}
